"""LearningService operations return data and never access an HTTP handler."""

import json
import re
import material_parser
import quiz_harness as harness
from background_jobs import JobError, log_job_failure
from material_titles import document_title, short_title
from research_sources import collect_sources, select_sources
from service_limits import MAX_TOPIC, MAX_QUESTION, PATH_MAX_ROUNDS, GEN_WAIT_MAX
from text_utils import clip, history_messages
from prompts import _path_system
from scene_contracts import SceneContractError
from generation_contracts import (
    _json_block,
    _json_list,
    _str_list,
    _norm_spec,
    _norm_plan,
    _norm_node_detail,
    _issued_quiz,
)


class LearningService:
    def __init__(self, repository, model, cache, verification, *, scenes=None):
        self.repository = repository
        self.model = model
        self.cache = cache
        self.verification = verification
        self.scenes = scenes

    def log_node_failure(self, error, stage):
        """Preserve the original failure location before contract retries replace it."""
        try:
            job_id = getattr(self.repository.store.local, "job_id", None)
            log_job_failure(job_id, "/path/node", error, stage)
        except Exception:
            pass

    def intake(self, path, body, actor):
        material = (
            self.repository.material(body.get("key")) if body.get("key") else None
        )
        references = (material or {}).get("materials") or []
        reference_context = material_parser.context(references)
        topic = clip(body.get("topic"), MAX_TOPIC)
        history = body.get("history") or []
        rounds = sum(
            (
                1
                for m in history
                if isinstance(m, dict) and m.get("role") == "user" and m.get("content")
            )
        )
        msgs = [{"role": "system", "content": _path_system("intake")}]
        msgs += history_messages(history, budget_chars=60000)
        tail = "学习主题：%s。请开始。" % topic if topic else "请开始。"
        if rounds >= PATH_MAX_ROUNDS:
            tail += " 用户已回答满 %d 轮，本轮必须输出 SPEC。" % PATH_MAX_ROUNDS
        msgs.append({"role": "user", "content": tail + reference_context})
        text = self.model.nonempty(
            msgs, max_tokens=self.model.settings.max_output_tokens, temperature=0.4
        )
        title_match = re.search("^\\s*TITLE\\s*[:：]\\s*([^\\r\\n]+)", text or "", re.M)
        task_title = short_title(title_match.group(1)) if title_match else ""
        if title_match:
            text = text[: title_match.start()] + text[title_match.end() :]
        if task_title:
            self.repository.merge(body.get("key"), {"title": task_title})
        else:
            task_title = document_title(self.repository.material(body.get("key")))
        spec = None
        m = re.search("SPEC\\s*[:：]\\s*", text or "")
        if m:
            spec = _json_block(text[m.end() :])
        if spec is None:
            spec = _json_block(text)
        if spec is not None:
            if task_title == "学习资料":
                task_title = (
                    short_title(_norm_spec(spec, topic).get("topic")) or task_title
                )
                self.repository.merge(body.get("key"), {"title": task_title})
            return (
                200,
                {
                    "done": True,
                    "question": "",
                    "spec": _norm_spec(spec, topic),
                    "title": task_title,
                    "task_title": task_title,
                },
            )
        qm = re.search("ASK\\s*[:：]\\s*(.+)", text or "", re.S)
        question = clip(qm.group(1) if qm else text or "", MAX_QUESTION)
        if not question:
            question = "请告诉我你想学什么，以及你的学习目标。"
        return (
            200,
            {
                "done": False,
                "question": question,
                "spec": None,
                "title": task_title,
                "task_title": task_title,
            },
        )

    def research(self, path, body, actor):
        material = (
            self.repository.material(body.get("key")) if body.get("key") else None
        )
        references = (material or {}).get("materials") or []
        reference_context = material_parser.context(references)
        spec = _norm_spec(body.get("spec"))
        mkey = clip(str(body.get("key") or ""), 200)
        gate_key = mkey + "#research" if mkey else None
        if gate_key:
            hit = self.repository.stage_result(mkey, "research") or self.cache.get(
                gate_key
            )
            if hit is not None:
                return (200, hit)
            _gate, _owner = self.cache.join(gate_key)
            if not _owner:
                _gate["ev"].wait(GEN_WAIT_MAX)
                hit = (
                    _gate["out"]
                    or self.cache.get(gate_key)
                    or self.repository.stage_result(mkey, "research")
                )
                if hit is not None:
                    return (200, hit)
                return (502, {"error": _gate["err"] or "研究仍在进行中，请稍后重试"})
        try:
            qtext = self.model.nonempty(
                [
                    {"role": "system", "content": _path_system("research_queries")},
                    {
                        "role": "user",
                        "content": "需求单：\n"
                        + json.dumps(spec, ensure_ascii=False)
                        + reference_context,
                    },
                ],
                max_tokens=self.model.settings.max_output_tokens,
                temperature=0.5,
            )
            arr = _json_list(qtext)
            if arr is None:
                d = _json_block(qtext)
                if isinstance(d, dict):
                    arr = d.get("queries") or d.get("search_queries")
            if not isinstance(arr, list) or not arr:
                arr = [spec.get("topic") or ""]
            queries = [clip(str(q), 200) for q in arr if str(q).strip()][:5]
            if not queries:
                queries = [spec.get("topic") or "学习路径"]
            candidates = collect_sources(queries, self.model.search)
            sources = select_sources(spec, candidates, self.model.nonempty)
            src_txt = (
                "\n".join(
                    (
                        "[%d] %s | %s | %s"
                        % (i + 1, s["title"], s["url"], s["snippet"])
                        for i, s in enumerate(sources)
                    )
                )
                or "（无检索结果）"
            )
            brief = self.model.nonempty(
                [
                    {"role": "system", "content": _path_system("research_brief")},
                    {
                        "role": "user",
                        "content": "需求单：\n%s\n\n检索结果：\n%s"
                        % (json.dumps(spec, ensure_ascii=False), clip(src_txt, 12000))
                        + reference_context,
                    },
                ],
                max_tokens=self.model.settings.max_output_tokens,
                temperature=0.5,
            )
        except Exception:
            if gate_key:
                self.cache.finish(gate_key, _gate, err="research failed")
            raise
        out = {
            "queries": queries,
            "sources": sources,
            "brief": clip(brief, 2000),
            "research_version": 2,
        }
        self.repository.merge(mkey, out)
        if gate_key:
            self.cache.put(gate_key, out)
            self.cache.finish(gate_key, _gate, out=out)
        return (200, out)

    def plan(self, path, body, actor):
        material = (
            self.repository.material(body.get("key")) if body.get("key") else None
        )
        references = (material or {}).get("materials") or []
        reference_context = material_parser.context(references)
        spec = _norm_spec(body.get("spec"))
        brief = clip(body.get("brief"), 2000)
        mkey = clip(str(body.get("key") or ""), 200)
        gate_key = mkey + "#plan" if mkey else None
        if gate_key:
            hit = self.repository.stage_result(mkey, "plan") or self.cache.get(gate_key)
            if hit is not None:
                return (200, hit)
            _gate, _owner = self.cache.join(gate_key)
            if not _owner:
                _gate["ev"].wait(GEN_WAIT_MAX)
                hit = (
                    _gate["out"]
                    or self.cache.get(gate_key)
                    or self.repository.stage_result(mkey, "plan")
                )
                if hit is not None:
                    return (200, hit)
                return (
                    502,
                    {"error": _gate["err"] or "路径生成仍在进行中，请稍后重试"},
                )

        def _mk(extra=""):
            return [
                {"role": "system", "content": _path_system("plan")},
                {
                    "role": "user",
                    "content": "需求单：\n%s\n\n研究简报：\n%s\n\n请输出 8~12 个节点的学习路径 JSON。%s"
                    % (json.dumps(spec, ensure_ascii=False), brief, extra)
                    + reference_context,
                },
            ]

        try:
            plan = _norm_plan(
                _json_block(
                    self.model.json(
                        _mk(),
                        max_tokens=self.model.settings.max_output_tokens,
                        temperature=0.5,
                    )
                ),
                spec,
            )
            if plan is None or len(plan["nodes"]) < 6:
                plan = _norm_plan(
                    _json_block(
                        self.model.json(
                            _mk(
                                "注意：必须至少 6 个节点，id 从 n1 连续，deps 只引用编号更小的 id。"
                            ),
                            max_tokens=self.model.settings.max_output_tokens,
                            temperature=0.3,
                        )
                    ),
                    spec,
                )
        except Exception:
            if gate_key:
                self.cache.finish(gate_key, _gate, err="plan generation failed")
            raise
        if plan is None or len(plan["nodes"]) < 6:
            if gate_key:
                self.cache.finish(gate_key, _gate, err="plan generation failed")
            return (
                502,
                {"error": "plan generation failed: need >=6 valid nodes", "plan": plan},
            )
        self.repository.merge(mkey, {"plan": plan, "stage": "learning"})
        if gate_key:
            self.cache.put(gate_key, plan)
            self.cache.finish(gate_key, _gate, out=plan)
        return (200, plan)

    def node(self, path, body, actor, *, cancelled=lambda: False):
        def check_cancelled():
            if cancelled():
                raise JobError(409, '资料生成已取消，结果未保存')
        check_cancelled()
        material = (
            self.repository.material(body.get("key")) if body.get("key") else None
        )
        references = (material or {}).get("materials") or []
        reference_context = material_parser.context(references)
        spec = _norm_spec(body.get("spec"))
        node = body.get("node") or {}
        mkey = clip(str(body.get("key") or ""), 200)
        node_id = clip(node.get("id"), 20)
        expected_node = expected_notes = None
        if mkey:
            with self.repository.lock:
                if self.scenes:
                    self.scenes.authorize(actor,mkey)
                material = self.repository.material(mkey)
                canonical = next((item for item in ((material or {}).get('plan') or {}).get('nodes',[])
                                  if isinstance(item,dict) and item.get('id') == node_id),None)
                if material is None or canonical is None:
                    raise JobError(404, '学习资料或节点已删除，结果未保存')
                node = json.loads(json.dumps(canonical,ensure_ascii=False))
                expected_node = json.dumps(node,sort_keys=True,ensure_ascii=False)
                expected_notes = ((material.get('nodeDetail') or {}).get(node_id) or {}).get('study_notes') or ''
        gate_key = mkey + "#node#" + node_id if mkey and node_id else None
        if gate_key:
            hit = self.repository.node_detail(mkey, node_id) or self.cache.get(gate_key)
            if hit is not None:
                return (200, hit)
            _gate, _owner = self.cache.join(gate_key)
            if not _owner:
                _gate["ev"].wait(GEN_WAIT_MAX)
                check_cancelled()
                hit = (
                    _gate["out"]
                    or self.cache.get(gate_key)
                    or self.repository.node_detail(mkey, node_id)
                )
                if hit is not None:
                    return (200, hit)
                return (502, {"error": _gate["err"] or "生成仍在进行中，请稍后重试"})
        payload = {
            "需求单": spec,
            "前置节点": _str_list(body.get("dep_titles"), 6, 120),
            "本节点": {
                "id": clip(node.get("id"), 20),
                "title": clip(node.get("title"), 120),
                "essence": clip(node.get("essence"), 200),
                "objectives": _str_list(node.get("objectives"), 3, 160),
            },
        }

        def _mk_node(extra=""):
            return [
                {"role": "system", "content": _path_system("node")},
                {
                    "role": "user",
                    "content": json.dumps(payload, ensure_ascii=False)
                    + "\n请输出该节点的学习材料 JSON；材料中出现的代码请一律用 ``` 围栏代码块完整包裹。"
                    + extra
                    + reference_context,
                },
            ]

        detail = None
        candidate = None
        stage = "generation"
        try:
            last_error = ""
            for attempt in range(3):
                try:
                    check_cancelled()
                    stage = "generation"
                    candidate = _norm_node_detail(
                        _json_block(
                            self.model.nonempty(
                                _mk_node(
                                    " 上次验题失败：" + last_error if last_error else ""
                                ),
                                max_tokens=self.model.settings.max_output_tokens,
                                temperature=0.5,
                            )
                        )
                    )
                    if not candidate:
                        raise harness.QuizContractError("材料不完整")
                    if self.scenes:
                        self.scenes.prepare_candidate(candidate)
                    stage = "verification"
                    qs = self.verification.checked_questions(
                        candidate["quiz"]["questions"], node=True
                    )
                    candidate["render_review"] = self.verification.review_rendered(
                        candidate
                    )
                    if not isinstance(candidate['render_review'],dict) or candidate['render_review'].get('status') not in ('passed','not_needed'):
                        raise JobError(503, '正文渲染检查暂不可用，资料未保存，请稍后重试')
                    candidate["quiz"] = _issued_quiz(qs)
                    check_cancelled()
                    if self.scenes:
                        stage = 'scene_generation'
                        try:
                            self.scenes.enrich_candidate(candidate,node,key=mkey,actor=actor,cancelled=cancelled)
                        except SceneContractError as error:
                            raise harness.QuizContractError('学习图示配置未通过检查，请修正字段与数值') from error
                    check_cancelled()
                    detail = candidate
                    break
                except harness.QuizContractError as error:
                    if self.scenes and self.scenes.manim and candidate:
                        asset = (candidate.get("manim_review") or {}).get("asset_id")
                        if asset:
                            self.scenes.manim.discard(asset)
                    self.log_node_failure(error, stage)
                    last_error = str(error)
            if detail is None:
                raise harness.QuizContractError("出题校验失败：" + last_error)
        except BaseException as error:
            try:
                if self.scenes and self.scenes.manim and candidate:
                    asset = (candidate.get("manim_review") or {}).get("asset_id")
                    if asset:
                        self.scenes.manim.discard(asset)
                self.log_node_failure(error, stage)
            finally:
                if gate_key:
                    self.cache.finish(gate_key, _gate, err="node verification failed")
            raise
        try:
            with self.repository.lock, self.repository.store.transaction():
                check_cancelled()
                if self.scenes:
                    self.scenes.authorize(actor, mkey)
                current = self.repository.material(mkey)
                current_node = next((n for n in ((current or {}).get('plan') or {}).get('nodes',[])
                                     if isinstance(n,dict) and n.get('id') == node_id),None)
                if current is None or current_node is None:
                    raise JobError(404, "学习资料或节点已删除，生成结果未保存")
                current_notes = ((current.get('nodeDetail') or {}).get(node_id) or {}).get('study_notes') or ''
                if (json.dumps(current_node,sort_keys=True,ensure_ascii=False) != expected_node
                        or current_notes != expected_notes):
                    raise JobError(409, '学习正文或节点已更新，生成结果未保存')
                existing = self.repository.node_detail(mkey, node_id)
                if existing:
                    raise JobError(409, '学习资料已由其他请求生成，本次结果未保存')
                else:
                    self.repository.merge(mkey, {"nodeDetail": {node_id: detail}})
        except BaseException:
            try:
                if self.scenes and self.scenes.manim:
                    asset = (detail.get("manim_review") or {}).get("asset_id")
                    if asset:
                        self.scenes.manim.discard(asset)
            finally:
                if gate_key:
                    self.cache.finish(gate_key, _gate, err="node save failed")
            raise
        if gate_key:
            try:
                self.cache.put(gate_key, detail)
            finally:
                self.cache.finish(gate_key, _gate, out=detail)
        return (200, detail)
