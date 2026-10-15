"""Choose useful graphics and append checked diagrams without issuing new quizzes."""

import json

from background_jobs import JobError, NODE_EXECUTION_SECONDS
from job_execution import JobDeadlineExceeded, execution_budget
from generation_contracts import _json_block
from prompts import SCENE_SUPPLEMENT
from scene_contracts import MAX_NOTES, MAX_SOURCE, SceneContractError, scenes_in, validate_scene
from manim_contracts import references_in, strip_generated_scenes
from manim_service import ManimGenerationError
import quiz_harness as harness


class SceneService:
    def __init__(self, repository, model, verification, authorize, *, manim=None):
        self.repository = repository
        self.model = model
        self.verification = verification
        self.authorize = authorize
        self.manim = manim

    def _addition(self, source, node, *, requested):
        payload = {"node": {name: node.get(name) for name in ("title", "essence", "objectives")},
                   "study_notes": source[:20000], "requested": requested}
        envelope_retry = ("上次回复的外层格式无效。只输出一个完整 JSON 对象，"
                          "恰好包含 needed、reason、scene 三个必填字段。"
                          "需要图示时 scene 是图形对象；不需要图示时 scene 是 null。"
                          "不要输出 markdown、独立围栏、第二个对象或对象外的说明。")
        scene_retry = ("上次图形配置或显示检查未通过。请简化图形并遵守 v1 场景字段约束。"
                       "只输出一个含 needed、reason、scene 三字段的完整 JSON 外层对象，"
                       "scene 是图形对象，不要序列化成字符串或输出独立围栏。")
        retry = scene_retry
        for attempt in range(2):
            messages = [{"role": "system", "content": SCENE_SUPPLEMENT},
                        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]
            if attempt:
                messages.append({"role": "user", "content": retry})
            result = _json_block(self.model.nonempty(
                messages, max_tokens=self.model.settings.max_output_tokens, temperature=0.3))
            native = isinstance(result, dict) and set(result) == {"needed", "reason", "scene"}
            legacy = isinstance(result, dict) and set(result) == {"needed", "reason", "markdown"}
            if (not (native or legacy)
                    or type(result["needed"]) is not bool
                    or not isinstance(result["reason"], str) or not result["reason"].strip()
                    or len(result["reason"]) > 200
                    or (legacy and not isinstance(result["markdown"], str))):
                retry = envelope_retry
                continue
            try:
                if not result["needed"]:
                    if (native and result["scene"] is not None) or (legacy and result["markdown"].strip()):
                        retry = envelope_retry
                        continue
                    return "", result["reason"]
                retry = scene_retry
                if native:
                    validate_scene(result["scene"])
                    encoded = json.dumps(result["scene"], ensure_ascii=False, allow_nan=False,
                                         separators=(",", ":"))
                    if len(encoded) > MAX_SOURCE:
                        raise SceneContractError("图示配置过长")
                    addition = "请观察图形，再按步骤操作。\n\n```learn-scene\n" + encoded + "\n```"
                else:
                    addition = result["markdown"].strip()
                if len(addition) > 14000 or len(scenes_in(addition)) != 1:
                    raise SceneContractError("补充段落必须包含一个有效图示")
                review = self.verification.review_rendered({"study_notes": addition})
                if review.get("status") != "passed":
                    raise JobError(503, "图示渲染检查暂不可用，原正文已保留，请稍后重试")
                return addition, result["reason"]
            except (SceneContractError, harness.QuizContractError):
                continue
        raise JobError(502, "图示生成未通过检查，原正文已保留，请重试")

    def prepare_candidate(self, candidate):
        """Remove model-supplied publication claims before lesson verification."""
        candidate.pop('manim_review', None)
        candidate.pop('sceneSupplement', None)
        if self.manim:
            candidate['study_notes'] = strip_generated_scenes(candidate.get('study_notes') or '')
        return candidate

    def enrich_candidate(self, candidate, node, *, key=None, actor=None, cancelled=lambda: False):
        """A separate graphic decision covers any subject; no keyword/course gate."""
        source = candidate.get("study_notes") or ""
        if self.manim:
            self.prepare_candidate(candidate)
            source = strip_generated_scenes(source)
            candidate["study_notes"] = source
            if source:
                try:
                    with execution_budget(NODE_EXECUTION_SECONDS):
                        spec = self.manim.generate(key, node.get("id"), source, node,
                                                   requested=False, actor=actor, cancelled=cancelled)
                except ManimGenerationError as error:
                    if cancelled():
                        raise JobError(409, '动画请求已取消，结果未保存') from error
                    candidate['manim_review'] = dict(status='failed',retryable=True,failure_code=error.failure_code)
                    return candidate
                if spec:
                    notes = source.rstrip() + "\n\n" + self.manim.public_fence(spec)
                    if len(notes) > MAX_NOTES:
                        self.manim.discard(spec['asset_id'])
                        candidate['manim_review'] = dict(status='failed',retryable=True,failure_code='output_too_long')
                        return candidate
                    candidate["study_notes"] = notes
                    candidate["manim_review"] = {"status": "passed", "asset_id": spec["asset_id"]}
            return candidate
        if not source or scenes_in(source):
            return candidate
        addition, _ = self._addition(source, node, requested=False)
        if addition:
            notes = source.rstrip() + "\n\n" + addition
            if len(notes) > MAX_NOTES:
                raise JobError(502, "补充图示超出正文长度限制")
            candidate["study_notes"] = notes
        return candidate

    def supplement(self, path, body, actor):
        key = body.get("key")
        node_id = (body.get("node") or {}).get("id")
        if not isinstance(node_id, str) or not node_id or len(node_id) > 20:
            raise JobError(400, "请指定有效的学习节点")
        material = self.repository.material(key)
        if material is None:
            raise JobError(404, "学习资料已删除或不存在")
        node = next((item for item in (material.get("plan") or {}).get("nodes", [])
                     if isinstance(item, dict) and item.get("id") == node_id), None)
        detail = (material.get("nodeDetail") or {}).get(node_id)
        if not node or not isinstance(detail, dict) or not detail.get("study_notes"):
            raise JobError(404, "学习正文尚未生成")
        source = detail["study_notes"]
        expected_review = json.loads(json.dumps(detail.get("manim_review")))
        automatic = body.get("automatic") is True
        def save_failure(error):
            local = self.repository.store.local
            had_phase = hasattr(local, 'phase')
            failure_phase = getattr(local, 'phase', None)
            try:
                self.repository.fail_scene_review(key, node_id, source, node, expected_review,
                                                  getattr(error, 'failure_code', 'deadline'),
                                                  lambda: self.authorize(actor, key))
            except Exception:
                # A control/storage failure must not replace the original exception.
                pass
            finally:
                # Metadata persistence is cleanup, not the failed business stage.
                if had_phase:
                    local.phase = failure_phase
                elif hasattr(local, 'phase'):
                    del local.phase
        self.authorize(actor, key)
        if automatic and (expected_review or {}).get("status") == "not_needed":
            return 200, {"node_id": node_id, "study_notes": source, "source_notes": source,
                         "reused": True, "needed": False, "manim_review": expected_review}
        if self.manim:
            for existing in references_in(source):
                try:
                    self.manim.asset(actor, key.split("/", 1)[0], existing["asset_id"], "manifest")
                    return 200, {"node_id": node_id, "study_notes": source,
                                 "source_notes": source, "reused": True,
                                 "sceneSupplement": detail.get("sceneSupplement"),
                                 "manim_review": detail.get("manim_review")}
                except JobError:
                    continue
            lesson = strip_generated_scenes(source)
            try:
                spec = self.manim.generate(key, node_id, lesson, node, actor=actor, requested=not automatic)
            except (ManimGenerationError, JobDeadlineExceeded) as error:
                save_failure(error)
                raise
            if spec is None:
                result = self.repository.update_scene_review(
                    key, node_id, source, node, expected_review, {'status': 'not_needed'},
                    lambda: self.authorize(actor, key), effect=True)
                return 200, result
            notes = lesson.rstrip() + "\n\n" + self.manim.public_fence(spec)
            if len(notes) > MAX_NOTES:
                self.manim.discard(spec["asset_id"])
                error = ManimGenerationError(502, "output_too_long")
                save_failure(error)
                raise error
            try:
                result = self.repository.append_scene(key, node_id, source, notes,
                                                      lambda: self.authorize(actor, key),
                                                      manim_review={'status':'passed','asset_id':spec['asset_id']},
                                                      expected_node=node)
            except BaseException:
                self.manim.discard(spec["asset_id"])
                raise
            return 200, result
        try:
            present = scenes_in(source)
        except SceneContractError as error:
            raise JobError(409, "原正文包含无效图示，请先修正正文") from error
        if present:
            return 200, {"node_id": node_id, "study_notes": source, "source_notes": source, "reused": True,
                         "sceneSupplement": detail.get("sceneSupplement")}
        addition, reason = self._addition(source, node, requested=not automatic)
        if not addition:
            return 200, {"node_id": node_id, "study_notes": source, "reused": True,
                         "needed": False, "reason": reason}
        notes = source.rstrip() + "\n\n" + addition
        if len(notes) > MAX_NOTES:
            raise JobError(400, "补充图示超出正文长度限制，原正文已保留")
        validate = lambda: self.authorize(actor, key)
        result = self.repository.append_scene(key, node_id, source, notes, validate)
        return 200, result
