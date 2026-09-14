# 操作加锁（生成单飞）+ 出题质量修正（设计文档）

## 目标（两条线，一次实现）

**A. 操作加锁 —— 生成单飞**：同一份资料（key）的同一生成操作的并发请求，服务端**只执行一次**生成；其余请求等待并复用同一结果；已生成过的直接复用（不再调用模型）。
覆盖端点：`/path/node`、`/path/requiz`、`/path/plan`、`/path/research`。
用户原话：「同一个网页【…?t=三周完成小升初所有课程】多个用户同时点击【n1 …】实际上背后只有1次执行。」

**B. 出题质量修正**（用户两条反馈）：
1. 「简答题要求提供思路和答案两个部分。」→ 简答题题干要求学生给出「思路」+「答案」两部分；参考答案也分两部分。
2. 「这个应该不算是给学生出的题」（截图：小明摸底诊断/先补哪块）→ 禁止出替他人做规划/安排/诊断之类元问题；只能是学生本人能作答的知识题。
3. 追加质量项：4 道选择题的正确项字母要分散（实测四题全 A，位置偏差明显）。

## 执行要求（给实现者）

- 每个替换前先 `grep` 确认「旧」文本**唯一命中**；若与文件不完全一致 → **停下并报告**，不要自行发挥。
- 只做本文件指定的修改。不要动：`parse_questions` 与旧 `/quiz` 端点、`/state/*` 逻辑、`/ask`、`/suggest`、`/compress`、`/path/intake`、现有重试与归一化语义（除指明处）。
- 不要部署、不要 git commit。
- `path_template.html` 本次**不应**出现在 diff 里。

---

# Part A — 生成单飞

## A0. 基础设施（study_assistant.py）

在以下锚点**之后**插入新代码块（即 `DELETE_PASSWORD` 行之后、`# ====…` 注释之前）：

锚点原文：
```
DELETE_PASSWORD = os.environ.get("DELETE_PASSWORD", "")   # 「删除资料」按钮密码（/state/delete 校验）；未配置则拒绝删除
```

插入内容（注意：保持与文件相同的 4 空格缩进层级——这是模块级代码，顶格）：

```python
# ---- 生成单飞：同一份资料同一操作并发只执行一次；结果近时缓存 + 服务端状态直读 ----
GEN_CACHE_TTL = 1800          # 成品结果近时缓存（秒）
GEN_CACHE_TTL_SHORT = 90      # 「换新题」类求新操作的短窗去重（秒）
GEN_WAIT_MAX = 150            # 等待在先生成结果的最长秒数（< 前端 180s 超时）
GEN_GATE_STALE = 600          # 单飞闸门超过该秒数视为领先者已失联，允许接管
_GEN_LOCK = threading.Lock()
_GEN_GATES = {}               # key -> {"ev": Event, "out": obj|None, "err": str|None, "ts": float}
_GEN_CACHE = {}               # key -> (out, ts)


def _gen_cache_get(key, ttl=GEN_CACHE_TTL):
    now = time.time()
    with _GEN_LOCK:
        hit = _GEN_CACHE.get(key)
        if hit and now - hit[1] < ttl:
            return hit[0]
        if hit:
            _GEN_CACHE.pop(key, None)
    return None


def _gen_cache_put(key, out):
    with _GEN_LOCK:
        _GEN_CACHE[key] = (out, time.time())
        if len(_GEN_CACHE) > 300:
            for k, _ in sorted(_GEN_CACHE.items(), key=lambda kv: kv[1][1])[:100]:
                _GEN_CACHE.pop(k, None)


def _gen_gate_join(key):
    """并发单飞：返回 (gate, owner)。owner=True 的请求负责生成，然后 `_gen_gate_finish`。"""
    now = time.time()
    with _GEN_LOCK:
        g = _GEN_GATES.get(key)
        if g is not None and now - g["ts"] > GEN_GATE_STALE:
            g = None      # 领先者失联/卡死：允许接管
        if g is None:
            g = {"ev": threading.Event(), "out": None, "err": None, "ts": now}
            _GEN_GATES[key] = g
            return g, True
    return g, False


def _gen_gate_finish(key, gate, out=None, err=None):
    """收口单飞闸门：所有等待者拿到同一结果。"""
    gate["out"], gate["err"] = out, err
    with _GEN_LOCK:
        _GEN_GATES.pop(key, None)
    gate["ev"].set()


def _state_read_key(key):
    """读服务端单个 key 的原始值字符串（不存在/墓碑 → None）。"""
    try:
        with STATE_LOCK:
            with open(os.path.join(STATE_DIR, hashlib.sha1(key.encode("utf-8")).hexdigest() + ".json"), "r", encoding="utf-8") as f:
                d = json.load(f)
    except Exception:
        return None
    return d.get("v") if isinstance(d, dict) else None


def _state_material(key):
    v = _state_read_key(key)
    if not isinstance(v, str):
        return None
    try:
        m = json.loads(v)
    except Exception:
        return None
    return m if isinstance(m, dict) else None


def _state_node_detail(key, nid):
    """资料里已存有该节点的生成结果则直接返回（保证「只生成一次」）。"""
    m = _state_material(key)
    if not m:
        return None
    d = (m.get("nodeDetail") or {}).get(nid)
    return d if isinstance(d, dict) and d else None


def _state_stage_result(key, stage):
    """资料里已存有该阶段结果则直接返回。"""
    m = _state_material(key)
    if not m:
        return None
    if stage == "research":
        if m.get("brief") and m.get("queries"):
            return {"queries": m.get("queries") or [], "sources": m.get("sources") or [],
                    "brief": m.get("brief") or ""}
        return None
    if stage == "plan":
        pl = m.get("plan")
        if isinstance(pl, dict) and isinstance(pl.get("nodes"), list) and len(pl["nodes"]) >= 6:
            return pl
        return None
    return None
```

## A1. `/path/node` 改造

### A1a 顶部加闸（在 `node = body.get("node") or {}` 之后、`payload = {` 之前）

旧：
```
        # -- 节点学习材料 --
        if path.startswith("/path/node"):
            spec = _norm_spec(body.get("spec"))
            node = body.get("node") or {}
            payload = {
```

新：
```
        # -- 节点学习材料 --
        if path.startswith("/path/node"):
            spec = _norm_spec(body.get("spec"))
            node = body.get("node") or {}
            mkey = clip(str(body.get("key") or ""), 200)
            node_id = clip(node.get("id"), 20)
            gate_key = (mkey + "#node#" + node_id) if (mkey and node_id) else None
            if gate_key:
                hit = _state_node_detail(mkey, node_id) or _gen_cache_get(gate_key)
                if hit is not None:
                    self._json(200, hit)
                    return
                _gate, _owner = _gen_gate_join(gate_key)
                if not _owner:
                    _gate["ev"].wait(GEN_WAIT_MAX)
                    hit = _gate["out"] or _gen_cache_get(gate_key) or _state_node_detail(mkey, node_id)
                    if hit is not None:
                        self._json(200, hit)
                        return
                    self._json(502, {"error": _gate["err"] or "生成仍在进行中，请稍后重试"})
                    return
            payload = {
```

### A1b 生成段包 try + 结尾收口

旧：
```
            detail = _norm_node_detail(_json_block(_upstream_nonempty(
                _mk_node(), max_tokens=PATH_MAX_TOKENS, temperature=0.5)))
            _qn = len((((detail or {}).get("quiz") or {}).get("questions")) or [])
            if detail is None or _qn < 6:
                # 重试一次：强调完整闭合 + 控制篇幅，温度调低；缺自测题/题数不足（截断降级）也重试
                d2 = _norm_node_detail(_json_block(_upstream_nonempty(
                    _mk_node(" 注意：只输出一个完整闭合的 JSON 对象（大括号成对），study_notes 控制在 1000 字内，必须带 6 道自测题（4 选择题+1 填空题+1 简答题）。"),
                    max_tokens=PATH_MAX_TOKENS, temperature=0.3)))
                _d2n = len((((d2 or {}).get("quiz") or {}).get("questions")) or [])
                if d2 is not None and (detail is None or _d2n > _qn):
                    detail = d2
            if detail is None:
                self._json(502, {"error": "node detail generation failed"})
                return
            self._json(200, detail)
            return
```

新：
```
            try:
                detail = _norm_node_detail(_json_block(_upstream_nonempty(
                    _mk_node(), max_tokens=PATH_MAX_TOKENS, temperature=0.5)))
                _qn = len((((detail or {}).get("quiz") or {}).get("questions")) or [])
                if detail is None or _qn < 6:
                    # 重试一次：强调完整闭合 + 控制篇幅，温度调低；缺自测题/题数不足（截断降级）也重试
                    d2 = _norm_node_detail(_json_block(_upstream_nonempty(
                        _mk_node(" 注意：只输出一个完整闭合的 JSON 对象（大括号成对），study_notes 控制在 1000 字内，必须带 6 道自测题（4 选择题+1 填空题+1 简答题）。"),
                        max_tokens=PATH_MAX_TOKENS, temperature=0.3)))
                    _d2n = len((((d2 or {}).get("quiz") or {}).get("questions")) or [])
                    if d2 is not None and (detail is None or _d2n > _qn):
                        detail = d2
            except Exception:
                if gate_key:
                    _gen_gate_finish(gate_key, _gate, err="node detail generation failed")
                raise
            if detail is None:
                if gate_key:
                    _gen_gate_finish(gate_key, _gate, err="node detail generation failed")
                self._json(502, {"error": "node detail generation failed"})
                return
            if gate_key:
                _gen_cache_put(gate_key, detail)
                _gen_gate_finish(gate_key, _gate, out=detail)
            self._json(200, detail)
            return
```

## A2. `/path/requiz` 改造

### A2a 顶部加闸（在 `spec = … if body.get("spec") else None` 之后、`used = []` 之前）

旧：
```
            spec = _norm_spec(body.get("spec")) if body.get("spec") else None
            used = []
```

新：
```
            spec = _norm_spec(body.get("spec")) if body.get("spec") else None
            mkey = clip(str(body.get("key") or ""), 200)
            node_id = clip(node.get("id"), 20)
            gate_key = (mkey + "#requiz#" + node_id) if (mkey and node_id) else None
            if gate_key:
                hit = _gen_cache_get(gate_key, GEN_CACHE_TTL_SHORT)
                if hit is not None:
                    self._json(200, hit)
                    return
                _gate, _owner = _gen_gate_join(gate_key)
                if not _owner:
                    _gate["ev"].wait(GEN_WAIT_MAX)
                    hit = _gate["out"] or _gen_cache_get(gate_key, GEN_CACHE_TTL_SHORT)
                    if hit is not None:
                        self._json(200, hit)
                        return
                    self._json(502, {"error": _gate["err"] or "换题仍在进行中，请稍后重试"})
                    return
            used = []
```

### A2b 生成段包 try + 结尾收口

旧：
```
            rq = _norm_quiz_questions(_json_block(_upstream_nonempty(
                _mk_requiz(), max_tokens=PATH_MAX_TOKENS, temperature=0.6)))
            if rq is None or len(rq["questions"]) < 6:
                rq2 = _norm_quiz_questions(_json_block(_upstream_nonempty(
                    _mk_requiz(" 注意：只输出一个完整闭合的 JSON 对象（大括号成对），必须含 6 道题（4 选择题+1 填空题+1 简答题），且与已出过的题目完全不同。"),
                    max_tokens=PATH_MAX_TOKENS, temperature=0.4)))
                if rq2 is not None and (rq is None or len(rq2["questions"]) > len(rq["questions"])):
                    rq = rq2
            if rq is None:
                self._json(502, {"error": "requiz failed"})
                return
            self._json(200, rq)
            return
```

新：
```
            try:
                rq = _norm_quiz_questions(_json_block(_upstream_nonempty(
                    _mk_requiz(), max_tokens=PATH_MAX_TOKENS, temperature=0.6)))
                if rq is None or len(rq["questions"]) < 6:
                    rq2 = _norm_quiz_questions(_json_block(_upstream_nonempty(
                        _mk_requiz(" 注意：只输出一个完整闭合的 JSON 对象（大括号成对），必须含 6 道题（4 选择题+1 填空题+1 简答题），且与已出过的题目完全不同。"),
                        max_tokens=PATH_MAX_TOKENS, temperature=0.4)))
                    if rq2 is not None and (rq is None or len(rq2["questions"]) > len(rq["questions"])):
                        rq = rq2
            except Exception:
                if gate_key:
                    _gen_gate_finish(gate_key, _gate, err="requiz failed")
                raise
            if rq is None:
                if gate_key:
                    _gen_gate_finish(gate_key, _gate, err="requiz failed")
                self._json(502, {"error": "requiz failed"})
                return
            if gate_key:
                _gen_cache_put(gate_key, rq)
                _gen_gate_finish(gate_key, _gate, out=rq)
            self._json(200, rq)
            return
```

## A3. `/path/plan` 改造

### A3a 顶部加闸（在 `brief = clip(body.get("brief"), 2000)` 之后）

旧：
```
        if path.startswith("/path/plan"):
            spec = _norm_spec(body.get("spec"))
            brief = clip(body.get("brief"), 2000)
```

新：
```
        if path.startswith("/path/plan"):
            spec = _norm_spec(body.get("spec"))
            brief = clip(body.get("brief"), 2000)
            mkey = clip(str(body.get("key") or ""), 200)
            gate_key = (mkey + "#plan") if mkey else None
            if gate_key:
                hit = _state_stage_result(mkey, "plan") or _gen_cache_get(gate_key)
                if hit is not None:
                    self._json(200, hit)
                    return
                _gate, _owner = _gen_gate_join(gate_key)
                if not _owner:
                    _gate["ev"].wait(GEN_WAIT_MAX)
                    hit = _gate["out"] or _gen_cache_get(gate_key) or _state_stage_result(mkey, "plan")
                    if hit is not None:
                        self._json(200, hit)
                        return
                    self._json(502, {"error": _gate["err"] or "路径生成仍在进行中，请稍后重试"})
                    return
```

### A3b 生成段包 try + 结尾收口

旧：
```
            plan = _norm_plan(_json_block(upstream_json(
                _mk(), max_tokens=PATH_MAX_TOKENS, temperature=0.5)), spec)
            if plan is None or len(plan["nodes"]) < 6:
                plan = _norm_plan(_json_block(upstream_json(
                    _mk("注意：必须至少 6 个节点，id 从 n1 连续，deps 只引用编号更小的 id。"),
                    max_tokens=PATH_MAX_TOKENS, temperature=0.3)), spec)
            if plan is None or len(plan["nodes"]) < 6:
                self._json(502, {"error": "plan generation failed: need >=6 valid nodes", "plan": plan})
                return
            self._json(200, plan)
            return
```

新：
```
            try:
                plan = _norm_plan(_json_block(upstream_json(
                    _mk(), max_tokens=PATH_MAX_TOKENS, temperature=0.5)), spec)
                if plan is None or len(plan["nodes"]) < 6:
                    plan = _norm_plan(_json_block(upstream_json(
                        _mk("注意：必须至少 6 个节点，id 从 n1 连续，deps 只引用编号更小的 id。"),
                        max_tokens=PATH_MAX_TOKENS, temperature=0.3)), spec)
            except Exception:
                if gate_key:
                    _gen_gate_finish(gate_key, _gate, err="plan generation failed")
                raise
            if plan is None or len(plan["nodes"]) < 6:
                if gate_key:
                    _gen_gate_finish(gate_key, _gate, err="plan generation failed")
                self._json(502, {"error": "plan generation failed: need >=6 valid nodes", "plan": plan})
                return
            if gate_key:
                _gen_cache_put(gate_key, plan)
                _gen_gate_finish(gate_key, _gate, out=plan)
            self._json(200, plan)
            return
```

## A4. `/path/research` 改造

### A4a 顶部加闸（在 `spec = _norm_spec(body.get("spec"))` 之后、`qtext = _upstream_nonempty([` 之前）

旧：
```
        # -- 研究：检索式 → SearXNG → 简报 --
        if path.startswith("/path/research"):
            spec = _norm_spec(body.get("spec"))
            qtext = _upstream_nonempty([
```

新：
```
        # -- 研究：检索式 → SearXNG → 简报 --
        if path.startswith("/path/research"):
            spec = _norm_spec(body.get("spec"))
            mkey = clip(str(body.get("key") or ""), 200)
            gate_key = (mkey + "#research") if mkey else None
            if gate_key:
                hit = _state_stage_result(mkey, "research") or _gen_cache_get(gate_key)
                if hit is not None:
                    self._json(200, hit)
                    return
                _gate, _owner = _gen_gate_join(gate_key)
                if not _owner:
                    _gate["ev"].wait(GEN_WAIT_MAX)
                    hit = _gate["out"] or _gen_cache_get(gate_key) or _state_stage_result(mkey, "research")
                    if hit is not None:
                        self._json(200, hit)
                        return
                    self._json(502, {"error": _gate["err"] or "研究仍在进行中，请稍后重试"})
                    return
            qtext = _upstream_nonempty([
```

### A4b 生成段包 try + 结尾收口

旧（从 `qtext = …` 到 `return`，共整段）：
```
            qtext = _upstream_nonempty([
                {"role": "system", "content": _path_system("research_queries")},
                {"role": "user", "content": "需求单：\n" + json.dumps(spec, ensure_ascii=False)},
            ], max_tokens=PATH_MAX_TOKENS, temperature=0.5)
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
            sources, seen = [], set()
            for q in queries:
                for r in _searxng(q, 5):
                    if r["url"] in seen:
                        continue
                    seen.add(r["url"])
                    sources.append(r)
                    if len(sources) >= 12:
                        break
                if len(sources) >= 12:
                    break
            src_txt = "\n".join("[%d] %s | %s | %s" % (i + 1, s["title"], s["url"], s["snippet"])
                                for i, s in enumerate(sources)) or "（无检索结果）"
            brief = _upstream_nonempty([
                {"role": "system", "content": _path_system("research_brief")},
                {"role": "user", "content": "需求单：\n%s\n\n检索结果：\n%s" % (
                    json.dumps(spec, ensure_ascii=False), clip(src_txt, 12000))},
            ], max_tokens=PATH_MAX_TOKENS, temperature=0.5)
            self._json(200, {"queries": queries, "sources": sources, "brief": clip(brief, 2000)})
            return
```

新（整体 +4 缩进包进 try，并收口）：
```
            try:
                qtext = _upstream_nonempty([
                    {"role": "system", "content": _path_system("research_queries")},
                    {"role": "user", "content": "需求单：\n" + json.dumps(spec, ensure_ascii=False)},
                ], max_tokens=PATH_MAX_TOKENS, temperature=0.5)
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
                sources, seen = [], set()
                for q in queries:
                    for r in _searxng(q, 5):
                        if r["url"] in seen:
                            continue
                        seen.add(r["url"])
                        sources.append(r)
                        if len(sources) >= 12:
                            break
                    if len(sources) >= 12:
                        break
                src_txt = "\n".join("[%d] %s | %s | %s" % (i + 1, s["title"], s["url"], s["snippet"])
                                    for i, s in enumerate(sources)) or "（无检索结果）"
                brief = _upstream_nonempty([
                    {"role": "system", "content": _path_system("research_brief")},
                    {"role": "user", "content": "需求单：\n%s\n\n检索结果：\n%s" % (
                        json.dumps(spec, ensure_ascii=False), clip(src_txt, 12000))},
                ], max_tokens=PATH_MAX_TOKENS, temperature=0.5)
            except Exception:
                if gate_key:
                    _gen_gate_finish(gate_key, _gate, err="research failed")
                raise
            out = {"queries": queries, "sources": sources, "brief": clip(brief, 2000)}
            if gate_key:
                _gen_cache_put(gate_key, out)
                _gen_gate_finish(gate_key, _gate, out=out)
            self._json(200, out)
            return
```

## A5. 前端（learning-path/path_app.js）四处请求带上资料键

### A5a 研究调用
旧：`    post('/path/research', { spec: state.spec })`
新：`    post('/path/research', { spec: state.spec, key: storeKey() })`

### A5b 路径调用
旧：`        return post('/path/plan', { spec: state.spec, brief: state.brief });`
新：`        return post('/path/plan', { spec: state.spec, brief: state.brief, key: storeKey() });`

### A5c 节点材料调用
旧：
```
    post('/path/node', {
      spec: state.spec,
      node: { id: n.id, title: n.title, essence: n.essence, objectives: n.objectives || [] },
      dep_titles: depTitles(id)
    }).then(function (detail) {
```
新：
```
    post('/path/node', {
      spec: state.spec,
      node: { id: n.id, title: n.title, essence: n.essence, objectives: n.objectives || [] },
      dep_titles: depTitles(id),
      key: storeKey()
    }).then(function (detail) {
```

### A5d 换新题调用（节点对象补 `id`，请求补 `key`）

> ⚠️ 注意：`node: { title: n.title, … }` 这一行在文件中**出现 2 次**（742 行 `/path/quiz` 提交块、811 行 `/path/requiz` 块）。必须用下面的**完整块**（含 `post('/path/requiz', {` 与 `feedback:` 行）作为唯一匹配单元，**不要只替换单行**；742 行的 `/path/quiz` 提交块本次**不动**。

旧：
```
    post('/path/requiz', {
      node: { title: n.title, essence: n.essence, objectives: n.objectives || [] },
      spec: state.spec,
      used: used.slice(-12),
      feedback: st.lastResult || null
    }).then(function (r) {
```
新：
```
    post('/path/requiz', {
      node: { id: n.id, title: n.title, essence: n.essence, objectives: n.objectives || [] },
      spec: state.spec,
      used: used.slice(-12),
      feedback: st.lastResult || null,
      key: storeKey()
    }).then(function (r) {
```

---

# Part B — 出题质量修正

## B1. node 提示词（`_PATH_SYSTEM["node"]` 规则 3）整行替换

旧：
`3. quiz.questions 固定 6 题，顺序固定：第 1~4 题选择题（type="choice"）：每题恰好 4 个选项（options 数组，只写选项文本、不要「A.」之类前缀），answer 为正确选项字母（A/B/C/D），explain 说明正确项为何对、干扰项错在哪；第 5 题填空题（type="fill"）：空格用 ____ 表示，answer 为参考答案（多种可接受表述用 ｜ 分隔）；第 6 题简答题（type="short"）：题干要求「简要说明/解释」，answer 为 2~4 条评分要点。每题都必须给 explain（解析）。4 道选择题要覆盖本节点不同的核心知识点、难度从易到难，干扰项要有迷惑性（用常见错误思路设置）。`

新：
`3. quiz.questions 固定 6 题，顺序固定：第 1~4 题选择题（type="choice"）：每题恰好 4 个选项（options 数组，只写选项文本、不要「A.」之类前缀），answer 为正确选项字母（A/B/C/D，四题正确项字母要分散、不要集中在同一个字母），explain 说明正确项为何对、干扰项错在哪；第 5 题填空题（type="fill"）：空格用 ____ 表示，answer 为参考答案（多种可接受表述用 ｜ 分隔）；第 6 题简答题（type="short"）：题干明确要求学生给出「思路」和「答案」两部分（如「请写出你的思路和答案」），answer 为参考答案（分「思路」与「答案」两部分，共 2~4 条要点）。每题都必须给 explain（解析）。4 道选择题要覆盖本节点不同的核心知识点、难度从易到难，干扰项要有迷惑性（用常见错误思路设置）。所有题目必须是学生题：面向学生本人、考查本节点知识、能明确判对错；不要出替他人做规划、安排日程、诊断薄弱点之类的元问题。`

## B2. requiz 提示词（`_PATH_SYSTEM["requiz"]`）

### B2a 规则 1 整行替换
旧：
`1. 出 6 道全新题，结构固定：第 1~4 题选择题（每题 4 个选项、answer 为字母 A/B/C/D）、第 5 题填空题、第 6 题简答题；覆盖本节点的知识要点，难度与上次相当或略低（学生未通过，以巩固与补漏为主）。`

新：
`1. 出 6 道全新题，结构固定：第 1~4 题选择题（每题 4 个选项、answer 为字母 A/B/C/D，四题正确项字母要分散）、第 5 题填空题、第 6 题简答题（题干明确要求学生给出「思路」和「答案」两部分）；覆盖本节点的知识要点，难度与上次相当或略低（学生未通过，以巩固与补漏为主）。题目必须是学生题：面向学生本人、能明确判对错；不要出替他人做规划、安排日程、诊断薄弱点之类的元问题。`

### B2b 规则 4 整行替换
旧：
`4. 每题必须给 answer（参考答案）与 explain（解析）；选择题 explain 说明正确项与干扰项。`

新：
`4. 每题必须给 answer（参考答案）与 explain（解析）；选择题 explain 说明正确项与干扰项；简答题 answer 分「思路」与「答案」两部分给出。`

## B3. 判分提示词（`_PATH_SYSTEM["quiz"]` 规则 1 中的 short 片段）替换

旧片段（句中一部分）：
`short=简答题——对照参考答案的评分要点判断覆盖程度：要点完整=对、部分覆盖=在 comment 指出缺什么、完全跑题或空白=错。未标注 type 的题按简答/文本题处理。`

新片段：
`short=简答题——题干要求学生给出「思路」和「答案」两部分；对照参考答案的评分要点判断覆盖程度：思路与答案两部分基本齐全=对；只覆盖一部分=在 comment 指出缺什么（欠思路还是欠答案）；完全跑题或空白=错。未标注 type 的题按简答/文本题处理。`

## B4. 前端简答题占位文案（path_app.js `quizQHtml` 内）

旧：
```
    return head + '<textarea id="' + areaPrefix + i + '" placeholder="写下你的答案…">' + (cur != null ? esc(cur) : '') + '</textarea></div>';
```
新：
```
    return head + '<textarea id="' + areaPrefix + i + '" placeholder="' + (q.type === 'short' ? '写下你的思路和答案…' : '写下你的答案…') + '">' + (cur != null ? esc(cur) : '') + '</textarea></div>';
```

---

# 收尾：重生成 + 自检清单（逐条执行并贴证据）

1. `python3 -m py_compile study-assistant/study_assistant.py` → 通过
2. `cd learning-path && node --check path_app.js` → 通过
3. `cd learning-path && python3 gen_path_page.py` → 重新生成 learning-path.html
4. 自检 grep：
   - `grep -n "gate_key = (" study-assistant/study_assistant.py` → 4 处（node/requiz/plan/research）
   - `grep -n "key: storeKey()" learning-path/path_app.js` → 4 处
   - `grep -n "思路」和「答案" study-assistant/study_assistant.py` → 3 处（node 规则3、requiz 规则1、判分）
   - `grep -n "元问题" study-assistant/study_assistant.py` → 2 处（node、requiz）
   - `grep -n "正确项字母要分散" study-assistant/study_assistant.py` → 2 处
   - `grep -c "写下你的思路和答案" learning-path/learning-path.html` → ≥1
   - `grep -c "_gen_gate_finish\|_gen_gate_join\|_gen_cache_get\|_gen_cache_put" study-assistant/study_assistant.py` → ≥ 18（供参考，逐行列出）
5. `git diff --stat` → 只允许：`study-assistant/study_assistant.py`、`learning-path/path_app.js`、`learning-path/learning-path.html`
6. 输出：改动清单 + 全部证据 + 自审结论（含任何未能完全匹配的位置）。

**注意**：若某个「旧」代码块与文件不一致，停下来报告哪一处，不要猜改。全部完成后不要部署、不要 commit。
