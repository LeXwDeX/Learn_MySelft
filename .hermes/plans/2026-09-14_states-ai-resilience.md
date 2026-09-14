# 自学社 · 本轮设计：单元状态选项 + 单元 AI 辅助 + 生成防中断（2026-09-14）

三个部分相互独立，按 A → B → C 顺序实现。**只改三个文件**：
- `learning-path/path_app.js`（前端逻辑）
- `learning-path/path_template.html`（模板；改完必须重新生成页面）
- `study-assistant/study_assistant.py`（后端；只有 Part C 的写穿）

**不要动**：`home/index.html`（已由 Hermes 单独改好并部署：两卡并列）、`quiz-map.html`、`state_sync.js`；`learning-path.html` 不要手改（由生成器重建）。

## 通用纪律
- 页面零 localStorage；一切持久化走现有 `save()` / `serverLoad()`（服务端 `/state/*`）。
- 渲染沿用现有工具：`mdRender` / `renderMathIn` / `highlightIn` / `bindAutoGrow` / `esc`。
- 改完 `path_template.html` 后，必须运行 `python3 learning-path/gen_path_page.py` 重新生成 `learning-path.html`。
- 不引入新依赖；纯原生 ES5 风格 JS，与现有代码保持一致。
- **不要部署、不要 commit**（Hermes 负责部署、E2E 与提交）。

---

## Part A：单元状态选项（学习地图）

### A1 数据
- `nodeState[nid]` 增加字段 `mark`：`'none' | 'learning' | 'mastered' | 'review'`（默认 `'none'`；显示文案：未学 / 学习中 / 已掌握 / 需复习）。
- 复用现有 `save()`（`nodeState` 已在 payload 中，无需改结构）。mark 与 `completed`/解锁门控**相互独立**，不改变任何门控逻辑。

### A2 节点卡片（renderPlan 渲染的卡片）
- 每张卡片底部加一行：左侧四个迷你状态按钮 `[未学][学习中][已掌握][需复习]`（单选；当前 `mark` 高亮；点击 → 设置 `nodeState[nid].mark` → `save()` → 就地刷新卡片与右侧面板）；
- 同行右侧一个「AI 辅助」迷你按钮 → 点击：选中该节点（`selectNode(id)`）并把右侧面板切到「AI 辅助」视图（Part B）。
- 按钮点击必须 `stopPropagation`，不要触发卡片其它点击行为；**锁定节点也可标记**（mark 与门控无关）。
- 现有状态徽章（锁定 / 可学习 / 已完成 / 得分）**保持不动**。

### A3 详情面板（renderNodeDetail）
- 面板标题下加一行「学习状态」：四个同款按钮（比卡片上略大），与卡片上的状态双向同步。
- 锁定节点的面板（现有「先完成以下前置节点」门控提示）**同样显示**这一行（允许标记）。

### A4 工具栏：只看需复习
- 工具栏（与「生成测验」同一排，`.toolbar-inner` 内）加切换按钮「只看需复习 (N)」：激活时左侧节点列表只显示 `mark === 'review'` 的节点；无结果时显示提示「没有标记为『需复习』的单元」。
- N = 当前 review 数，随标记实时更新；激活态有明显样式（参考现有按钮的选中态写法）。
- 过滤是纯显示层：不改数据、不改门控、不影响右侧面板当前选中。

---

## Part B：单元 AI 辅助（每单元独立对话）

### B1 UI（右侧面板）
- 面板标题区下加分段切换：`[学习材料] [AI 辅助]`（默认「学习材料」）。锁定节点也显示这个切换（材料视图仍显示门控提示；AI 视图可正常聊天）。
- 「AI 辅助」视图内容：
  - 消息区（滚动）：user 在右 / assistant 在左的气泡；assistant 内容用 `mdRender` + `renderMathIn` + `highlightIn` 渲染；流式输出时就地刷新；等待首字显示「思考中…」。
  - 输入区：多行 textarea（复用 `bindAutoGrow`）+「发送」按钮；Enter 发送 / Shift+Enter 换行；流式期间禁用发送。
  - 固定小字提示：「AI 知道本单元内容，会引导你思考、不会直接给答案。」
- 每单元独立对话：切换节点载入该节点历史；无历史显示空态文案 + 三条静态建议问题（如：讲讲本单元的重点 / 出个小题目考我 / 我哪里最容易出错？），点击即发送。

### B2 请求（复用现有 `/ask` 流式 SSE）
- `POST ${API}/ask`，body：`{ unit: {...}, question, history: [...] }`
  - `unit` 字段映射（服务端 `build_system` 使用）：`unit_id = dispId(nid)`（如 "L1"）；`unit_title = 节点 title`；`domain = state.topic`；`essence = 节点 essence`；
  - `musts`：`nodeDetail[nid].key_points`（已生成且非空时），否则取 plan 节点的 `objectives`；
  - `traps`：`nodeDetail[nid].traps` 或空；
  - `quizzes`：`nodeDetail[nid].quiz.questions` 的 `{q, answer}` 两字段（各截断，最多 6 题；未生成则不传）。
  - `history`：该节点最近 16 条 `{role, content}`（不含本次 question）；发送时新问题不进 history。
- 流式读取完全参照 `knowledge-map/ai_panel.js` 的既有模式（fetch + `getReader()` + 按 `\n` 分行 + `data:` payload `{delta}`/`{done}`）；出错显示错误气泡（含 HTTP code）。
- **后端无需改动**：`SYSTEM_TMPL` 已含「引导式学习，绝不主动给答案」纪律（rule 1）。

### B3 持久化（服务端）
- 新 state key：`learn-ai-v1-<slug>`（slug 同材料键规则），值 = JSON 字符串：`{ "n1": [{role, content}, ...], ... }`。
- 每条消息截断 4000 字；每节点只保留最近 60 条。
- 加载：`serverLoad()` 里一并取（`/state/all` 全量返回，筛 `learn-ai-v1-` + 当前 slug），存到内存（如 `state.aiHist`）。
- 保存：发送时把 user 消息加入并立即 `putState` 存一次；流完成后更新 assistant 消息再存一次。
- 与材料 `save()` 互不干扰（两个 key 分开）。

---

## Part C：生成防中断（服务端跑完 + 自动恢复）

背景：现在 `/path/research|plan|node` 的生成结果只有「页面收到响应后自己保存」；用户中途关页面 → 结果丢。改为：**服务端完成即写穿落库；页面重开自动取回**。

### C1 服务端写穿（study_assistant.py）
- `/path/research` 成功后：读材料（`_state_read_key(mkey)`，解析失败则跳过）→ 合并 `material.queries / material.sources / material.brief` → `self._state_put({mkey: 新 JSON})` 写回。
- `/path/plan` 成功后：合并 `material.plan = plan`（归一化后的 `{title, nodes}`）+ `material.stage = 'learning'` → 写回。
- `/path/node` 成功后：合并 `material.nodeDetail[node_id] = detail` → 写回。
- 实现：抽一个模块内小函数（如 `_state_merge_put(mkey, patch)`：读→dict 合并→写）供三处复用；**写穿失败只打印 warning，不影响响应照发**。
- 竞争说明：与客户端 save() 的竞争可接受（内容一致、幂等）；现有读取侧（`_state_stage_result` / `_state_node_detail`）无需改动。

### C2 客户端 pending 标记与自动恢复（path_app.js）
- `state.pending = {kind: 'research'|'plan'|'node', nid?: string, at: number}`；`save()` payload 增加 `pending` 字段；`serverLoad()` 恢复它。
- 触发点（发请求前设置 + save）：
  - `startResearch()` 发 `/path/research` 前 → `{kind:'research'}`；链到 plan 之前 → `{kind:'plan'}`；
  - node 生成（`selectNode` 内 `/path/node` 前）→ `{kind:'node', nid:id}`。
  - 各自成功回调 → `pending=null` + `save()`。
- 自动恢复（`serverLoad()` 完成后调用 `resumeIfPending()`）：
  - 条件：`pending` 存在 && `at` 距现在 < 24h；
  - 若对应结果已存在（research→`state.brief` 或 `state.plan`；plan→`state.plan`；node→`state.nodeDetail[nid]`）→ 仅清 `pending` + `save()`，正常渲染；
  - 否则：恢复对应阶段视图（`setStage`）+ 顶部提示条「上次的生成已在服务端继续，正在取回结果…」→ 重放：
    - research → 调 `startResearch()`（走 research+plan 链）；
    - plan → 把 plan 部分抽成 `continuePlan()` 复用（发 `/path/plan` 链）；
    - node → `selectNode(nid)`。
  - 重放遇到 502「仍在生成中」→ 60 秒后自动重试（最多 3 次）；仍失败 → 收起提示条、保留 pending（下次刷新再试），显示常规错误按钮。
  - 成功 → `pending=null` + `save()`，正常渲染。
- 提示条复用现有提示样式（可复用 `research-status` 元素样式），不要新增大块样式。

---

## Part D：小测验「展开/收起」+「查看答案」（学习地图 · 节点详情内）

背景：老版知识地图有「单独展开小测验 + 打开测验答案」；当前新版自测整段直出、且没有查看答案入口。补上：

### D1 折叠
- 自测区块标题行改为可点击的折叠开关：`自测（N 题 · 满分 100 分）` 行尾带 ▾/▸；点击切换题目主体显示/隐藏；**默认展开**；折叠状态仅前端内存，不持久化。

### D2 查看答案
- 自测标题行右侧加小按钮「查看答案」/「收起答案」（低调按钮样式）：
  - 激活时：每题下方追加答案块——选择题显示 `正确答案：B`（取 `q.answer`）；填空/简答显示 `参考答案：` + `mdRender(q.answer)`；浅底小字（新 class，勿与现有 `.result` 混用）。
  - 未作答 / 已通过 / 结果页 状态下均可用；提交后的「自测结果」现有展示保持不变。
- 插入的答案文字同样走 `renderMathIn` / `highlightIn`。

---

## Part E：测验地图专属化（按真实学习数据出题）

用户要求：【测验地图生成】依据 **学习进度 + 学员答题答案 + 错误情况 + 思路情况** 生成**专属**测验。

### E1 前端（path_app.js）：留存作答
- `submitQuiz` 结果回调里，除现有 `st.score`、`st.lastResult` 外追加：`st.lastAnswers = answers`（每题 `String(...)` 截 600 字，最多 16 题）。其余不动。

### E2 服务端（study_assistant.py · `/path/quizmap` handler）：payload 注入
- 逐节点构建 payload 时（现有 out_nodes 循环），按节点数据追加（有数据才加）：
  - `"最近自测"`：`{"得分": st.score, "逐题": [{"i": idx, "正确": ok, "点评": clip(comment, 300)}]}`（逐题最多 12 条）；
  - `"作答摘录"`：`{"<题号>": 用户答案前 500 字}`（仅非空；最多 12 条）。
  - 未测节点：`"最近自测": None`。
- learner 情况行更新：每节点标注「已测/未测、分数、错题数」。

### E3 服务端：quizmap 提示词升级
- 在现有 quizmap 提示词的规则之后**追加**（编号续接，不删现有规则）：
  1. 这是给**同一学员**的**专属**测验：**优先针对「最近自测」判错的题所在的考点/误区出新题**（同一误区换角度再考）；其次选未测且已解锁的节点；
  2. 参考「作答摘录」反映的水平与思路（如简答题思路是否完整）调整深度：答得浅的考点加深检验；高得分且无错题的考点只少量抽查；
  3. 保持现有 JSON 结构与出题规模不变（8~16 题、合计 100 分、每题标分值、题型结构与分组规则照旧）。
- 定位方式：读代码找 `_path_system("quizmap")` 对应文本（现有含「L1 环境搭建与工具链」示例的那段）。

---

## Part F（改版·用户当晚追加）：单元内容选项卡化 + AI 辅助升级为「交互式学习」

**用户原话要点**：学习正文等内容 + 测验 → 放在**选项卡**里面（就在 L1/L2 这类单元的视图里）；卡片有状态标记（Part A）且可选择「**AI 辅助**」打开；打开后用户可**交互式学习**该知识点（单元上下文已注入；即早期「每单元独立对话 + 大上下文」设计）。

### F1 学习材料视图内部选项卡【学习资料】【测验】（调整 Part D 的折叠方案）
- `renderNodeDetail` 的「学习材料」视图（`panelView='material'`）内容改为两个内部选项卡：
  - **【学习资料】**：学习正文 + 要点 + 例子 + 易错点（即现「材料」内容）。
  - **【测验】**：全部自测题（quizQHtml）+ **查看答案**（Part D2 答案块保留在本 tab）+ 提交自测 + 放大答题 +（已测时）上次结果与「换新题，再试一次」。
- **两个 tab 的内容同时存在于 DOM**，切换仅控制显示/隐藏（display），**不得丢失用户已勾选选项 / 已输入文本**（保留现有 `choiceAns`、`syncChoiceRadios`、`bindAutoGrow` 机制，ID 不变）。
- 默认打开【学习资料】；**提交自测后结果渲染在【测验】tab 内并自动切过去**；「完成本节点并解锁下一节点」等操作按钮也放【测验】tab 底部。
- **取消 Part D1 的自测折叠开关**（选项卡替代折叠）；Part D2 查看答案保留但位置移到【测验】tab 的标题行附近。
- 选项卡容器 class 用新名（如 `mat-tab`），**不要与现有 `.pv-tab`（学习材料/AI 辅助 分段）混淆**；视觉风格与现有 `.pv-tab` 一致（UI kit）。

### F2 AI 辅助 = 交互式学习（强化 Part B）
- 入口不变：卡片 `.ai-mini`「AI 辅助」按钮 + 面板分段切换到 `panelView='ai'`。
- AI 视图头部文案改为：**「AI 辅助 · 交互式学习 —— 会讲解、追问、出小题检验你；不会直接给答案。」**（调整现 `panelHead(..., 'NODE ' + dispId(id) + ' · AI 辅助')` 附近文案；空态三条建议问题保留、点击即发送。）
- **上下文强化（让 AI 能就正文交互讲解）**：
  - 前端：`/ask` 的 `unit` 增加 `notes` 字段 = `nodeDetail[nid].study_notes`（截断 6000 字；未生成则不传）。
  - 服务端：`build_system` 的 unit 组装（**注意有两处 dict 组装都要加**）新增 `notes` 处理，按现有 `_block(...)` 同款模式生成条件块（空则不显示），在必会/陷阱/自测块附近加入；对应 `SYSTEM_TMPL` 增占位（如 `{notes_block}`），内容形如「本单元学习正文（节选，可用于讲解与追问）：\n{notes}」。
- 其余（B1 气泡/流式/发送交互、B3 服务端历史 `learn-ai-v1-<slug>`）保持不变。

### F3 不变项
- Part A（状态标记 + 只看需复习）、Part C（防中断）、Part E（专属测验后端）不因 F 改动；四态文案保持：未学 / 学习中 / 已掌握 / 需复习。
- 仍**不部署、不 commit**；改完 `path_template.html` 后重建 `learning-path.html`；同步更新纯函数单测。

---

## Part G（最高优先级·用户定稿）：核心内容进卡片 + 右栏纯 Agent（改正 Part F 的放置错误）

### G0 设计哲学（必读，先对哲学再动手）
- **L/T 卡片 = 主角**：占据主视觉与视觉中心，承载全部核心内容（学习正文 + 测验）。
- **Agent = 辅助引导**：右侧窄区（~420px）只做对话引导（学习地图：引导式沟通/交互式学习；测验地图：评分、评估、标缺漏）。
- **核心内容一律不得放进右侧区域。**（Part F 把选项卡做进了右栏，本 Part 就是把它改正。）

### G1 选项卡搬进卡片（改 F1 的放置位置）
- 【学习资料】【测验】两个选项卡（`mat-tab` 类名保留）随内容区**从右侧面板挪进卡片**：点卡片即在卡内展开。
- 卡片结构：卡头（编号 Lx + 标题 + 状态标记 + 四态按钮 + 「AI 辅助」按钮）→ 卡体（选项卡行）→ 选项卡内容（正文 / 测验：题目+分值+作答+提交+查看答案）。
- **手风琴**：同时只展开一张卡，点另一张自动收起，再点收起；锁定卡不可展开；选中卡保持高亮。
- 样式沿用 UI kit（间距/圆角/边框），卡内正文区可比右栏更高更宽（内容优先）。

### G2 生成与恢复
- 点未生成的卡：卡内显示生成中（loading）；调 `/path/node`；写穿 `/state/put`；完成后卡内直接渲染正文。
- `resumeIfPending()` 恢复（pending 重放）后，**自动展开对应的卡**。
- 生成中禁用该卡重复点击（防重复请求）。

### G3 测验交互（卡内，全部保留）
- 每题：题面 + 分值 + 选项/作答输入 + 「查看答案」展开参考答案与解析；「提交测验」→ 得分反馈；不通过→「换一批新题」（requiz）；通过→解锁下一节点。
- 选择题可点选；老题无 `points` 时按 `evenPts` 均分显示。提交/判分/回写逻辑不改。
- **选择器作用域**：所有 `document.getElementById` 级查询改为从卡片元素向下查（卡内选项卡可能出现多组同名元素），避免串卡。

### G4 右侧面板 = 纯 Agent 区
- 从右侧面板移除：学习正文/测验内容渲染、NODE 信息块、大号四态按钮行；保留：AI 对话（气泡、流式、输入、历史 `learn-ai-v1-<slug>`）、`/ask` 的 unit 上下文注入、空态建议问题、「AI 辅助 · 交互式学习」文案。
- 面板头部：紧凑显示当前单元（如「L3 · 切片」）；未选中时显示引导语。
- 点卡片「AI 辅助」按钮：右栏切到该单元上下文（若未生成先触发生成）；**不**把正文搬进右区。

### G5 提示词对象级口径（Hermes 负责改 study_assistant.py，pi 不碰服务端）
- intake/出题（node/requiz/quizmap）提示词按「**大模型=老师、用户=学生**」改写：一切问句与题目必须面向学生本人；**禁止面向老师/规划者的问题**（排期、每天几小时、替他人规划、诊断、课程设计）。判别标准=面向对象，不是关键词。

### G6 测试隔离（Hermes 负责）
- E2E 一律跑独立实例：`STATE_DIR=/opt/study-assistant/state-e2e PORT=8111`（代码已支持 env）；绝不写生产状态库。

---

## 验证要求（pi 自测，全部列出实际输出）
1. `python3 -m py_compile study-assistant/study_assistant.py`
2. `node --check learning-path/path_app.js`
3. 运行 `python3 learning-path/gen_path_page.py` 重新生成 `learning-path.html`，并 grep 确认新关键字出现在产物里（如状态按钮 class、`pv-tab`、`resumeIfPending`、查看答案、`lastAnswers`、材料内选项卡（如 `mat-tab`）、「交互式学习」文案）。
4. 纯函数用 `node -e` 小程序单测（mark 归一、pending 判断、history 截断），输出结果。
5. 卡内化自检（新增）：grep 产物确认「学习资料/测验」选项卡位于卡片构建路径（不是右栏面板构建函数）；右栏无正文/测验渲染调用；恢复后有自动展开代码。
6. 交付清单：改动文件 + `git diff --stat` + 以上命令实际输出 + 已知遗留。
