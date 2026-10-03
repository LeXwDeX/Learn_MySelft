"""QuizService operations return data and never access an HTTP handler."""

import json
import time
import material_parser
import flywheel
import quiz_harness as harness
from material_titles import document_title
from service_limits import GEN_WAIT_MAX
from text_utils import clip
from prompts import _path_system
from generation_contracts import (
    _json_block,
    _str_list,
    _norm_quiz_questions,
    _quizmap_title,
    _norm_quizmap,
    _issued_quiz,
    _split_ukey,
)


class QuizService:
    def __init__(self, repository, model, cache, verification):
        self.repository = repository
        self.model = model
        self.cache = cache
        self.verification = verification

    def requiz(self, path, body, actor):
        self.repository.store.job_progress(1, "准备请求和历史题目")
        node = body.get("node") or {}
        key = clip(body.get("key"), 200)
        node_id = clip(node.get("id"), 20)
        if not key or not node_id:
            return (400, {"error": "key and node.id required"})
        snapshot = self.repository.quiz_snapshot(key, node_id)
        expected = body.get("round_id") or snapshot["round_id"]
        if expected != snapshot["round_id"]:
            return (200, snapshot)
        gate_key = key + "#requiz#" + node_id + "#" + expected
        gate, owner = self.cache.join(gate_key)
        if not owner:
            gate["ev"].wait(GEN_WAIT_MAX)
            if gate["out"] is not None:
                return (200, gate["out"])
            else:
                return (502, {"error": gate["err"] or "出题中，请稍后重试"})
            return
        try:
            previous = [q for r in snapshot["rounds"] for q in r["questions"]]
            previous += snapshot.get("used") or []
            material = self.repository.material(key) or {}
            payload = {
                "节点": node,
                "需求单": material.get("spec"),
                "上次批改": (material.get("nodeState") or {}).get(node_id),
                "已出过的题目": [q["q"] for q in previous],
            }
            questions, last_error = (None, "")
            for attempt in range(3):
                try:
                    self.repository.store.job_progress(2, "模型生成新题", attempt + 1)
                    generated = self.model.nonempty(
                        [
                            {"role": "system", "content": _path_system("requiz")},
                            {
                                "role": "user",
                                "content": json.dumps(payload, ensure_ascii=False)
                                + "\n校验反馈："
                                + last_error,
                            },
                        ],
                        max_tokens=self.model.settings.max_output_tokens,
                        temperature=0.6,
                    )
                    self.repository.store.job_progress(
                        3, "校验题目、评分标准与页面显示", attempt + 1
                    )
                    candidate = _norm_quiz_questions(_json_block(generated))
                    if not candidate:
                        raise harness.QuizContractError("题目不完整")
                    checked = self.verification.checked_questions(
                        candidate["questions"], previous, node=True
                    )
                    review = self.verification.review_rendered(candidate)
                    questions = checked
                    break
                except harness.QuizContractError as error:
                    last_error = str(error)
            if questions is None:
                raise harness.QuizContractError("换题验证失败：" + last_error)

            def append(quiz, material):
                if quiz["round_id"] == expected:
                    harness.add_round(quiz, questions)
                    quiz["render_review"] = review
                    state = material.setdefault("nodeState", {}).setdefault(node_id, {})
                    for field in ("score", "lastResult", "lastAnswers"):
                        state.pop(field, None)
                return json.loads(json.dumps(quiz))

            self.repository.store.job_progress(4, "保存新题并保留历史作答", attempt + 1)
            result = self.repository.quiz_update(key, node_id, append)
            self.cache.finish(gate_key, gate, out=result)
            return (200, result)
        except Exception:
            self.cache.finish(gate_key, gate, err="换题或验题失败，旧题已保留")
            raise
        return

    def quizmap(self, path, body, actor):
        material = (
            self.repository.material(body.get("key")) if body.get("key") else None
        )
        references = (material or {}).get("materials") or []
        if path == "/path/quizmap":
            references = references + ((material or {}).get("quizMaterials") or [])
        reference_context = material_parser.context(references)
        key = clip(str(body.get("key") or ""), 200)
        _u, _rest = _split_ukey(key)
        if not (_rest.startswith("learn-path-v1-") and (not _rest.endswith("-last"))):
            return (400, {"error": "key must be a learn-path-v1 material key"})
        gate_key = "quizmap:" + key
        _gate, _owner = self.cache.join(gate_key)
        if not _owner:
            _gate["ev"].wait(GEN_WAIT_MAX)
            hit = _gate["out"]
            if hit is not None:
                return (200, hit)
            return (502, {"error": _gate["err"] or "测验地图仍在生成中，请稍后重试"})
        m = self.repository.material(key)
        if not m:
            self.cache.finish(gate_key, _gate, err="material not found")
            return (404, {"error": "material not found"})
        plan = m.get("plan") if isinstance(m.get("plan"), dict) else None
        if not plan or not isinstance(plan.get("nodes"), list) or (not plan["nodes"]):
            self.cache.finish(gate_key, _gate, err="plan required")
            return (422, {"error": "plan required"})
        detail = m.get("nodeDetail") if isinstance(m.get("nodeDetail"), dict) else {}
        nstate = m.get("nodeState") if isinstance(m.get("nodeState"), dict) else {}
        map_title = document_title(m)
        out_nodes = []
        for n in plan["nodes"]:
            if not isinstance(n, dict):
                continue
            nid = clip(n.get("id"), 20)
            if not nid:
                continue
            st = nstate.get(nid) if isinstance(nstate.get(nid), dict) else {}
            done = bool(st.get("completed"))
            score = (
                st.get("score") if isinstance(st.get("score"), (int, float)) else None
            )
            item = {
                "id": nid,
                "标题": clip(n.get("title"), 120),
                "本质": clip(n.get("essence"), 200),
                "目标": _str_list(n.get("objectives"), 3, 160),
                "依赖": _str_list(n.get("deps"), 6, 20),
                "情况": {
                    "已完成": done,
                    "掌握标记": st.get("mark", "none"),
                    "得分": int(score) if isinstance(score, (int, float)) else None,
                },
            }
            d = detail.get(nid) if isinstance(detail.get(nid), dict) else {}
            kp = _str_list(d.get("key_points"), 3, 200)
            if kp:
                item["要点"] = kp
            lr = st.get("lastResult") if isinstance(st.get("lastResult"), dict) else {}
            per = (
                lr.get("per_question")
                if isinstance(lr.get("per_question"), list)
                else []
            )
            item["最近自测"] = (
                {
                    "得分": int(score) if isinstance(score, (int, float)) else None,
                    "逐题": [
                        {
                            "i": i + 1,
                            "正确": bool(x.get("ok")),
                            "点评": clip(x.get("comment"), 300),
                        }
                        for i, x in enumerate(per[:12])
                        if isinstance(x, dict)
                    ],
                }
                if score is not None
                else None
            )
            la = st.get("lastAnswers")
            if isinstance(la, list):
                excerpts = {}
                for i, a in enumerate(la[:12]):
                    s = clip(
                        "；".join(
                            (
                                "第%d空：%s" % (j + 1, value or "未作答")
                                for j, value in enumerate(a)
                            )
                        )
                        if isinstance(a, list)
                        else str(a),
                        500,
                    )
                    if s.strip():
                        excerpts[str(i + 1)] = s
                if excerpts:
                    item["作答摘录"] = excerpts
            mistakes = []
            for issued in (d.get("quiz") or {}).get("rounds", []):
                for attempt in issued.get("attempts", []):
                    result = attempt.get("result") or attempt
                    for index, grade in enumerate(result.get("per_question") or []):
                        if grade.get("ok") is False and index < len(
                            issued["questions"]
                        ):
                            mistakes.append(
                                {
                                    "题目": issued["questions"][index]["q"],
                                    "点评": grade.get("comment", ""),
                                    "得分": grade.get("earned"),
                                    "满分": grade.get("max_points"),
                                }
                            )
            if mistakes:
                item["历史错题"] = mistakes[-12:]
            out_nodes.append(item)
        if not out_nodes:
            self.cache.finish(gate_key, _gate, err="plan required")
            return (422, {"error": "plan required"})
        done_set = set((n["id"] for n in out_nodes if n["情况"]["已完成"]))
        done_n = len(done_set)
        score_parts, weak, node_notes = ([], [], [])
        for n in out_nodes:
            sc = n["情况"]["得分"]
            if sc is not None:
                score_parts.append("%s=%d" % (n["id"], sc))
            unlocked = all((dep in done_set for dep in n["依赖"]))
            if (
                n["情况"].get("掌握标记") == "review"
                or (isinstance(sc, (int, float)) and sc < 80)
                or (not n["情况"]["已完成"] and unlocked)
            ):
                weak.append(n["id"])
            qm_info = n.get("最近自测") or {}
            wrong_n = sum((1 for x in qm_info.get("逐题") or [] if not x.get("正确")))
            if sc is None:
                node_notes.append("%s 未测" % n["id"])
            else:
                node_notes.append("%s 已测 %d分 错%d题" % (n["id"], sc, wrong_n))
        learner = (
            "共 %d 个节点；已完成 %d；自测得分：%s；薄弱（<80 或未完成且已解锁）：%s；逐节点：%s"
            % (
                len(out_nodes),
                done_n,
                "、".join(score_parts) or "（暂无）",
                "、".join(weak) or "（无）",
                "；".join(node_notes),
            )
        )
        payload = {
            "学习地图": {
                "title": map_title,
                "summary": clip(plan.get("summary"), 300),
                "nodes": out_nodes,
            },
            "学习者概况": learner,
        }
        previous = []
        for raw in self.repository.all(actor["id"]).values():
            try:
                old = json.loads(raw) if isinstance(raw, str) else None
            except ValueError:
                old = None
            if isinstance(old, dict) and old.get("sourceKey") == key:
                previous.extend(old.get("questions") or [])
        payload["已出过的题目"] = [q["q"] for q in previous]
        payload["综合测验表现"] = flywheel.exam_evidence(
            self.repository.all(actor["id"]), key, plan
        )

        def _mk_quizmap(extra=""):
            return [
                {"role": "system", "content": _path_system("quizmap")},
                {
                    "role": "user",
                    "content": json.dumps(payload, ensure_ascii=False)
                    + "\n请输出测验地图 JSON。"
                    + extra
                    + reference_context,
                },
            ]

        qm, last_error = (None, "")
        try:
            for attempt in range(3):
                try:
                    candidate = _norm_quizmap(
                        _json_block(
                            self.model.nonempty(
                                _mk_quizmap(" 校验反馈：" + last_error),
                                max_tokens=self.model.settings.max_output_tokens,
                                temperature=0.5,
                            )
                        ),
                        map_title,
                    )
                    if not candidate or len(candidate["questions"]) < 8:
                        raise harness.QuizContractError("综合测验至少8题")
                    for question in candidate["questions"]:
                        question["node_id"] = flywheel.node_id(
                            question.get("point"), plan
                        )
                        if not question["node_id"]:
                            raise harness.QuizContractError(
                                "每道综合题必须关联现有单元，point使用L编号与标题"
                            )
                    self.verification.checked_questions(
                        candidate["questions"], previous
                    )
                    candidate["render_review"] = self.verification.review_rendered(
                        candidate
                    )
                    candidate["title"] = _quizmap_title(m)
                    qm = candidate
                    break
                except harness.QuizContractError as error:
                    last_error = str(error)
            if qm is None:
                raise harness.QuizContractError("综合测验验证失败：" + last_error)
        except Exception:
            self.cache.finish(gate_key, _gate, err="quizmap verification failed")
            raise
        try:
            with self.repository.lock, self.repository.store.transaction():
                if self.repository.material(key) is None:
                    raise ValueError("源学习地图已删除，未创建测验")
                _u, _rest = _split_ukey(key)
                src_slug = _rest[len("learn-path-v1-") :]
                base_slug = src_slug + "-测验"
                slug = base_slug
                i = 1
                while (
                    self.repository.store.record(_u + "quiz-map-v1-" + slug) is not None
                ):
                    i += 1
                    slug = base_slug + str(i)
                store = {
                    "kind": "quiz-map",
                    "sourceKey": key,
                    "sourceSlug": src_slug,
                    "title": qm["title"],
                    "created": int(time.time()),
                    "attempts": [],
                    "materials": references,
                    "render_review": qm.get("render_review"),
                    **_issued_quiz(qm["questions"]),
                }
                self.repository.put_entries(
                    {_u + "quiz-map-v1-" + slug: json.dumps(store, ensure_ascii=False)},
                    trusted=True,
                )
                self.repository.store.record_job_effect(
                    {
                        "ok": True,
                        "slug": slug,
                        "title": qm["title"],
                        "count": len(qm["questions"]),
                    }
                )
        except Exception:
            self.cache.finish(gate_key, _gate, err="quizmap save failed")
            raise
        out = {
            "ok": True,
            "slug": slug,
            "title": qm["title"],
            "count": len(qm["questions"]),
        }
        self.cache.put(gate_key, out)
        self.cache.finish(gate_key, _gate, out=out)
        return (200, out)

    def quiz_state_or_draft(self, path, body, actor):
        key = clip(body.get("key"), 200)
        node_id = clip((body.get("node") or {}).get("id"), 20)
        if not key:
            return (400, {"error": "key required"})
        if path == "/path/quiz/state":
            return (
                200,
                self.repository.quiz_snapshot(
                    key, node_id, read_only=not key.startswith(actor["id"] + "/")
                ),
            )
        answers = body.get("answers")
        sequence = body.get("sequence")
        if type(sequence) is not int or sequence < 0:
            return (400, {"error": "invalid draft sequence"})
        client = clip(body.get("client_id"), 100)
        if not client or not body.get("round_id"):
            return (400, {"error": "client_id and round_id required"})

        def save_draft(quiz, material):
            issued = harness.active_round(quiz, body.get("round_id"))
            harness.validate_answers(issued["questions"], answers)
            old = issued.get("draft") or {}
            if old.get("client_id") != client or old.get("sequence", -1) <= sequence:
                issued["draft"] = {
                    "answers": answers,
                    "updated": int(time.time() * 1000),
                    "client_id": client,
                    "sequence": sequence,
                }
            return {"ok": True, "round_id": issued["id"], "draft": issued["draft"]}

        return (200, self.repository.quiz_update(key, node_id, save_draft))

    def quiz(self, path, body, actor):
        key = clip(body.get("key"), 200)
        node_id = clip((body.get("node") or {}).get("id"), 20)
        if not key:
            return (400, {"error": "key required; questions must be server-issued"})
        quiz = self.repository.quiz_snapshot(key, node_id)
        round_data = harness.active_round(quiz, body.get("round_id"))
        answers = body.get("answers")
        harness.validate_answers(round_data["questions"], answers)
        if not round_data.get("verified"):
            self.verification.checked_questions(round_data["questions"], legacy=True)

            def verify_legacy(current, material):
                issued = harness.active_round(current, round_data["id"])
                issued["verified"] = True
                return json.loads(json.dumps(current))

            quiz = self.repository.quiz_update(key, node_id, verify_legacy)
            round_data = harness.active_round(quiz, round_data["id"])
        identity = harness.attempt_id(round_data["id"], answers)
        cached = next(
            (a for a in round_data["attempts"] if a.get("id") == identity), None
        )
        result = cached["result"] if cached else None
        if result is None:
            for attempt in range(2):
                try:
                    result = harness.grade(
                        round_data["questions"],
                        answers,
                        self.verification.judge_criteria,
                    )
                    break
                except harness.QuizContractError:
                    if attempt:
                        raise
        result["round_id"] = round_data["id"]

        def record(current, material):
            issued = harness.active_round(current, round_data["id"])
            existing = next(
                (a for a in issued["attempts"] if a.get("id") == identity), None
            )
            saved_result = existing["result"] if existing else result
            if (issued.get("draft") or {}).get("answers") == answers:
                issued.pop("draft", None)
            if not existing:
                issued["attempts"].append(
                    {
                        "id": identity,
                        "ts": int(time.time()),
                        "answers": answers,
                        "result": result,
                    }
                )
            if not node_id and (not existing):
                material.setdefault("attempts", []).append(
                    {
                        "id": identity,
                        "ts": int(time.time()),
                        "score": result["score"],
                        "pass": result["pass"],
                        "per_question": result["per_question"],
                        "answers": answers,
                        "result": result,
                    }
                )
            if current["round_id"] == issued["id"]:
                target = (
                    material.setdefault("nodeState", {}).setdefault(node_id, {})
                    if node_id
                    else material
                )
                target.update(
                    score=saved_result["score"],
                    lastResult=saved_result,
                    lastAnswers=answers,
                )
                current["lastAttemptId"] = identity
                if not node_id and current.get("diagnosis") != {
                    "round_id": issued["id"],
                    "attempt_id": identity,
                }:
                    for field in ("gaps", "gapsAt", "diagnosis"):
                        current.pop(field, None)
            return {
                **saved_result,
                "attempt_id": identity,
                "quiz": json.loads(json.dumps(current)),
                "round_id": issued["id"],
            }

        return (200, self.repository.quiz_update(key, node_id, record))
