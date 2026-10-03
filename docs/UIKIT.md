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
| 状态 | `--learn-success`, `--learn-danger` | `#2f7d5d` 成功；`#b42318` 错误。 |
| 圆角 | `--learn-radius`, `--learn-radius-control` | 卡片 `8px`；控件 `6px`。 |
| 间距 | `--learn-space-1/2/3/4/6` | 分别为 `4/8/12/16/24px`。 |
| 字体 | `--learn-font`, `--learn-mono`, `--learn-serif` | 系统无衬线、等宽和衬线字体栈。 |
| 焦点 | `--learn-focus` | 键盘焦点环阴影。控件使用可见轮廓和偏移。 |

历史别名（如 `--paper`、`--ink`、`--accent`、`--rule`、`--sans`）仍映射到新 token，供页面样式渐进迁移。新样式优先使用 `--learn-*` 名称。

## 控件和 DOM API

### CSS 控件

- `.btn` 是通用按钮和链接按钮。`.btn.primary` 表示主要操作。
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
| `LearnUI.dom.showError(idOrElement, message)` | 以纯文本显示或隐藏错误区域。 |
| `LearnUI.dom.ready(callback)` | 在 DOM 可用时执行回调。 |
| `LearnUI.dialog.open(element, focusElement)` | 打开原生 modal dialog，可选聚焦元素。 |
| `LearnUI.dialog.close(element)` | 关闭已打开的 dialog。 |
| `LearnUI.dialog.bind(element, cancelButton, onClose)` | 绑定取消按钮和可选 `close` 事件。 |

状态 API 用一个稳定 key 更新同一条消息，避免轮询或重试时不断新增重复提示。错误可附带重试回调。操作失败会保留错误并允许再次点击。

## 样式归属

| 文件 | 归属 | 内容 |
| --- | --- | --- |
| `shared/uikit/tokens.css` | 共享 | 颜色、字体、圆角、间距、焦点和旧别名。 |
| `shared/uikit/controls.css` | 共享 | body 基础、表单、按钮、卡片、dialog 和通用文字状态。 |
| `shared/uikit/navigation.css` | 共享 | 用户导航、只读标记和会话失效覆盖页。 |
| `shared/uikit/feedback.css` | 共享 | 状态栏、toast、任务摘要和响应式反馈。 |
| `shared/markdown.css` | 共享功能 | Markdown、代码、表格和引用内容。 |
| `shared/materials.css` | 共享功能 | 上传资料组件。 |
| `home/home.css` | 首页 | 登录、账号管理、资料库和首页布局。 |
| `learning-path/path.css` | 学习路径 | 学习阶段、路径图、节点卡片和学习面板。 |
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
<script src="/learn/assets/jobs.js"></script>
<script src="/learn/assets/titles.js"></script>
<script src="/learn/assets/materials.js"></script>
<script src="/learn/assets/vendor-markdown-it.js"></script>
<script src="/learn/assets/markdown.js"></script>
```

页面自身的生成脚本在共享依赖之后加载。页面需要 Markdown、KaTeX 和代码高亮时，先加载所需的 vendor 脚本，再启动页面包。CSS 同样先加载 `ui.css`，然后加载 Markdown、资料和页面专属 CSS。`scripts/check_architecture.py` 会检查共享脚本依赖和 HTML 中的顺序。

## 第三方资源

`shared/vendor-manifest.json` 记录 vendored Mermaid 与 Markdown-it 的来源。KaTeX 与 highlight.js 按页面静态资源路径提供。它们属于第三方运行资源，不属于本项目 UI Kit 或业务模块。升级时核对版本与许可证文件，不把 vendor 内容复制进第一方模块。

## 修改和生成

编辑 `shared/uikit/*.css`、`shared/ui.js` 或页面各自 CSS 后，运行：

```sh
python3 scripts/build_frontend.py
python3 learning-path/gen_path_page.py
sh scripts/check-local.sh
```

`build_frontend.py` 从 UI Kit 源文件生成 `shared/ui.css`，并构建首页包与 `home/index.html` 的共享依赖区。学习路径与测验页面由 `learning-path/gen_path_page.py` 依据页面 manifest 生成。不要直接编辑这些生成文件。
