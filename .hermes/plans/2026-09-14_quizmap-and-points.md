# 设计文档：每题分值 + 测验地图（学习地图 → 生成测验）

日期：2026-09-14 · 项目：ZiXueShe（自学社）· 执行者：pi（实现+自审）→ Hermes（审阅+部署+E2E）

## Goal

1. **每题分值**：所有自测/测验题目在题干前显示「（N 分）」，每套题合计恰好 100 分；判分按分值加权。
2. **测验地图**：资料库分「学习地图 / 测验地图」两组；在任意学习地图里点「生成测验」→ 按地图知识点 + 学习者情况（完成度/得分）生成一套测验 → 存为「测验地图」资料 → 可在线作答、自动判分、结果回写。

## 架构现状（必读）

- 后端 `study-assistant/study_assistant.py`（纯标准库，Python）：LLM 代理 + 状态存储。状态目录 `STATE_DIR`（`/opt/study-assistant/state/`），键值都是 **JSON 字符串**。
- 学习地图键：`learn-path-v1-<slug>`；值字段：`stage/topic/history/spec/queries/sources/brief/plan/nodeDetail/nodeState`。
  - `plan.nodes[]` = {id,title,essence,deps,objectives}；`nodeDetail[id]` = {study_notes,key_points,examples,misconceptions,quiz:{questions[]}}；`nodeState[id]` = {completed?,score?,lastResult?}（**学习情况**）。
- 关键辅助函数（已存在，照抄用法）：`_state_read_key(key)`、`_state_material(key)`、`_gen_gate_join/_gen_gate_finish`、`_gen_cache_get/_gen_cache_put`、`_upstream_nonempty`、`_json_block`、`_norm_shq`、`_norm_node_detail`、`_norm_quiz_questions`、`_norm_quiz_result`、`_path_system(name)`、`clip`。**先通读 /path/node、/path/requiz 两个 handler 与上述函数，单飞/缓存/重试结构完全照它们的做法。**
- 前端：`learning-path/path_app.js`（页面逻辑）+ `learning-path/path_template.html`（模板，经 `gen_path_page.py` 生成 `learning-path.html`）；渲染库 `./katex/`、`./highlight/`（部署目录内已有，新页面用相同相对路径引用）。
- 首页：`home/index.html`（单文件，含动态扫描资料库的脚本）。

## Part A：每题分值（points）

### A1. 后端 `study_assistant.py`

**A1a. `_norm_shq(q)`（约 676 行）**：透传分值字段——若 `q["points"]` 可转 int 且 1≤p≤100，则 `item["points"] = int(p)`。

**A1b. 新增 `_fix_points(qs)`**（放在 `_norm_shq` 之后）：
```python
def _fix_points(qs):
    """确保点数合计=100：齐全且和=100 则保留；否则平均分配（余数从最后一题往前加 1）。"""
    n = len(qs)
    if not n:
        return qs
    ok = all(isinstance(q.get("points"), int) and q["points"] > 0 for q in qs)
    if ok and sum(q["points"] for q in qs) != 100:
        ok = False
    if not ok:
        base, rem = divmod(100, n)
        for q in qs:
            q["points"] = base
        for i in range(rem):
            qs[n - 1 - i]["points"] += 1
    return qs
```

**A1c.** `_norm_node_detail`（约 696 行）与 `_norm_quiz_questions`（约 721 行）：各自收集完 6 题后调用 `_fix_points(qs)` 再返回。

**A1d. node 系统提示词**：找到 `_PATH_SYSTEM["node"]` 里自测题的规则（含「必须含 6 道题」的那条）与 JSON 示例，在其中加入分值要求：
- 规则追加：「每题必须给 `points`（分值，整数）：6 题合计恰好 100 分（建议：选择题每题 10~15 分；填空题 15~20 分；简答题 25~40 分）。」
- JSON 示例中每题加 `"points":15` 之类字段（示例合计 100）。

**A1e. requiz 系统提示词**（`_PATH_SYSTEM["requiz"]`）：
- 规则 1 末尾追「；6 题分值合计恰好 100 分」；规则 4 改为：「每题必须给 answer（参考答案）、explain（解析）与 points（分值，整数）；6 题 points 合计恰好 100。」JSON 示例同步加 `"points":15`。

**A1f. quiz 判分提示词**（`_PATH_SYSTEM["quiz"]`）：规则 2 改为：「score 为百分制整数：按每题 points 分值加权评定（对一题得该题满分，部分正确按比例给分并说明），四舍五入。」

**A1g. `/path/quiz` handler（约 1154 行）**：
- 题目收集时透传分值：在构造 `item` 处，仿照 type/options 加：`if isinstance(q.get("points"), (int, float)) and 1 <= int(q["points"]) <= 100: item["points"] = int(q["points"])`
- **题数上限从 6 提到 16**：`for q in (qsrc or [])[:6]` → `[:16]`（节点自测仍发 6 题，不受影响；测验地图最多 16 题）。

### A2. 前端显示分值

**A2a. `path_app.js` `quizQHtml`**（约 632 行）：题干行改为
```js
var head = '<div class="quiz-box"><p class="q">' + (i + 1) + '. ' +
  (q.points ? '<span class="q-points">（' + q.points + ' 分）</span> ' : '') + mdRender(q.q) + '</p>';
```
**A2b. `showQuizResult` 的逐题明细**（约 773 行）：`(i + 1) + '. '` 后同样插入分值 span。
**A2c. `submitQuiz`** 提交 payload 里每题透传：`if (q.points) o.points = q.points;`（加在现有 type/options 透传旁）。
**A2d. `path_template.html`** 样式补充：`.q-points{color:var(--soft,#7a8399);font-size:12.5px;font-weight:400}`（放 quiz 相关样式区）。
**A2e.** 「自测」区与模态框的标题处若有题量提示，追加「· 满分 100 分」；没有则不动（保持最小改动）。

## Part B：测验地图

### B1. 后端：新增 `/path/quizmap` 端点 + `quizmap` 系统提示词 + `_norm_quizmap`

**B1a. `_PATH_SYSTEM["quizmap"]`**（新增键，文案如下，逐字使用）：
```
你在为一张学习地图出一套「测验地图」——按知识点逐个出题，供学习者在线作答、自动判分。

只输出一个 JSON 对象字面量，不要解释、不要把整个 JSON 包进代码围栏，格式：
{"title":"<地图标题> · 测验","questions":[{"point":"n1 环境搭建与工具链","type":"choice","q":"...","options":["...","...","...","..."],"answer":"A","explain":"...","points":10}]}

规则：
1. 覆盖：按地图的节点顺序出题，每个节点至少 1 题；节点多于 14 个时只覆盖最重要的 14 个节点。总题数 8~16。
2. 结合学习者情况：某节点「未完成」或「自测得分 < 80」的，可对该节点多出 1 题（重点考察）；已完成且得分高的节点 1 题即可。
3. 题型：选择题为主（每题 4 个选项、单选），穿插 2~4 道填空题、1~2 道简答题（简答题题干明确要求给出「思路」和「答案」两部分）。选择题正确项字母要分散；干扰项用常见错误思路设置。
4. 题目必须是「给学习者做的题」：直接考察知识点本身；不要出替他人做规划、安排日程、诊断薄弱点之类的元问题。
5. 每题必须给 answer（参考答案）、explain（解析）与 points（分值，整数）：全部题目 points 合计恰好 100 分（按题量与题型加权）。
6. 公式统一用 $...$ 的 LaTeX（前端 KaTeX 渲染），不要用 \( \) 、\[ \] 或 $$ 定界。代码用 ``` 围栏代码块完整给出，不要压成一行。
7. 数值必须自行验算正确。
8. 前端渲染能力（只用以下语法）：```语言 围栏代码块、行内 `代码`、**加粗**、$...$ 行内 LaTeX。不要用表格、图片、HTML 标签。
```

**B1b. 新增 `_norm_quizmap(obj, fallback_title)`**（放 `_norm_quiz_questions` 后）：
- title：`clip(obj.get("title"), 120)`，空则 `fallback_title + " · 测验"`。
- questions：遍历 obj["questions"]（dict 列表），每题经 `_norm_shq`（须含 `point` 透传：`item["point"] = clip(q.get("point"), 200)`，可并入 A1a 一起做——注意 `_norm_shq` 同时服务需求出题场景，point 可空）；收集至多 16 题；至少 1 题有效否则 None。
- 调 `_fix_points(qs)` 后返回 `{"title": title, "questions": qs}`。

**B1c. `/path/quizmap` handler**（放在 `/path/requiz` 之后、`/path/quiz` 之前）：
- 请求体：`{"key":"learn-path-v1-<slug>"}`（必填；必须以 `learn-path-v1-` 开头且非 `-last`，否则 400）。
- **单飞+缓存完全照抄 `/path/node` 的结构**：`gate_key = "quizmap:" + key`；先查近时缓存（TTL 同现有 `GEN_CACHE_TTL` 用法），命中直接返回缓存 body；否则加闸门，等待者共享结果；失败释放并 502。
- 读取地图：`_state_material(key)`（读不到 → 404 `{"error":"material not found"}`；无 `plan.nodes` → 422 `{"error":"plan required"}`）。
- 组装 LLM 输入（紧凑、可控长度）：
  ```json
  {"学习地图": {"title": "<topic 或 plan.title>", "summary": "<plan.summary ≤300字>",
    "nodes": [{"id":"n1","标题":"...","本质":"...","目标":["...≤3条"],"依赖":["..."],
               "情况":{"已完成":true/false,"得分":67 或 null},"要点":["nodeDetail[id].key_points ≤3条（没有则省略）"}]},
   "学习者概况": "共 11 个节点；已完成 N；自测得分：n1=67、n2=…；薄弱（<80 或未完成且已解锁）：n2、n5…"}
  ```
- 调用：`_upstream_nonempty([{system: _path_system("quizmap")}, {user: json.dumps(payload, ensure_ascii=False) + "\n请输出测验地图 JSON。"}], max_tokens=PATH_MAX_TOKENS, temperature=0.4)`；失败重试 1 次（照 requiz 的做法）；再失败 502。
- 归一：`_norm_quizmap(_json_block(out), fallback_title=地图标题)`；None → 502。
- **落库**：slug = 地图 slug + `-测验`；若 `learn-path-v1-…-测验` 已存在则依次 `-测验2`、`-测验3`…（用 `_state_read_key` 判存在，最多试 50 次）。写入键 `quiz-map-v1-<slug>`，值为 JSON 字符串：
  ```json
  {"kind":"quiz-map","sourceKey":"learn-path-v1-入门golang基础","sourceSlug":"入门golang基础",
   "title":"Go 语言基础入门：从零到能读写基础程序 · 测验","created":<unix秒>,
   "questions":[...],"attempts":[]}
  ```
  用现有 `_state_put({key: value_string})` 落盘。
- 响应：`{"ok":true,"slug":"...","title":"...","count":N}` → 也写入近时缓存 + `_gen_gate_finish`。
- `/health` 的 endpoints 列表加 `/path/quizmap`。

### B2. 前端：学习地图页「生成测验」按钮 + 资料库分组

**B2a. `path_template.html`**：在 `.topright`（含 `lib-wrap`、`restart-btn` 的容器）里、`lib-wrap` 之前插入：
```html
<button class="btn" id="quizmap-btn" type="button" hidden>生成测验</button>
```
**B2b. `path_app.js`**：
- 在 `setStage` 里（或渲染处）控制：`stage==='learning' && state.plan` 时 `$('quizmap-btn').hidden=false`，否则隐藏。
- 新增 `genQuizMap()`：确认框（`确认根据这张学习地图和你的学习情况生成一套测验？\n（按知识点出题 8~16 道，合计 100 分；生成后打开「测验地图」作答）`）→ 按钮禁用显示「生成中…（约 1-2 分钟）」→ `post('/path/quizmap', {key: storeKey()})` → 成功 `location.href = 'quiz-map.html?t=' + encodeURIComponent(r.slug)`；失败 `showError('生成测验失败：' + e.message, genQuizMap)` 并恢复按钮。绑定：在 init/绑定区与其他按钮一起 `$('quizmap-btn').addEventListener('click', genQuizMap)`。
- **资料库下拉（`libRender`）**：改为两段——「学习地图」段（现有逻辑）+「测验地图」段：扫描 `quiz-map-v1-` 前缀键（跳过墓碑；解析 JSON 串；topic=title、meta=`共 N 题` + `最近 X 分`（取 attempts 最后一条 score，有则显示）），行链接 `quiz-map.html?t=<slug>`；删除按钮同样显示（`openDelModal` 需支持完整键：给它加第三个参数 fullKey，有则删 fullKey，无则删 `STORE_PREFIX+slug`——同步改删除逻辑 `delState([fullKey || (STORE_PREFIX+slug)])` 处）。底栏「＋ 生成新的学习地图」保留。

### B3. 新页面 `learning-path/quiz-map.html`（单文件，手写，无需生成器）

参考 `path_template.html` 的视觉（同 CSS 变量、按钮/卡片样式；`min-width:1360px`），引入 `./katex/katex.min.css`、`./highlight/github.min.css` 与三个脚本（katex.min.js、contrib/auto-render.min.js、highlight.min.js —— 见 `path_template.html` 197-198/299-301 行）。

**两种模式（由 `?t=` 有无决定）**：

1. **查看/作答模式（`?t=<slug>`）**：
   - 加载：`fetch(API+'/state/all')` → `quiz-map-v1-<slug>` → 解析 → 渲染。
   - 顶栏：`← 首页`（/learn/）、标题「测验地图」、副标 `来自《<sourceTitle>》 · 共 N 题 · 满分 100 分`、`打开对应学习地图 →`（`learning-path.html?t=<sourceSlug>`）。
   - 题目区：按 `point` 分组（组头 + 组内题）。每题：`序号. （N 分） [选择题|填空题|简答题] 题干`（mdRender + KaTeX + highlight）；选择题 = 选项按钮（点选高亮）；填空 = input；简答 = textarea（≥140px，placeholder「写下你的思路和答案…」）。
   - 底部：`提交测验`（至少答一题）→ `POST /path/quiz`（node={title:地图名}；questions 透传 q/answer/type/options/points；answers）→ 结果区：总分（大号）+ 逐题 ✓/✗ + comment；提交后**回写**：重读 `quiz-map-v1-<slug>` → `attempts.push({ts,score,pass,per_question})`（保留最近 20 条）+ `lastResult` → `POST /state/put`。
   - 结果后按钮：`再做一次`（清空作答重来）。
   - 渲染函数（mdRender/renderMathIn/highlightIn/esc）从 `path_app.js` 移植精简版（保留 ``` 围栏、`## 标题`、行内代码、**加粗**、$公式$ 支持即可）。
2. **选择模式（无 `?t=`，作为首页「测验地图」卡入口）**：
   - 区块一「从学习地图生成测验」：列出所有 `learn-path-v1-*`（非 `-last`）地图（复用首页的扫描解析逻辑），每行右侧按钮 `生成测验` → `POST /path/quizmap {key}` → 生成中转圈 → 成功后跳 `quiz-map.html?t=<slug>`。
   - 区块二「已有测验地图」：列出 `quiz-map-v1-*`，行链接同查看模式。
   - 空态文案友好；服务端不可达时提示。

### B4. `home/index.html`（首页）

- **卡片 01**：眉标改 `01 · Learning Map · 学习地图`；标题改「学习地图生成器」；描述微调（…生成带依赖门控的**学习地图**…每个**知识点**配讲义、要点、易错与自测）；底行「打开学习地图 →」。
- **卡片 02（新增，紧接卡片 01）**：眉标 `02 · Quiz Map · 测验地图`；标题「测验地图生成器」；描述「从任意一张学习地图出发，按知识点与你的学习情况生成整套测验；在线作答、自动判分，结果计入学习情况。」；两行列表（生成后可在此作答 / 数据在服务端）；路径文本 `/diagram-design/learning-path/quiz-map.html`；链接 href 同；底行「打开测验地图 →」。
- **资料库区块**：渲染分两组——`学习地图`（现有 items，标题下）与 `测验地图`（新扫描 `quiz-map-v1-`：行显示 title、meta = `共 N 题 · 最近 X 分 · 来自《地图名》`（最近分无则省略），链接 `/diagram-design/learning-path/quiz-map.html?t=<slug>`）。两组各带小计数（如「学习地图 · 2」）。空组显示占位文案。总计数保留。

### B5. 重新生成 `learning-path.html`

改完 `path_template.html` 后在 `learning-path/` 目录执行 `python3 gen_path_page.py`（产物应为 `learning-path.html`，确认字节数变化并把新增 `quizmap-btn`、`q-points` 样式包含进去）。

## 验证（必须逐条贴证据）

1. `python3 -m py_compile study-assistant/study_assistant.py` → OK。
2. `node --check learning-path/path_app.js` → OK。
3. `python3 -c` 导入模块跑：`_fix_points([{'points':10}]*5+[{'points':20}])` ≡ 合计 100；`_fix_points` 对空缺字段平均分配；`_norm_shq` 透传 points/point。贴输出。
4. grep 自检：
   - `grep -c "quizmap" study-assistant/study_assistant.py` ≥ 6（提示词+函数+handler+health）。
   - `grep -c "q-points" learning-path/path_template.html learning-path/path_app.js` 各 ≥1。
   - `grep -c "quizmap-btn" learning-path/learning-path.html` ≥1（重生成后）。
   - `grep -c "quiz-map-v1" home/index.html learning-path/path_app.js` 各 ≥1。
5. `git diff --stat`：仅允许 6 个文件（3 个后端/前端 + learning-path.html + quiz-map.html 新增 + home/index.html）。**不要部署、不要 git commit。**

## 风险与约定

- 严禁改动 `/path/intake|research|plan|node|requiz` 的既有单飞语义与字段（除 A1g 的上限 6→16）。
- 所有新文本用中文；代码风格跟现有文件一致（var/function 风格、esc()、mock 无）。
- `quiz-map.html` 里 API 基址写法与 path_app.js 一致（`location.protocol + '//' + location.hostname + ':8101'`）。
- 若发现任何「旧」文本与文档不符：停下来，报告位置，不要自行发挥。

## Part C（用户中途追加）：单元类型编号 L=学习 / T=测验

编号规则（显示层）：**学习单元 = L1、L2…**；**测验单元 = T1、T2…**。内部 id / 数据键（`n1`、nodeDetail、nodeState、deps）一律不动，只改展示文本。

**C1. 学习地图页（path_app.js）**：新增 `dispId(id){return String(id).replace(/^n(\d+)$/, 'L$1');}`。先 `grep -n "'n'\|+ id\|NODE\|deps\|可学习\|已解锁" learning-path/path_app.js` 人工审计所有把节点 id 拼进可见文本的位置（至少覆盖：图卡片编号徽标、面板头 `NODE n1`、节点详情眉标、依赖/前置提示、「可学习/锁定」提示、自测模态框标题中含 id 处），逐一改用 `dispId(id)`；结构用途（DOM id、class、数据键、href 参数）保持原样。
**C2. 测验地图（quiz-map.html）**：每题序号显示 `T1、T2…`（按顺序，与「（N 分）」并存：`T2 ·（10 分） 题干…`）；引用来源单元处用 `L<编号> <标题>`。
**C3. quizmap 系统提示词**：`point` 示例改为 `"point":"L1 环境搭建与工具链"`，并在规则中注明：引用地图单元时用「L<编号> <标题>」形式（编号与「学习地图」页展示一致）。
**C4. 验证**：`grep -c "dispId" learning-path/path_app.js` ≥2；`grep -c "T1\|编号" learning-path/quiz-map.html` ≥1（实现自定即可）；learning-path.html 重生成后含 dispId 逻辑；截图目检节点显示为 L 编号。
