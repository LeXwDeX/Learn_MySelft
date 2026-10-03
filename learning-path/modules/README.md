# 学习页和测验页模块

页面使用原生 JavaScript。每个源文件注册一个独立工厂。工厂通过 `deps` 读取声明的模块接口。模块只导出显式接口。局部变量留在工厂内。

`manifest.json` 是构建清单。`bundle_builder.py` 检查工厂声明、缺失依赖和循环依赖，再按依赖关系生成独立脚本。工厂的注册顺序不影响执行顺序。运行时不执行字符串代码。

## 学习页

| 模块 | 责任 |
| --- | --- |
| `path.model` | 学习状态、用户上下文和页面会话数据 |
| `path.domain` | 补习层级、前置条件、完成状态和计划归一 |
| `path.format` | 学习资料键和通用渲染适配 |
| `path.persistence` | 服务端读取、保存、删除、待写入请求和网络调用 |
| `path.shell` | 阶段导航、进度、错误提示和复习标记 |
| `path.workflow` | 需求采集、研究、路径生成和中断恢复 |
| `path.cards` | 单元卡片、选中状态、展开状态和学习材料视图 |
| `path.generation` | 单元材料请求、批量队列、暂停和重试 |
| `path.assistant` | AI 对话、流式输出和手机辅导窗口 |
| `path.assessment` | 单元测验、换题、完成确认和补习请求 |
| `path.library` | 资料库、新建学习和删除窗口 |
| `path.entry` | 连接具名回调，注册页面入口 |

较低层模块需要更新较高层视图时，调用 `path.hooks` 的具名回调。入口只连接一次。回调名称列在 hooks 源文件中。hooks 不携带业务状态。模块不读取其他服务的内部保存队列或批量队列。

## 测验页和测验窗口

`quiz-map.model` 保存当前试卷视图。`network` 处理网络调用。`identity` 比对题集和提交身份。`view` 显示试卷和成绩。`diagnosis` 处理薄弱点诊断和补习。`catalog` 显示试卷目录并发起生成。`entry` 连接页面回调。

`quiz-dialog.question` 处理题型、填空值和评分文案。`model` 保存当前窗口和题集视图。`network` 处理请求。`drafts` 管理按题集保存的草稿、版本和重试。`view` 渲染题目、历史提交和保存提示。`controller` 注册窗口事件并提交作答。`entry` 发布兼容接口 `window.QuizDialog.open`。

`page.format` 共用 Markdown、公式、代码高亮和输入框自动增高。DOM 查询、文本转义和窗口开关调用 `LearnUI`。页面样式只负责页面布局。通用颜色、按钮、字段和窗口基础样式由 UIKit 提供。

## 修改和检查

1. 修改 `modules/` 下的源文件及所属页面 CSS。
2. 变更依赖时，同步更新 `manifest.json` 和工厂声明。
3. 运行 `python3 learning-path/gen_path_page.py`。
4. 运行 `python3 learning-path/gen_path_page.py --check`。
5. 运行相关业务回归。`node tests/test_page_module_contracts.js` 检查真实工厂的逆序加载、接口、缺依赖和循环依赖。

生成文件是 `path_app.js`、`quiz-map-app.js`、`quiz_dialog.js`、`learning-path.html` 和 `quiz-map.html`。不直接修改生成文件。生成过程没有时间戳。相同输入产生相同输出。
