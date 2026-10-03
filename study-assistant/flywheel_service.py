"""FlywheelService operations return data and never access an HTTP handler."""

import hashlib
import json
import time
import path_hierarchy
import flywheel
from background_jobs import JobError
from service_limits import GEN_WAIT_MAX
from text_utils import clip
from prompts import _path_system
from generation_contracts import _json_block, _str_list, _norm_gaps, _norm_refine_units


class FlywheelService:
    def __init__(self, repository, model, cache, verification):
        self.repository = repository
        self.model = model
        self.cache = cache
        self.verification = verification

    def gaps(self, path, body, actor):
        diagnosis_key = body.get("key") or ""
        identity = None
        if diagnosis_key.split("/", 1)[-1].startswith("quiz-map-v1-"):
            identity = {name: body.get(name) for name in ("round_id", "attempt_id")}
            _, saved_quiz = self.repository.saved_attempt(diagnosis_key, identity)
            if saved_quiz.get("diagnosis") == identity and saved_quiz.get("gaps"):
                return (200, {**saved_quiz["gaps"], "diagnosis": identity})
            body = {
                **body,
                "items": flywheel.gap_items(saved_quiz),
                "score": (saved_quiz.get("lastResult") or {}).get("score"),
            }
            if not body["items"]:
                return (
                    200,
                    {
                        "summary": "本次作答没有失分题，无需补习。",
                        "gaps": [],
                        "diagnosis": identity,
                    },
                )
        items = []
        for it in (body.get("items") if isinstance(body.get("items"), list) else [])[
            :24
        ]:
            if not isinstance(it, dict):
                continue
            q = clip(it.get("q"), 800)
            if not q:
                continue
            items.append(
                {
                    "单元": clip(it.get("unit"), 160),
                    "题目": q,
                    "学生作答": clip(str(it.get("mine") or ""), 800),
                    "参考答案": clip(str(it.get("correct") or ""), 800),
                    "解析": clip(it.get("explain"), 600),
                }
            )
        if not items:
            return (400, {"error": "items required"})
        payload = {"得分": clip(str(body.get("score")), 20), "失分题": items}
        try:
            obj = _json_block(
                self.model.nonempty(
                    [
                        {"role": "system", "content": _path_system("gaps")},
                        {
                            "role": "user",
                            "content": json.dumps(payload, ensure_ascii=False)
                            + "\n请输出缺漏清单 JSON。",
                        },
                    ],
                    max_tokens=self.model.settings.max_output_tokens,
                    temperature=0.4,
                )
            )
        except Exception as e:
            return (502, {"error": "%s: %s" % (type(e).__name__, e)})
        res = _norm_gaps(obj)
        if res is None:
            return (502, {"error": "gap analysis failed"})
        if identity:
            with self.repository.lock, self.repository.store.transaction():
                current, _ = self.repository.saved_attempt(diagnosis_key, identity)
                current.update(
                    gaps=res, diagnosis=identity, gapsAt=int(time.time() * 1000)
                )
                self.repository.write_key(
                    diagnosis_key, json.dumps(current, ensure_ascii=False)
                )
            res = {**res, "diagnosis": identity}
        return (200, res)

    def refine(self, path, body, actor):
        key = clip(body.get("key"), 200)
        spec = body.get("spec") if isinstance(body.get("spec"), dict) else {}
        plan = body.get("plan") if isinstance(body.get("plan"), dict) else {}
        if key:
            material = self.repository.material(key)
            if not material or not isinstance(material.get("plan"), dict):
                return (404, {"error": "学习地图已删除或不存在"})
            plan = material["plan"]
            spec = material.get("spec") or spec
        receipt, validate = (None, None)
        if body.get("quiz_key"):
            source_key = body["quiz_key"]
            identity = {name: body.get(name) for name in ("round_id", "attempt_id")}

            def validate():
                source, quiz = self.repository.saved_attempt(source_key, identity)
                if source.get("sourceKey") != key or quiz.get("diagnosis") != identity:
                    raise JobError(409, "请先针对当前作答重新诊断")
                if not flywheel.gap_items(quiz):
                    raise JobError(409, "本次作答没有失分题，无需补习")
                return quiz

            quiz = validate()
            body = {**body, "weaknesses": flywheel.weaknesses(quiz, plan)}
            receipt = flywheel.receipt_id(source_key, identity)
        elif body.get("attempt_id") and body.get("node_id"):
            identity = {name: body.get(name) for name in ("round_id", "attempt_id")}

            def validate():
                _, quiz = self.repository.saved_attempt(key, identity, body["node_id"])
                if not flywheel.gap_items(quiz):
                    raise JobError(409, "本次作答没有失分题，无需补习")
                return quiz

            validate()
            receipt = flywheel.receipt_id(key + "/" + body["node_id"], identity)
        if receipt:
            with self.repository.lock, self.repository.store.transaction():
                validate()
                current = self.repository.material(key)
                prior = (current.get("refinementReceipts") or {}).get(receipt)
                if prior:
                    return (200, {**prior, "plan": current["plan"], "reused": True})
        weak = []
        for w in (
            body.get("weaknesses") if isinstance(body.get("weaknesses"), list) else []
        )[:8]:
            if not isinstance(w, dict):
                continue
            wid = clip(w.get("nid"), 20)
            if not wid:
                continue
            weak.append(
                {
                    "nid": wid,
                    "节点": (wid + " " + clip(w.get("title"), 120)).strip(),
                    "原因": clip(w.get("reason"), 500),
                    "要点": _str_list(w.get("points"), 6, 200),
                }
            )
        if not weak:
            return (400, {"error": "weaknesses required"})
        try:
            path_hierarchy.ensure_refinable(plan, [item["nid"] for item in weak])
        except ValueError as exc:
            return (400, {"error": str(exc)})
        mkey = key or None
        gate_key = (
            mkey
            + "#refine#"
            + (
                receipt
                or hashlib.sha1(json.dumps(weak, sort_keys=True).encode()).hexdigest()
            )
            if mkey
            else None
        )
        _gate = None
        if gate_key:
            _gate, _owner = self.cache.join(gate_key)
            if not _owner:
                _gate["ev"].wait(GEN_WAIT_MAX)
                hit = _gate["out"] or self.cache.get(gate_key)
                if hit:
                    return (200, hit)
                else:
                    return (
                        502,
                        {"error": _gate["err"] or "细化生成仍在进行中，请稍后重试"},
                    )
                return
        try:
            payload = {
                "学习主题": clip(
                    (spec or {}).get("topic") or (plan or {}).get("title"), 160
                ),
                "现有单元": [
                    {"id": clip(n.get("id"), 20), "标题": clip(n.get("title"), 120)}
                    for n in (plan.get("nodes") or [])[:48]
                    if isinstance(n, dict)
                ],
                "薄弱点": weak,
            }
            obj = _json_block(
                self.model.nonempty(
                    [
                        {"role": "system", "content": _path_system("refine")},
                        {
                            "role": "user",
                            "content": json.dumps(payload, ensure_ascii=False)
                            + "\n请输出细化单元 JSON。",
                        },
                    ],
                    max_tokens=self.model.settings.max_output_tokens,
                    temperature=0.5,
                )
            )
        except Exception:
            if gate_key:
                self.cache.finish(gate_key, _gate, err="refine generation failed")
            raise
        units = _norm_refine_units(obj, plan)
        if not units or any(
            (unit["for"] not in {w["nid"] for w in weak} for unit in units)
        ):
            if gate_key:
                self.cache.finish(gate_key, _gate, err="refine generation failed")
            return (502, {"error": "refine generation failed"})
        try:
            new_plan = self.repository.append_refinement(
                mkey, plan, units, receipt, validate
            )
        except ValueError as exc:
            if gate_key:
                self.cache.finish(gate_key, _gate, err=str(exc))
            raise JobError(409, str(exc)) from exc
        except Exception:
            if gate_key:
                self.cache.finish(gate_key, _gate, err="refine save failed")
            raise
        out = {
            "ok": True,
            "added": len(units),
            "units": [{"for": u.get("for"), "title": u.get("title")} for u in units],
            "plan": new_plan,
        }
        if receipt:
            out = {
                **(self.repository.material(mkey).get("refinementReceipts") or {})[
                    receipt
                ],
                "plan": new_plan,
            }
        if gate_key:
            self.cache.put(gate_key, out)
            self.cache.finish(gate_key, _gate, out=out)
        return (200, out)
