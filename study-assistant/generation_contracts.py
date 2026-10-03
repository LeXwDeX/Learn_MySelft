"""Pure normalization and issued-question contracts."""

import json
import re
import path_hierarchy
import quiz_harness as harness
from material_titles import quiz_title
from text_utils import clip


def parse_questions(text):
    """从模型输出里抠出干净的短问题列表。"""
    out = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        line = re.sub(r"^[\-\*•·]+\s*", "", line)
        line = re.sub(r"^\d+[\.、\)）]\s*", "", line)
        line = line.strip(" \t\"'“”「」")
        if not line or len(line) > 24:
            continue
        if line.endswith("。") or line.endswith("."):
            line = line.rstrip("。.")
        if line and line not in out:
            out.append(line)
        if len(out) >= 4:
            break
    return out


def _json_value(text):
    """从模型输出里抠出第一个平衡的 JSON 值（对象或数组）。失败返回 None。

    能处理 ```json ... ``` 围栏、前后解释性文字，以及字符串/转义里的花括号。"""
    if not text:
        return None
    # 只剥离整体外层的围栏（如 ```json\n{...}）；JSON 字符串内部的 ``` 代码块必须保留
    s = re.sub(r"^```[A-Za-z0-9_+-]*[ \t]*\r?\n?", "", text.strip())
    start = None
    for i, ch in enumerate(s):
        if ch in "[{":
            start = i
            break
    if start is None:
        return None
    stack, in_str, esc = [], False, False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "[{(":
            stack.append(ch)
        elif ch in "}])":
            if not stack:
                break
            stack.pop()
            if not stack:
                try:
                    return json.loads(s[start : i + 1])
                except Exception:
                    pass  # 已闭合但内容有瑕疵；落到末尾的"补括号"兜底
    # 兜底修复：模型偶发忘写结尾的 } / ]（正文完整、只差收尾）→ 按剩余栈补上再解析
    if not in_str and stack and len(stack) <= 12 and all(c in "[{" for c in stack):
        closer = {"{": "}", "[": "]"}
        try:
            return json.loads(s[start:] + "".join(closer[c] for c in reversed(stack)))
        except Exception:
            return None
    return None


def _json_block(text):
    """抓第一个平衡的 JSON 对象，返回 dict；否则 None。"""
    v = _json_value(text)
    return v if isinstance(v, dict) else None


def _json_list(text):
    """抓第一个平衡的 JSON 数组，返回 list；否则 None。"""
    v = _json_value(text)
    return v if isinstance(v, list) else None


def _str_list(v, n, limit):
    """把模型给的任意值归一成去空的短字符串列表。"""
    if not isinstance(v, list):
        v = [v] if v else []
    return [clip(str(x), limit) for x in v if str(x).strip()][:n]


def _norm_spec(spec, topic=""):
    """归一 Spec，字段严格对齐前端契约，缺失给合理默认。"""
    spec = spec if isinstance(spec, dict) else {}
    prefs = _str_list(spec.get("preferences"), 6, 20) or ["例子"]
    return {
        "topic": clip(spec.get("topic") or topic, 200),
        "goal": clip(spec.get("goal"), 400),
        "level": clip(spec.get("level"), 60),
        "depth": clip(spec.get("depth"), 60),
        "preferences": prefs,
        "constraints": clip(spec.get("constraints"), 400),
        "outline_hint": _str_list(spec.get("outline_hint"), 8, 100),
    }


def _norm_plan(obj, spec):
    """校验并归一 Plan：6~14 节点、id 从 n1 连续、deps 只指向序号更小的节点，edges 由 deps 推导。

    非法（节点数 <4 或缺 deps 引用）返回 None，交给调用方重试。"""
    if not isinstance(obj, dict) or not isinstance(obj.get("nodes"), list):
        return None
    raw = []
    for n in obj["nodes"]:
        if not isinstance(n, dict):
            continue
        title = clip(n.get("title"), 120)
        if not title:
            continue
        raw.append(
            {
                "oid": str(n.get("id") or "").strip(),
                "title": title,
                "essence": clip(n.get("essence"), 160),
                "objectives": _str_list(n.get("objectives"), 3, 160),
                "deps_raw": _str_list(n.get("deps"), 6, 20),
            }
        )
        if len(raw) >= 14:
            break
    if len(raw) < 4:
        return None
    idmap, ids, idx = {}, set(), {}
    for i, r in enumerate(raw):
        r["id"] = "n%d" % (i + 1)
        ids.add(r["id"])
        idx[r["id"]] = i
        if r["oid"] and r["oid"] not in idmap:
            idmap[r["oid"]] = r["id"]
    nodes, edges, tmp = [], [], []
    for r in raw:
        good = []
        for d in r["deps_raw"]:
            nd = idmap.get(d) or (d if d in ids else None)
            if not nd or nd == r["id"] or idx[nd] >= idx[r["id"]] or nd in good:
                continue
            good.append(nd)
        tmp.append(
            {
                "id": r["id"],
                "title": r["title"],
                "essence": r["essence"],
                "deps": good,
                "objectives": r["objectives"],
                "oidx": idx[r["id"]],
            }
        )
    # 稳定拓扑排序（level = 前置最大层级 + 1，同层保持原顺序）后按序重编号，
    # 保证「展示顺序（分层渲染）== 编号顺序 n1..nN」，避免出现 n6 显示在 n5 之前。
    lvl = {}
    for t in tmp:
        mx = -1
        for d in t["deps"]:
            if lvl.get(d) is not None and lvl[d] > mx:
                mx = lvl[d]
        lvl[t["id"]] = mx + 1
    ordered = sorted(tmp, key=lambda t: (lvl[t["id"]], t["oidx"]))
    ren = {t["id"]: "n%d" % (i + 1) for i, t in enumerate(ordered)}
    for t in ordered:
        nid = ren[t["id"]]
        deps = [ren[d] for d in t["deps"] if d in ren]
        nodes.append(
            {
                "id": nid,
                "title": t["title"],
                "essence": t["essence"],
                "deps": deps,
                "objectives": t["objectives"],
            }
        )
        for d in deps:
            edges.append([d, nid])
    return {"summary": clip(obj.get("summary"), 400), "nodes": nodes, "edges": edges}


def _norm_shq(q):
    """归一单道自测题：透传 type/options（有 options 一律视为选择题）与分值；题干为空返回 None。"""
    question = clip(q.get("q") or q.get("question"), 1500)
    if not question:
        return None
    item = {
        "q": question,
        "answer": clip(q.get("answer"), 1500),
        "explain": clip(q.get("explain"), 1500),
    }
    try:
        p = q.get("points")
        if type(p) is int and 1 <= p <= 100:
            item["points"] = p
    except Exception:
        pass
    pt = clip(q.get("point"), 200)
    if pt:
        item["point"] = pt
    opts = []
    if isinstance(q.get("options"), list):
        opts = [clip(str(o), 400) for o in q.get("options") if str(o).strip()][:4]
    if opts:
        item["options"] = opts
        item["type"] = "choice"
    else:
        t = q.get("type") if isinstance(q.get("type"), str) else ""
        if t in ("fill", "short"):
            item["type"] = t
    if isinstance(q.get("rubric"), list):
        item["rubric"] = q["rubric"]
    if isinstance(q.get("accepted_answers"), list):
        item["accepted_answers"] = q["accepted_answers"]
    for field in ("scoring", "blanks"):
        if field in q:
            item[field] = q[field]
    return item


def _norm_node_detail(obj):
    """归一 NodeDetail：study_notes + 三个清单 + 最多 6 题自测（4 选择+1 填空+1 简答契约，兼容旧格式）。"""
    if not isinstance(obj, dict):
        return None
    notes = clip(obj.get("study_notes") or obj.get("notes"), 3000)
    quiz = obj.get("quiz") if isinstance(obj.get("quiz"), dict) else {}
    qs = []
    for q in quiz.get("questions") if isinstance(quiz.get("questions"), list) else []:
        if not isinstance(q, dict):
            continue
        item = _norm_shq(q)
        if item is None:
            continue
        qs.append(item)
        if len(qs) >= 6:
            break
    if not notes and not qs:
        return None
    return {
        "study_notes": notes,
        "key_points": _str_list(obj.get("key_points"), 5, 200),
        "examples": _str_list(obj.get("examples"), 3, 300),
        "misconceptions": _str_list(obj.get("misconceptions"), 3, 300),
        "quiz": {"questions": qs},
    }


def _norm_quiz_questions(obj):
    """归一「重新出题」结果：{questions:[{q,answer,explain[,type,options]}]}，最多 6 题，至少 1 题有效，否则 None。"""
    if not isinstance(obj, dict):
        return None
    qs = []
    for q in obj.get("questions") if isinstance(obj.get("questions"), list) else []:
        if not isinstance(q, dict):
            continue
        item = _norm_shq(q)
        if item is None:
            continue
        qs.append(item)
        if len(qs) >= 6:
            break
    if not qs:
        return None
    return {"questions": qs}


def _quizmap_title(material):
    return quiz_title(material)


def _norm_quizmap(obj, fallback_title=""):
    """归一「测验地图」：{title, questions[..16]}，至少 1 题有效否则 None。"""
    if not isinstance(obj, dict):
        return None
    title = clip(obj.get("title"), 120) or (clip(fallback_title, 120) + " · 测验")
    qs = []
    for q in obj.get("questions") if isinstance(obj.get("questions"), list) else []:
        if not isinstance(q, dict):
            continue
        item = _norm_shq(q)
        if item is None:
            continue
        qs.append(item)
        if len(qs) >= 16:
            break
    if not qs:
        return None
    return {"title": title, "questions": qs}


def _norm_gaps(obj):
    """归一缺漏诊断结果：{"summary", "gaps":[{"unit","points","advice"}]}。"""
    if not isinstance(obj, dict):
        return None
    gaps = []
    for g in (obj.get("gaps") if isinstance(obj.get("gaps"), list) else [])[:10]:
        if not isinstance(g, dict):
            continue
        pts = [
            clip(str(p), 200)
            for p in (g.get("points") if isinstance(g.get("points"), list) else [])
            if str(p).strip()
        ][:6]
        unit = clip(g.get("unit"), 160)
        if not (unit or pts):
            continue
        gaps.append({"unit": unit, "points": pts, "advice": clip(g.get("advice"), 300)})
    if not gaps:
        return None
    return {"summary": clip(obj.get("summary"), 600), "gaps": gaps}


def _resolve_refine_parent(raw, nodes, ids):
    """把 LLM 返回的父节点引用归一为 plan 内的节点 id。
    容忍：精确 id（n3）、显示编号（L3 / 3 / L3 后跟标题）、标题包含匹配。"""
    fid = str(raw or "").strip()
    if not fid:
        return ""
    if fid in ids:
        return fid
    match = re.match(r"^[Ll]?\s*(\d+(?:\.\d+)*)(?![\d.])", fid)
    if match:
        label = "L" + match.group(1)
        for entry in path_hierarchy.hierarchy(nodes):
            if entry["label"] == label and str(entry["node"]["id"]) in ids:
                return str(entry["node"]["id"])
        return ""
    if len(fid) >= 2:
        for n in nodes:
            t = str(n.get("title") or "").strip()
            if t and len(t) >= 2 and (t in fid or fid in t):
                return str(n.get("id"))
    return ""


def _norm_refine_units(obj, plan):
    """归一细化单元；for 归一为 plan 里已有节点 id（容错 L 编号/标题写法），无法解析则置空。"""
    if not isinstance(obj, dict):
        return None
    nodes = [n for n in ((plan or {}).get("nodes") or []) if isinstance(n, dict)]
    ids = {str(n.get("id")) for n in nodes if n.get("id") is not None}
    out = []
    for u in obj.get("units") if isinstance(obj.get("units"), list) else []:
        if not isinstance(u, dict):
            continue
        title = clip(u.get("title"), 120)
        if not title:
            continue
        for_id = _resolve_refine_parent(u.get("for"), nodes, ids)
        out.append(
            {
                "for": for_id,
                "title": title,
                "essence": clip(u.get("essence"), 200),
                "objectives": _str_list(u.get("objectives"), 4, 160),
            }
        )
        if len(out) >= 12:
            break
    return out or None


def _issued_quiz(questions):
    issued = harness.new_round(questions)
    return {"questions": questions, "round_id": issued["id"], "rounds": [issued]}


def _split_ukey(key):
    """拆分「user path + 业务键」：'u0/learn-path-v1-x' → ('u0/', 'learn-path-v1-x')。

    用户段由服务端鉴权；u0保留升级前资料，无前缀旧键仅兼容u0。
    """
    k = (key or "").strip()
    if "/" in k:
        u, rest = k.split("/", 1)
        if u and len(u) <= 32 and " " not in u:
            return u + "/", rest
    return "", k
