# 前端 UI Kit

UI Kit 为首页、学习路径、测验地图和测验窗口提供共享样式与 DOM 控件。源文件位于 `shared/uikit/` 和 `shared/ui.js`。构建后样式输出到 `shared/ui.css`，部署路径为 `/learn/assets/ui.css`。

页面 CSS 只描述该页面独有的布局与组件。共享颜色、控件、导航和状态提示由 UI Kit 提供。

## 设计 tokens

| 类别 | Token | 当前值或用途 |
| --- | --- | --- |
| 背景 | `--learn-paper`, `--learn-surface` | `#f5f5f5` 页面背景；`#fff` 卡片和控件表面。 |
| 文字 | `--learn-ink`, `--learn-muted` | `#2d3142` 正文；`#667085` 次要文字。 |
| 边框 | `--learn-border` | `#dce1e8` 分隔线和控件边框。 |
| 强调 | `--learn-accent`, `--learn-accent-tint` | `#c74f20` 主操作；`#fff1e9` 强调背景。 |
| 状态色底与边框 | `--learn-danger-tint`, `--learn-success-tint`, `--learn-danger-border` | 错误/危险、成功的浅色底，以及危险操作边框。 |
| 状态 | `--learn-success`, `--learn-danger` | `#2f7d5d` 成功；`#b42318` 错误。 |
| 学习层级 | `--learn-level-1` 至 `--learn-level-4` | `#245b83`、`#3f7eaa`、`#6ea1c6`、`#a0c1d9`。保留给需要层级色的兼容视图。正文工作区目录使用 L 层级编号，不再使用卡片四色边框。 |
| 圆角 | `--learn-radius`, `--learn-radius-control` | 卡片 `8px`；控件 `6px`。 |
| 间距 | `--learn-space-1/2/3/4/6` | 分别为 `4/8/12/16/24px`。 |
| 字体 | `--learn-font`, `--learn-mono`, `--learn-serif` | 系统无衬线、等宽和衬线字体栈。 |
| 焦点 | `--learn-focus` | 键盘焦点环阴影。控件使用可见轮廓和偏移。 |

历史别名（如 `--paper`、`--ink`、`--accent`、`--rule`、`--sans`）仍映射到新 token，供页面样式渐进迁移。新样式优先使用 `--learn-*` 名称。

## 六类状态与迁移边界

六类状态分别表示学习者自选标记、页面访问权、测验结果、内容可用性、后台工作和数据保存情况。页面应分开呈现，不用单个徽标或按钮同时表达两种状态。以下约定描述状态职责；它不声明新的前端 API。

| 状态维度 | 来源与允许操作 | 反馈位置 | 恢复与退出规则 |
| --- | --- | --- | --- |
| 学习标记 | 学习者为单元选择一个标记：`未学`、`学习中`、`已掌握`、`需复习`。四项互斥；`已掌握` 是自我标记。 | 单元的标记控件；当前选择用文字和非颜色线索表示。 | 重选任一标记即可切换；该标记不改变成绩、节点完成状态或下游解锁。过滤和刷新不得把标记当成测验结果。 |
| 节点访问 | 默认依赖已完成的前置节点。`nodeAccess` 可对单个节点记录 `locked` 或 `unlocked` 覆盖；覆盖优先于默认依赖。 | 前置未完成时说明缺少的前置条件；手动锁定时说明该节点被手动锁定。正文、AI 辅助和自测入口使用同一访问判断。 | 每次切换都须确认当前密码，只改变指定节点的访问覆盖；不切换当前节点，也不改四态标记、分数、完成事实或下游解锁。手动锁定与前置锁分别说明原因。重新锁定不删除正文、历史或草稿。访问控制不构成正文保密或缓存加密。 |
| 测验结果与完成 | 分数来自服务端已签发题集的提交结果；完成状态沿用通过门槛及现有显式完成操作。 | 测验窗口显示逐题批改与分数；单元显示最近结果和完成状态。 | 失败后保留作答与历史，供重试和复习；通过不应由颜色或手动“已掌握”标记代替。关闭测验后回到原单元。 |
| 材料就绪 | 由单元材料及其生成结果决定，例如未生成、生成中、可学习、失败。 | 反馈贴近对应单元内容；只在任务进行或失败时提供相应继续/重试动作。 | 已有正文在动画失败时仍可读；重试只重试对应内容。生成成功只表示材料可用，不表示已学会或节点已完成。 |
| 任务执行 | 由服务端任务回执提供排队、运行、成功、失败、中断或未确认状态。 | 跨页任务在任务入口显示简短进度和返回资料的操作；单元内显示必要进度。技术日志只从明确的诊断入口打开。 | 恢复已有任务与创建新任务是不同动作。未确认结果不称为失败；成功结果由资料或测验承接，不持续显示开发诊断详情。重试失败任务必须有明确动作。 |
| 保存同步 | 区分尚未修改、待同步、同步中、已由服务端确认、失败待恢复及只读状态。 | 输入附近说明草稿状态；仅当未确认保存影响离页或跨页恢复时，才使用全局状态区提示。 | 只读时 `state/put` 返回 `403`、`ok:false`、`read_only:true`，客户端不派发写入也不创建待同步项。只有响应 JSON 明确包含 `ok:true` 才清除待同步内容并显示已保存；已派发但未获确认时保留内容供恢复。关闭页面不得静默丢弃未确认内容。 |

迁移顺序由 #189 固定共享状态和控件语义，再由 #190 接入单节点访问覆盖，之后各页面分期迁移。访问切换使用 `POST /state/node-access`，请求为 `{key, node_id, access, password}`，成功返回 `ok`、`nodeAccess` 和 `revision`。普通 `state/put`（包括服务内部的 trusted 调用）与生成 merge 保留服务端当前的 `nodeAccess`；只有密码确认的专用操作能修改它。关闭密码确认后清空密码字段。当前阶段不支持同一资料 key 下重建整张路径；新资料使用默认依赖，保留身份的路径 refinement 保留原节点覆盖，新节点使用默认依赖。不得把访问覆盖当作学习标记、成绩或完成状态。

选择单元及受保护操作通过 `GET /state/access?key=...` 读取当前资料的访问快照。响应只含资料键、修订号、节点 ID、访问覆盖和完成事实，不包含正文、作答或其他资料。确认期间暂不显示缓存正文、自测或可用的 AI 入口；失败在内容区提示并允许重试。较旧的选择、资料或页面请求不能覆盖当前视图，成功重试也不能清除独立的保存错误。批量预生成只检查资料和节点仍存在，可以生成前置未完成或手动锁定的单元；生成不改变访问覆盖和完成事实，阅读与交互仍遵守访问判断。

## 正文工作区

- 正文是学习工作区的主区域。路径和 AI 辅助按需展开。单元标题附近同行显示四态手动标记与 AI 辅助入口；手机空间足够时同行，触控高度至少 44px，窄屏可换行。标记不能表示或替代完成事实。
- 使用 `?node=` 恢复当前单元。`sessionStorage` 按用户和资料保存当前单元及正文滚动位置。这些仅是临时界面状态，不是学习进度。URL 中的有效单元优先；无效单元回退到现有单元并重新应用访问规则。临时查看目标与研究资料不覆盖正文阅读位置。
- 恢复交互后保留焦点。重新聚焦及关键动作前刷新 `nodeAccess`；离线时不能切换访问覆盖。

## 共享交互规则

- 纯状态用文字说明，不伪装成按钮。动作使用按钮或链接，并用动词说明结果。单元学习标记使用互斥选择控件；访问状态和成绩状态单独展示。
- 同一操作区域只设一个主要动作。继续当前学习或提交等当前步骤的动作使用 `.btn.primary`；返回、查看历史和辅助操作使用普通 `.btn` 或链接。删除等不可逆操作采用危险语义，并在确认前说明对象与影响；危险样式不得只靠红色区分。
- 不以颜色作为状态的唯一线索。状态同时提供可读文字；图标只能补充文字。焦点、选中、禁用、忙碌、错误和成功都需有可识别的非颜色差异。
- 只有确实不能执行时才禁用控件。禁用控件附近必须说明原因和恢复条件；不要用禁用按钮代替锁定解释、只读说明或任务进度。
- 状态更新使用稳定身份并就地更新，尽可能保留当前焦点、输入值和滚动位置。只对新出现且需要用户感知的变化播报；轮询不得反复播报同一状态，也不得重建后移走当前焦点。
- 对话框使用原生 `<dialog>` 和 `LearnUI.dialog`。打开时将焦点放到标题后的首个相关控件或明确的主操作；取消、Escape、提交失败和成功关闭都应返回打开对话框的控件。操作进行中防止重复提交；失败文字放在相应字段或操作旁，并通过 `role="alert"` 或状态播报提供给辅助技术。
- 密码确认只用于已定义的受保护操作。弹窗说明要修改的对象和取消方式；密码字段使用密码类型及合适的自动填充语义。关闭弹窗、取消或操作完成后清空密码字段；密码不得进入 localStorage、学习资料、任务内容或日志。密码验证和拒绝规则由业务及服务端实现，UI Kit 不定义鉴权 API。
- 小屏、键盘和读屏用户保持相同操作能力。按钮触控高度沿用窄屏至少 44px 的规则；自定义控件提供可见焦点、键盘操作、名称和选中/展开状态。弹窗内容过长时在弹窗内部滚动，不把操作按钮移出可视区域。

## 控件和 DOM API

### CSS 控件

- `.btn` 是通用按钮和链接按钮。`.btn.primary` 表示主要操作；`.btn.danger` 表示危险操作。`.btn[aria-pressed="true"]` 表示已选中的按压态。
- `.learn-action` 用于状态提示中的轻量操作。
- `.field`、`label`、`input`、`textarea`、`select` 提供表单基础样式。
- `.card` 是通用内容表面。
- 原生 `<dialog>` 提供居中窗口、遮罩、滚动上限和窄屏尺寸。
- `:focus-visible` 为按钮、链接和表单控件提供键盘焦点轮廓。
- `[hidden]` 始终隐藏元素。错误与成功文字使用 `.error`、`.success`。

### `window.LearnUI`

`shared/ui.js` 在页面启动时创建唯一的状态区域和 toast 区域。状态文本通过 `textContent` 写入，回调也不接收 HTML。

| API | 用途 |
| --- | --- |
| `LearnUI.set(key, message, kind, action, label)` | 在页面状态区设置或替换一条持久状态。`kind` 默认为 `info`，可用 `error`、`success`。可选操作显示为按钮。 |
| `LearnUI.toast(key, message, kind, action, label)` | 在浮动提示区设置消息。非 `info` 消息可关闭。 |
| `LearnUI.clear(key)` | 按稳定 key 清除对应状态或 toast。 |
| `LearnUI.ready()` | 请求立即刷新 UI。状态容器仍由 UI Kit 管理。 |
| `LearnUI.dom.byId(id)` | 按 ID 获取元素。 |
| `LearnUI.dom.escapeHTML(value)` | 转义 HTML 特殊字符，供需要文本转义的渲染代码使用。优先使用 `textContent`。 |
| `LearnUI.dom.showError(errorElementOrId, message, inputElementOrId?)` | 以纯文本显示或隐藏错误区域；可选关联输入框，设置无效状态及 `aria-describedby`。隐藏时只移除本错误区域对应的描述 token，并保留其他 token。 |
| `LearnUI.dom.ready(callback)` | 在 DOM 可用时执行回调。 |
| `LearnUI.dialog.open(element, focusElement)` | 打开原生 modal dialog，可选聚焦元素；关闭时恢复打开前的焦点。 |
| `LearnUI.dialog.close(element)` | 关闭已打开的 dialog，执行统一清理并恢复焦点；密码输入框会清空。 |
| `LearnUI.dialog.bind(element, cancelButton, onClose)` | 绑定取消按钮和可选 `close` 事件；重复绑定同一 dialog 只更新关闭回调，不重复注册处理器。 |

`ui` worker 的 `set`、`toast` 和 `clear` 操作都按稳定 key 就地更新。已有提示 DOM 与 busy 状态会保留，避免轮询或重试造成焦点移动、重复节点或重复提交。错误可附带重试回调；操作失败会保留错误并允许再次点击。

### 后台任务详情

`shared/job-details.js` 提供 `LearnJobDetails.mount(host, {key, nodeId, operation})`。页面把显示任务进度和“查看详情”的入口放在任务状态旁边。点击后打开统一的原生对话框。详情接口为 `GET /jobs/{id}/details`。批量任务列表也使用原生对话框，并可在其上打开任务详情。

技术详情使用原生 `<details>`，默认折叠。对话框可查看任务阶段事件。模型请求和回复默认隐藏。对话框提示其中可能包含参考答案和评分标准。用户点击“确认显示模型对话”后才显示正文；关闭对话框后再次打开时重新隐藏模型答案。请求消息和回复内容均作为纯文本写入 DOM；不能拼接进 HTML。对话框有独立滚动区域，不改变页面滚动位置。任务详情关闭时停止详情轮询。关闭后焦点返回打开详情的按钮。按 Escape 关闭也执行相同的焦点处理。轮询更新时，已打开的详情继续显示当前选中的任务。

旧任务没有详情记录时，对话框说明历史详情不可用。截断的详情要显示截断状态。任务详情不能绕过服务端的任务归属检查。

## 样式归属

| 文件 | 归属 | 内容 |
| --- | --- | --- |
| `shared/uikit/tokens.css` | 共享 | 颜色、字体、圆角、间距、焦点和旧别名。 |
| `shared/uikit/controls.css` | 共享 | body 基础、表单、按钮、卡片、dialog 和通用文字状态。 |
| `shared/uikit/navigation.css` | 共享 | 用户导航、只读标记和会话失效覆盖页。 |
| `shared/uikit/feedback.css` | 共享 | 状态栏、toast、任务摘要和响应式反馈。 |
| `shared/markdown.css` | 共享功能 | Markdown、代码、表格和引用内容。 |
| `shared/learning-scenes.css` | 共享功能 | 学习图形、动画、参数与视角控件；使用 UI Kit tokens。 |
| `shared/materials.css` | 共享功能 | 上传资料组件。 |
| `home/home.css` | 首页 | 登录、账号管理、资料库和首页布局。 |
| `learning-path/page-shell.css` | 学习路径 / 测验地图 | 两页共用的工具栏、标题、提示、正文行内代码与代码块壳样式。 |
| `learning-path/path.css` | 学习路径 | 学习阶段、正文工作区、单元目录及 AI 面板。 |
| `learning-path/quiz-map.css` | 测验地图 | 试卷目录、作答区域和成绩视图。 |
| `learning-path/quiz-dialog.css` | 测验窗口 | 学习路径和测验地图共用的测验弹窗。 |

不要在页面 CSS 中复制 UI Kit 的 `:root`、body 基础或通用按钮规则。也不要为每个页面再造 `#learn-status-area`、`#learn-toast-area` 或通用状态按钮。需要不同布局时，使用页面自己的父级类或语义化页面类限定样式。

## 加载顺序

所有页面都先加载 `/learn/config.js` 和 `/learn/assets/ui.css`。脚本按 `shared/manifest.json` 的依赖顺序加载。标准顺序为：

```html
<script src="/learn/config.js"></script>
<script src="/learn/assets/ui.js"></script>
<script src="/learn/assets/user-shell.js"></script>
<script src="/learn/assets/user-session.js"></script>
<script src="/learn/assets/saves.js"></script>
<script src="/learn/assets/job-details.js"></script>
<script src="/learn/assets/jobs.js"></script>
<script src="/learn/assets/titles.js"></script>
<script src="/learn/assets/materials.js"></script>
<script src="/learn/assets/vendor-markdown-it.js"></script>
<script src="/learn/assets/learning-scenes.js"></script>
<script src="/learn/assets/manim-player.js"></script>
<script src="/learn/assets/markdown.js"></script>
```

页面自身的生成脚本在共享依赖之后加载。页面需要 Markdown、KaTeX 和代码高亮时，先加载所需的 vendor 脚本，再启动页面包。CSS 同样先加载 `ui.css`，然后加载 Markdown、资料和页面专属 CSS。`scripts/check_architecture.py` 会检查共享脚本依赖和 HTML 中的顺序。

`manim-player.js` 提供 `LearnManim`。Markdown 的 `enhance` 读取 `learn-manim` 引用，加载经过授权的真实视频与步骤清单。默认不自动播放。每步停在结果帧。`learning-scenes.js` 保持历史 `learn-scene` 显示。两者复用 `/learn/assets/learning-scenes.css` 与 UI Kit tokens。协议与学习约束见 [学习正文交互场景](LEARNING_SCENES.md)。

## 第三方资源

`shared/vendor-manifest.json` 记录 vendored Mermaid 与 Markdown-it 的来源。KaTeX 与 highlight.js 按页面静态资源路径提供。它们属于第三方运行资源，不属于本项目 UI Kit 或业务模块。升级时核对版本与许可证文件，不把 vendor 内容复制进第一方模块。

## 修改和生成

编辑 `shared/uikit/*.css`、`shared/ui.js` 或页面各自 CSS 后，运行：

```sh
python3 scripts/build_frontend.py
python3 learning-path/gen_path_page.py
sh scripts/check-local.sh
```

`build_frontend.py` 从 UI Kit 源文件生成 `shared/ui.css`，并依据首页完整模板 `home/index_template.html` 生成首页包与 `home/index.html`。学习路径与测验页面由 `learning-path/gen_path_page.py` 依据页面 manifest 生成。不要直接编辑这些生成文件。
