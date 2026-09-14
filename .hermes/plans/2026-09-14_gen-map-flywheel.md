# 自学社 · 基础轮规格：固定 user path + 一键生成 + 知识地图接回（给 pi 的实现规格）

日期：2026-09-14　实现：pi　验证+部署：Hermes
**改完不部署、不 commit；服务端文件（study-assistant/*.py）一律不要动**（Hermes 已改造完成）。

改的文件范围：`learning-path/path_app.js`、`learning-path/path_template.html`（如需）、`learning-path/quiz-map.html`、`home/index.html`、`knowledge-map/template.html`、`knowledge-map/gen_math_map.py`（如需）。
产物要重建：`learning-path/learning-path.html`、`knowledge-map/math-knowledge-map.html` + `.json`。
检查要求：每个改过的 JS 用 `node --check` 校验（内联脚本按上一轮做法抽出为临时 .js 再 check）；`python3 knowledge-map/gen_math_map.py` 必须成功；按各 Part 的 grep 断言自检；最后输出改动文件清单 + 行数统计 + 检查结果。

---

## Part K · 固定 user path（最高优先，先做）

背景：明天做多用户；今天先把「用户路径」立起来：**所有状态键统一加固定前缀 `u0/`**，将来把常量换成每用户/每浏览器 id 即完成迁移。

键格式 `u0/<业务键>`：
- `u0/learn-path-v1-<slug>`、`u0/learn-ai-v1-<slug>`、`u0/learn-path-v1-last`
- `u0/quiz-map-v1-<slug>`
- `u0/knowledge-map-v1-marks`、`u0/knowledge-map-ai-v1-<unitId>`

要求：
1. 每个页面顶部定义常量：`var USER_PATH = 'u0/';`（注释：多用户口子——固定用户路径，将来替换为每用户 id）。**所有键的构造必须经过它**。
2. 读取：`/state/all` 的 entries 键都带 `u0/`；做前缀匹配/列表扫描前先剥掉 `USER_PATH` 再按原逻辑；同时容忍无前缀旧键（不要崩）。
3. 写入：一律写带 `u0/` 的键。
4. `path_app.js`：`?t=` 语义不变（slug 仍是业务后缀，不含 `u0/`）；`serverLoad` 的 `?t=` 匹配先剥 `USER_PATH`。
5. `quiz-map.html`：「生成测验」按钮发给 `/path/quizmap` 的 `key` 必须带 `u0/`；本卷写入键带 `u0/`。
6. `home/index.html`：资料库列表扫描先剥 `USER_PATH`；删除按钮发送的键 = 实际存储键（带前缀）；`learn-path-v1-last` 指针读写带前缀。
7. 服务端已做通用「user 段 + 业务键」解析，前端只需传带前缀的键，**不要**在服务器语义里写死 u0。

---

## Part H · 一键生成全部节点（学习地图页）

文件：`learning-path/path_app.js`（工具栏在 path_template.html 里已有「生成测验」按钮）。
1. 工具栏加按钮 `id="gen-all-btn"`，文案「一键生成全部节点」。
2. 缺失判定：`state.plan.nodes` 中 `state.nodeDetail[id]` 为空的节点——**含未解锁节点**。
3. 点击 = 顺序批量生成：逐节点调 `/path/node`（参数沿用现有单节点生成请求：`key: storeKey()`、node、spec 等；尽量复用现有请求函数）。每完成一个：`state.nodeDetail[id]=detail` → `save()` → 按钮文案 `生成中 i/N` → 该卡片头部走既有「生成中…」态（逐卡切换）。全部完成：按钮短暂显示「已全部生成 ✓」再复原。
4. 运行中再点按钮 = 暂停：当前节点完成后停止，清 pending，复原按钮。
5. pending 持久化：`state.pending = {kind:'nodes', nid:null, at:Date.now(), remaining:[未完成id...]}`；每完成一个更新 remaining + `save()`；结束时置 null。
6. `resumeIfPending()` 增加 `kind==='nodes'` 分支：剔除已在 nodeDetail 里的 id 后**继续**批量（复用同一流程）；恢复提示条沿用 `resume-bar` 既有文案习惯。
7. 失败：单节点失败 → 留在 remaining，继续下一个；全部结束后若有失败，按钮显示「生成完成（N 个失败，可重试）」停 4 秒复原；再点 = 重试剩余。
8. 批量进行中，单节点触发生成（点卡/AI 辅助触发的生成）忽略并轻提示「批量生成进行中」。

---

## Part I · 知识地图接回（服务端化 + 首页入口）

背景：老页面断档；数据 `knowledge-map/math_data.py` 已由 Hermes 改成新编号 **L/N/E/F/G/S**（勿改数据文件）。
文件：`knowledge-map/template.html`（页面本体，全部 JS 内嵌）、`home/index.html`。
1. `template.html` 存储迁移（localStorage → 服务端，唯一数据源）：
   - 四态标记：原 `KEY='math-map-v1'` → 服务端键 `u0/knowledge-map-v1-marks`（结构不变：`{id:{s:'todo|doing|done|again'}}`）。启动时 GET `/state/all` 一次取该键；每次标记点击沿用 `save()` 调用点，改成防抖 300ms 的 `/state/put`（`{entries:{[key]: jsonString}}`，与学习地图页 `serverSave` 同一约定）。
   - 每单元 AI 对话：原 `math-map-ai-<id>` → `u0/knowledge-map-ai-v1-<id>`（slim 结构不变）。同一份 load/save 改造：`loadHist(id)` 从 entries 取，流式结束/后台压缩后保存该单元键（防抖）。
   - 启动顺序：先 fetch 状态 → 再初始化 UI（marks/标签页/AI 面板）；fetch 失败重试一次，再失败用空状态启动并在页面显眼处提示「服务端连接失败：标记与对话本次不可用」。
   - 标签页记忆 TKEY 可继续用 localStorage（仅 UI 偏好，非业务数据）。**除此之外不得有 localStorage 业务存取**（grep 产物中 `math-map-v1`、`math-map-ai` 必须消失）。
   - 末尾「学习资料库 · 动态扫描」整段（扫 localStorage 的第二段 script）**删除**；头部 `#lib-btn`「学习资料库」按钮改为**跳转固定入口**（点击 → `location.protocol + '//' + location.hostname + ':8100/learn/'`），不再做任何本地扫描（popover 相关绑定一并清理即可）。
2. 页脚「N 个知识点 · 进度实时同步到服务端，换设备自动恢复」保留（迁移后为真）。
3. 重建：`python3 knowledge-map/gen_math_map.py`；grep 产物断言：`data-tab` 含 L/N/E/F/G/S + linalg；`node-id">` 含 N1/E1/F1/G1/S1；无 `math-map-v1`（TKEY 除外）。
4. `home/index.html` 接线：
   - `.grid` 加第三张工具卡（`<a class="tool wide" ...>`；新增样式 `.tool.wide{grid-column:1/-1}`）：「03 · Knowledge Map · 知识地图」，标题「数学知识地图」，描述：32 个知识点（初中数学到线性代数 7 天冲刺），含四态标记与单元级 AI 辅助；path 显示 `/diagram-design/learning-path/junior-math-linalg.html`；go「打开知识地图 →」。
   - 「学习资料库」区块静态加「常驻资料」小标题 + 一条固定条目（同链接，说明「初中数学 → 线性代数 · 32 知识点 · 常驻」，样式用现有 `.lrow`）。
5. 部署映射（Hermes 做）：产物将部署为 `zixueshe-web/diagram-design/learning-path/junior-math-linalg.html`。pi 不用管部署。

---

## Part J · 飞轮闭环（测验诊断缺漏 + 细化学习地图）

文件：`learning-path/quiz-map.html`、`learning-path/path_app.js`。
服务端契约（已实现，直接调用）：
- `POST /path/gaps`：body `{items:[{unit,q,mine,correct,explain,ok}], score}` → `{summary, gaps:[{unit,points:[...],advice}]}`；items = **失分题**（ok=false / 简答缺「思路」的）。
- `POST /path/refine`：body `{key:<学习地图键 u0/learn-path-v1-...>, spec, plan, weaknesses:[{nid,title,reason,points:[...]}]}` → `{ok, added, units:[{for,title}], plan}`；plan 已更新并写穿服务端。**key 必须是学习地图键**。

quiz-map.html：
1. 结果页（判分后与重看历史 lastResult 时）加按钮 `id="gaps-btn"`「AI 诊断缺漏」：收集本卷失分题 → POST /path/gaps → 展示诊断块（summary + 每条 gaps：unit + points 列表 + advice）；把结果存进本卷 state（`d.gaps=d.gaps||resp; d.gapsAt=Date.now()` 实际用 `d.gaps=resp` + 保存）。再点 = 重新诊断覆盖。按钮态：进行中「诊断中…」禁用。
2. 按钮 `id="refine-btn"`「按薄弱点细化学习地图」：前置 = 有失分数据（没有则先自动跑诊断）；组装 weaknesses：按单元聚合失分题——先 GET `/state/all` 取对应学习地图（键 = `u0/learn-path-v1-<本卷 sourceSlug>`）的 `plan`；每道题自带 `point` 字段（形如 `"L3 四种命题与逆否等价"`；服务端 `_norm_shq` 已保留）：解析开头的 `L<k>` → 映射 `plan.nodes[k-1].id`（plan.nodes 顺序 = 编号顺序，n1..nN；匹配失败跳过该单元）；reason=错题摘要（≤500 字），points=诊断的缺漏点。POST /path/refine → 成功显示「已在学习地图追加 N 个细化单元」+ 链接按钮「去学习地图 →」（`learning-path.html?t=<sourceSlug>`）。失败/进行中要有按钮态。
3. path_app.js 小增强：卡片自测 `lastResult.score < 60` 时，卡内（测验选项卡下方）显示小按钮「按薄弱点细化」：调用同一 /path/refine（key=storeKey()，weaknesses=[该节点]，reason=lastResult.feedback + per_question 摘要，points=空）→ 成功后提示「已追加 N 个细化单元（已按依赖关系插入学习地图）」并把返回的 plan 合并进 state + save + 重渲染。（服务端 `_resolve_refine_parent` 容错把 L 编号/标题统一归一为内部 id，防 LLM 回填 L 样式导致父节点关联丢失。）

---

## 自检清单（pi 完成前必须跑）
1. `node --check`：path_app.js 与所有抽出的内联脚本。
2. `python3 knowledge-map/gen_math_map.py` 成功 + Part I 的 grep 断言。
3. grep 断言：`USER_PATH` 出现在 4 个页面文件；`u0/` 键构造齐；`gen-all-btn`/`gaps-btn`/`refine-btn` 存在；产物 `learning-path.html` 重建成功。
4. 输出：改动文件清单 + 行数 + 各检查的实际命令与输出摘要；**不要** git commit / 不要部署 / 不要动 study-assistant。改完把重建产物也留在仓库里。
