"""Choose useful graphics and append checked diagrams without issuing new quizzes."""

import json

from background_jobs import JobError
from generation_contracts import _json_block
from prompts import SCENE_SUPPLEMENT
from scene_contracts import MAX_NOTES, SceneContractError, scenes_in
import quiz_harness as harness


class SceneService:
    def __init__(self, repository, model, verification, authorize):
        self.repository = repository
        self.model = model
        self.verification = verification
        self.authorize = authorize

    def _addition(self, source, node, *, requested):
        payload = {"node": {name: node.get(name) for name in ("title", "essence", "objectives")},
                   "study_notes": source[:20000], "requested": requested}
        for attempt in range(2):
            messages = [{"role": "system", "content": SCENE_SUPPLEMENT},
                        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]
            if attempt:
                messages.append({"role": "user", "content": "上次图示未通过配置或显示检查。请简化图形并严格遵守字段约束，再输出JSON。"})
            result = _json_block(self.model.nonempty(
                messages, max_tokens=self.model.settings.max_output_tokens, temperature=0.3))
            try:
                if (not isinstance(result, dict) or set(result) != {"needed", "reason", "markdown"}
                        or type(result["needed"]) is not bool
                        or not isinstance(result["reason"], str) or not result["reason"].strip()
                        or len(result["reason"]) > 200 or not isinstance(result["markdown"], str)):
                    raise SceneContractError("图示回复格式无效")
                addition = result["markdown"].strip()
                if not result["needed"]:
                    if addition:
                        raise SceneContractError("无图示时不应返回正文")
                    return "", result["reason"]
                if len(addition) > 14000 or len(scenes_in(addition)) != 1:
                    raise SceneContractError("补充段落必须包含一个有效图示")
                review = self.verification.review_rendered({"study_notes": addition})
                if review.get("status") != "passed":
                    raise JobError(503, "图示渲染检查暂不可用，原正文已保留，请稍后重试")
                return addition, result["reason"]
            except (SceneContractError, harness.QuizContractError):
                continue
        raise JobError(502, "图示生成未通过检查，原正文已保留，请重试")

    def enrich_candidate(self, candidate, node):
        """A separate graphic decision covers any subject; no keyword/course gate."""
        source = candidate.get("study_notes") or ""
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
        try:
            present = scenes_in(source)
        except SceneContractError as error:
            raise JobError(409, "原正文包含无效图示，请先修正正文") from error
        if present:
            return 200, {"node_id": node_id, "study_notes": source, "source_notes": source, "reused": True,
                         "sceneSupplement": detail.get("sceneSupplement")}
        addition, reason = self._addition(source, node, requested=True)
        if not addition:
            return 200, {"node_id": node_id, "study_notes": source, "reused": True,
                         "needed": False, "reason": reason}
        notes = source.rstrip() + "\n\n" + addition
        if len(notes) > MAX_NOTES:
            raise JobError(400, "补充图示超出正文长度限制，原正文已保留")
        validate = lambda: self.authorize(actor, key)
        result = self.repository.append_scene(key, node_id, source, notes, validate)
        return 200, result
