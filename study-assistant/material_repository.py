"""Transactional learning documents, immutable quiz history and refinement receipts."""

import json
import re
import threading
import path_hierarchy
import flywheel
import quiz_harness as harness
from state_store import StateConflict
from state_schema import validate_value
from service_limits import STATE_MAX_KEYS, STATE_MAX_VALUE
from material_titles import document_title
from background_jobs import JobError
from generation_contracts import _split_ukey


class MaterialRepository:
    def __init__(self, store):
        self.store = store
        self.lock = threading.RLock()

    def read_key(self, key):
        """Read a document, preserving u0 aliases without reviving tombstones."""
        store = self.store
        record = store.record(key)
        if record is None and key.startswith("u0/"):
            legacy = key[3:]
            if "/" not in legacy and legacy.startswith(
                ("learn-", "quiz-map-", "knowledge-map-")
            ):
                record = store.record(legacy)
        return record["value"] if record else None

    def material(self, key):
        v = self.read_key(key)
        if not isinstance(v, str):
            return None
        try:
            m = json.loads(v)
        except Exception:
            return None
        return m if isinstance(m, dict) else None

    def node_detail(self, key, nid):
        """资料里已存有该节点的生成结果则直接返回（保证「只生成一次」）。"""
        m = self.material(key)
        if not m:
            return None
        d = (m.get("nodeDetail") or {}).get(nid)
        return d if isinstance(d, dict) and d else None

    def stage_result(self, key, stage):
        """资料里已存有该阶段结果则直接返回。"""
        m = self.material(key)
        if not m:
            return None
        if stage == "research":
            if m.get("brief") and m.get("queries") and (m.get("research_version") == 2):
                return {
                    "queries": m.get("queries") or [],
                    "sources": m.get("sources") or [],
                    "brief": m.get("brief") or "",
                    "research_version": 2,
                }
            return None
        if stage == "plan":
            pl = m.get("plan")
            if (
                isinstance(pl, dict)
                and isinstance(pl.get("nodes"), list)
                and (len(pl["nodes"]) >= 6)
            ):
                return pl
            return None
        return None

    def write_key(self, key, value):
        """Write in the calling transaction, or start a single-document transaction."""
        self.store.put(key, value)

    def merge(self, mkey, patch):
        """Apply a generated patch in one transaction; merge node results by id."""
        if not mkey or not isinstance(patch, dict):
            return False
        with self.lock, self.store.transaction():
            material = self.material(mkey)
            if material is None:
                return False
            for field, value in patch.items():
                if field == "nodeDetail" and isinstance(value, dict):
                    material[field] = {**(material.get(field) or {}), **value}
                else:
                    material[field] = value
            self.write_key(mkey, json.dumps(material, ensure_ascii=False))
            return True

    def append_refinement(self, key, fallback_plan, units, receipt=None, validate=None):
        """Allocate ids and append to the latest plan under the same state lock."""
        with self.lock, self.store.transaction():
            material = self.material(key) if key else None
            if key and material is None:
                raise ValueError("学习地图已删除或不存在，请重新打开")
            if validate:
                validate()
            if receipt and material:
                prior = (material.get("refinementReceipts") or {}).get(receipt)
                if prior:
                    result = {**prior, "plan": material["plan"], "reused": True}
                    self.store.record_job_effect(result)
                    return material["plan"]
            plan = material.get("plan") if material else fallback_plan
            if not isinstance(plan, dict):
                raise ValueError("学习地图没有有效路径")
            path_hierarchy.ensure_refinable(plan, [unit["for"] for unit in units])
            nodes = [dict(n) for n in plan.get("nodes", []) if isinstance(n, dict)]
            by_id = {n["id"]: n for n in nodes}
            maxn = max(
                [int(nid[1:]) for nid in by_id if re.fullmatch("n\\d+", nid)] or [0]
            )
            edges = [list(e) for e in plan.get("edges", [])]
            last_by_parent = {}
            added_ids = []
            for unit in units:
                parent = unit["for"]
                if parent not in by_id:
                    raise ValueError("细化单元无法关联原节点，请重试")
                maxn += 1
                nid = "n%d" % maxn
                previous = last_by_parent.get(parent)
                deps = [previous] if previous else list(by_id[parent].get("deps") or [])
                nodes.append(
                    {
                        "id": nid,
                        "title": unit["title"],
                        "essence": unit["essence"],
                        "deps": deps,
                        "objectives": unit["objectives"],
                    }
                )
                added_ids.append(nid)
                nodes[-1]["remediation"] = {"parent": parent}
                if receipt:
                    nodes[-1]["remediation"]["receipt"] = receipt
                edges.extend([[dep, nid] for dep in deps])
                last_by_parent[parent] = nid
            new_plan = path_hierarchy.canonicalize_plan(
                {**plan, "nodes": nodes, "edges": edges}
            )
            if material is not None:
                material["plan"] = new_plan
                if receipt:
                    material.setdefault("refinementReceipts", {})[receipt] = {
                        "ok": True,
                        "added": len(units),
                        "node_ids": added_ids,
                        "units": [
                            {"for": unit["for"], "title": unit["title"]}
                            for unit in units
                        ],
                    }
                self.write_key(key, json.dumps(material, ensure_ascii=False))
                effect = (
                    material["refinementReceipts"][receipt]
                    if receipt
                    else {
                        "ok": True,
                        "added": len(units),
                        "units": [
                            {"for": unit.get("for"), "title": unit.get("title")}
                            for unit in units
                        ],
                    }
                )
                self.store.record_job_effect({**effect, "plan": new_plan})
            return new_plan

    def saved_attempt(self, key, identity, node_id=None):
        material = self.material(key)
        if material is None:
            raise JobError(404, "学习资料不存在")
        quiz = (
            ((material.get("nodeDetail") or {}).get(node_id) or {}).get("quiz")
            if node_id
            else material
        )
        if not isinstance(quiz, dict):
            raise JobError(409, "题集不存在，请刷新")
        harness.ensure_round(quiz)
        if not flywheel.matches(quiz, identity):
            raise JobError(409, "作答已更新，请刷新后重新诊断")
        return (material, quiz)

    def quiz_update(self, key, node_id, update, persist=True):
        """Run a short quiz-state transaction; model requests stay outside the lock."""
        with self.lock, self.store.transaction():
            material = self.material(key)
            if material is None:
                raise harness.QuizContractError("学习资料已删除或不存在")
            if node_id:
                detail = (material.get("nodeDetail") or {}).get(node_id)
                if not isinstance(detail, dict) or not isinstance(
                    detail.get("quiz"), dict
                ):
                    raise harness.QuizContractError("单元题目不存在")
                quiz = detail["quiz"]
                if not quiz.get("rounds"):
                    old = (material.get("nodeState") or {}).get(node_id) or {}
                    quiz.update(
                        {k: old[k] for k in ("lastResult", "lastAnswers") if k in old}
                    )
            else:
                quiz = material
            harness.ensure_round(quiz)
            result = update(quiz, material)
            if persist:
                self.write_key(key, json.dumps(material, ensure_ascii=False))
            return result

    def quiz_snapshot(self, key, node_id, read_only=False):
        return self.quiz_update(
            key,
            node_id,
            lambda quiz, material: json.loads(json.dumps(quiz)),
            persist=not read_only,
        )

    def all(self, user_id):
        prefix = user_id + "/"
        out, legacy = ({}, {})
        for record in self.store.records():
            key = record["key"]
            if key.startswith(prefix):
                out[key] = record["value"]
            elif (
                user_id == "u0"
                and "/" not in key
                and key.startswith(("learn-", "quiz-map-", "knowledge-map-"))
            ):
                legacy[prefix + key] = record["value"]
        return {**legacy, **out}

    def put_entries(self, entries, trusted=False, expected=None):
        """写入/删除（v=None 为墓碑）。返回成功条数。"""
        prepared = {}
        if len(entries) > STATE_MAX_KEYS:
            raise ValueError("too many state keys")
        if expected is not None and (
            not isinstance(expected, dict)
            or set(expected) - set(entries)
            or any(
                (
                    type(revision) is not int or revision < 0
                    for revision in expected.values()
                )
            )
        ):
            raise ValueError("invalid revision preconditions")
        with self.lock, self.store.transaction():
            for key, revision in (expected or {}).items():
                current = self.store.record(key)
                if (current["revision"] if current else 0) != revision:
                    raise StateConflict("资料已更新，请刷新后重试")
            for key, value in entries.items():
                if not isinstance(key, str) or not key or len(key) > 512:
                    raise ValueError("invalid state key")
                if value is not None:
                    if not isinstance(value, str):
                        value = json.dumps(value, ensure_ascii=False)
                    validate_value(key, value)
                    existing = self.store.record(key)
                    business = key.split("/", 1)[-1]
                    if (
                        not trusted
                        and existing
                        and (existing["value"] is None)
                        and business.startswith(
                            ("learn-path-v1-", "learn-ai-v1-", "quiz-map-v1-")
                        )
                        and (business != "learn-path-v1-last")
                    ):
                        raise StateConflict("这份资料已删除，请从首页新建学习")
                    _, business_key = _split_ukey(key)
                    is_material = (
                        business_key.startswith("learn-path-v1-")
                        and business_key != "learn-path-v1-last"
                    )
                    is_quiz = business_key.startswith("quiz-map-v1-")
                    if is_material or is_quiz:
                        obj = json.loads(value)
                        if not isinstance(obj, dict):
                            raise ValueError("material must be an object")
                        if is_material and (
                            not (
                                obj.get("topic")
                                or obj.get("plan")
                                or obj.get("history")
                            )
                        ):
                            raise ValueError(
                                "material must contain a topic, plan or history"
                            )
                        if is_quiz and (
                            not (
                                isinstance(obj.get("questions"), list)
                                and obj["questions"]
                            )
                        ):
                            raise ValueError("quiz must contain questions")
                        current = self.material(key)
                        if not trusted:
                            obj["title"] = document_title(current)
                            obj.pop("refinementReceipts", None)
                            quizzes = (
                                [obj]
                                if is_quiz
                                else [
                                    d.get("quiz")
                                    for d in (obj.get("nodeDetail") or {}).values()
                                    if isinstance(d, dict)
                                ]
                            )
                            for quiz in quizzes:
                                if isinstance(quiz, dict):
                                    for field in (
                                        "rounds",
                                        "round_id",
                                        "verified",
                                        "harness_version",
                                        "attempts",
                                        "lastResult",
                                        "lastAnswers",
                                        "lastAttemptId",
                                    ):
                                        quiz.pop(field, None)
                            if is_material:
                                for nid, state in (obj.get("nodeState") or {}).items():
                                    if not isinstance(state, dict):
                                        raise ValueError("invalid node state")
                                    for field in ("score", "lastResult", "lastAnswers"):
                                        state.pop(field, None)
                                    prior = (
                                        (current or {}).get("nodeState") or {}
                                    ).get(nid) or {}
                                    if state.get("completed") and (
                                        not (
                                            prior.get("completed")
                                            or (prior.get("lastResult") or {}).get(
                                                "pass"
                                            )
                                        )
                                    ):
                                        state["completed"] = False
                        if is_material and current:
                            obj["refinementReceipts"] = (
                                current.get("refinementReceipts") or {}
                            )
                            if "quizMaterials" in current:
                                obj["quizMaterials"] = current["quizMaterials"]
                            if (
                                "materials" not in obj
                                or current.get("stage", "intake") != "intake"
                            ):
                                obj["materials"] = current.get("materials") or []
                            if current.get("plan"):
                                obj["plan"] = current["plan"]
                            incoming_details = obj.get("nodeDetail") or {}
                            merged_details = {
                                **(current.get("nodeDetail") or {}),
                                **incoming_details,
                            }
                            for nid, detail in (
                                current.get("nodeDetail") or {}
                            ).items():
                                if (detail.get("quiz") or {}).get("rounds"):
                                    merged_details[nid] = {
                                        **merged_details[nid],
                                        "quiz": detail["quiz"],
                                    }
                            obj["nodeDetail"] = merged_details
                            states = {
                                **(current.get("nodeState") or {}),
                                **(obj.get("nodeState") or {}),
                            }
                            for nid, state in (current.get("nodeState") or {}).items():
                                states[nid] = {
                                    **states[nid],
                                    **{
                                        k: state[k]
                                        for k in ("score", "lastResult", "lastAnswers")
                                        if k in state
                                    },
                                }
                            obj["nodeState"] = states
                        if is_quiz and (not trusted):
                            for field in (
                                "gaps",
                                "gapsAt",
                                "diagnosis",
                                "lastAttemptId",
                            ):
                                obj.pop(field, None)
                                if current and field in current:
                                    obj[field] = current[field]
                            if current and "sourceKey" in current:
                                obj["sourceKey"] = current["sourceKey"]
                                obj["sourceSlug"] = current.get("sourceSlug")
                        if is_quiz and current and current.get("rounds"):
                            for field in (
                                "questions",
                                "round_id",
                                "rounds",
                                "attempts",
                                "lastResult",
                                "lastAnswers",
                            ):
                                if field in current:
                                    obj[field] = current[field]
                        value = json.dumps(obj, ensure_ascii=False)
                    if len(value) > STATE_MAX_VALUE:
                        raise ValueError("state value too large")
                prepared[key] = value
            for key, value in prepared.items():
                self.write_key(key, value)
        return len(prepared)
