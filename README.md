# 自学社 — AI 学习工具（v1.0）

自托管的 AI 辅助学习工具套件：**学习路径**（对话采集 → 主动研究 → 依赖路径图 → 门控自测）+ **服务端学习数据同步**（换设备自动恢复）。

纯原生前端（无框架、无 CDN）+ Python 标准库 HTTP 后端（资料解析使用独立沙箱与系统依赖）。入口管理页和测验弹窗支持手机布局。

---

本次测验流程与评分规则见 [Quiz Harness](docs/QUIZ_HARNESS.md)：历史轮次保留、出题查重与独立验题、逐题评分点计分。

## 组成

| 目录 | 组件 | 说明 |
|------|------|------|
| `learning-path/` | 学习路径与测验前端 | 页面使用原生 JavaScript 工厂模块。Manifest 声明学习路径、测验地图和测验窗口的依赖，再构建为独立脚本。 |
| `study-assistant/` | AI 后端 | Python 标准库 HTTP 服务。组合根装配账号、存储、资料、模型、任务队列和业务服务。端点由路由控制器分派。 |
| `home/` | 固定首页 | 首页使用原生 JavaScript 工厂模块；共享身份和 UI 代码位于 `shared/`。入口部署为 `<站点>/learn/`。 |
| `shared/` | 浏览器公共模块和 UI Kit | 提供身份、保存、任务、资料、Markdown 与共享样式。UI Kit 源文件见 `shared/uikit/`。 |
| `deploy/` | 部署 | systemd 单元文件（`zixueshe-web.service`、`study-assistant.service`、`static-pages.service`） |

更多模块职责、依赖方向和数据流见 [系统架构](docs/ARCHITECTURE.md)。tokens、共享控件、DOM API 和 CSS 归属见 [前端 UI Kit](docs/UIKIT.md)。

## 多用户

管理员从 `/learn/` 登录后创建、搜索、改名、停用用户或重置密码，并查看所有用户的学习资料。普通用户登录后进入自己的 `/learn/u/<用户ID>/`，学习地图、讨论、测验和进度按服务端身份隔离。管理员查看别人的空间时只读。

已有 `u0` 数据归 `admin`，原有学习文件保留；首次初始化使用服务器原有 `DELETE_PASSWORD`，之后可在页面修改密码。删除自己的资料也使用当前登录密码。停用、重置密码和修改密码使该用户现有会话失效；账号停用不会删除资料。

备份时同时保存学习数据目录与其同级的账号目录，后者包含密码哈希及会话，应保留目录 700、账号文件 600 权限。恢复后运行 `scripts/check-local.sh` 并验证登录和各用户路径。

## 架构与数据流

```
浏览器                                 服务器
┌────────────────────┐   SSE / JSON  ┌─────────────────────┐         ┌──────────────────┐
│ 页面模块包（无框架）    │ ────────────▶ │ study-assistant     │ ──────▶ │ OpenAI 兼容 LLM   │
│ 首页 / 学习路径 / 测验  │ ◀──────────── │ :8101（标准库 HTTP）  │         │ 网关                │
└────────────────────┘               │                     │         └──────────────────┘
         │ localStorage              │ /state/*            │
         └─── 写入即推 / 加载即拉 ─────▶ │ SQLite 文档与任务表   │
```

## 本地测试

本地门禁需要 Python 3.10+、Node.js 和 FFmpeg。建议使用 Python 3.12。仓库提供独立的测试依赖锁文件，以下命令会在项目目录创建隔离环境并安装固定版本及哈希校验的依赖：

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r requirements-test.txt
sh scripts/check-local.sh
```

无需激活 `.venv`；检查脚本会优先使用显式设置的 `PYTHON`，其次使用项目内 `.venv/bin/python`，最后使用 `python3`。若要指定其他 Python，可运行 `PYTHON=/绝对路径/到/python sh scripts/check-local.sh`。每个 Git worktree 都有自己的 `.venv`，需要分别创建和安装依赖。可用 `.venv/bin/python -m pip check` 检查已安装依赖的一致性。

门禁会在运行回归前检查 Python 版本、`py7zr` 测试依赖接口、Node.js 和 FFmpeg；缺少这些工具时会直接报告。更新测试依赖时，先修改 `requirements-test.in`，再使用以下命令重新生成带哈希的锁文件，并重新运行完整门禁：

```bash
uv pip compile requirements-test.in --python-version 3.10 --universal --generate-hashes --output-file requirements-test.txt
.venv/bin/python -m pip install --require-hashes -r requirements-test.txt
sh scripts/check-local.sh
```

本地门禁运行单元和前端回归。它不覆盖 Linux bubblewrap 沙箱、OCR 与 Office 资料解析的真实上传集成，也不替代真实模型链路和部署后的浏览器回归；这些仍按对应的部署与回归流程验证。

## 部署

### 0. 前置条件

- Linux 主机 + Python 3.10+；资料上传依赖见 [个人参考资料](docs/MATERIAL_UPLOADS.md)
- 一个 OpenAI 兼容对话接口（LLM 网关）及其密钥
- （可选）SearXNG 检索服务（「主动研究」阶段用；没有也能生成路径、只是无外部来源）
- 使用随仓库提供的 `study-assistant/web_server.py` 静态服务，以支持用户独立路径

### 1. 构建发布包

```bash
python3 scripts/build_frontend.py
python3 learning-path/gen_path_page.py
sh scripts/check-local.sh
python3 scripts/package_release.py --output /path/to/release
```

打包命令要求源码已提交且 worktree 干净。它按发布清单生成 `backend.tar.gz`、`site.tar.gz` 和含文件及归档 SHA-256 的 `release.json`。部署时使用同一个归档版本，不从源码目录临时挑文件。不要用 `study-assistant/*.py` 复制后端：它会漏掉新增子包，也不会包含静态 JavaScript 和 CSS。

发布包包含生成后的首页、学习路径、测验地图、测验窗口脚本和 HTML，以及共享脚本与样式。后端文件按明示清单打包。第三方资源由单独清单和部署环境管理。

部署步骤见 [可靠性设计](docs/RELIABILITY.md)。测试环境验证通过后，才将同一归档版本用于正式环境。账号、运行配置和学习数据与代码包隔离。

在部署主机上以 root 安装已构建的归档。先部署测试环境并完成功能回归，再用同一路径的发布包部署正式环境：

```bash
python3 scripts/install_release.py --environment test --release-dir /path/to/release
python3 scripts/install_release.py --environment production --release-dir /path/to/release
```

安装器先记录运行配置并快照现有代码文件，再停止后端备份状态数据。它按归档清单校验文件，再原子替换允许的代码和静态资源。发生安装失败时会恢复代码文件并重启原配置。手动回滚使用该环境安装记录返回的备份目录：

```bash
python3 scripts/install_release.py --environment test --rollback /path/to/backup
python3 scripts/install_release.py --environment production --rollback /path/to/backup
```

固定入口：`http://<站点>:<端口>/learn/`

### 2. 页面生成器

```bash
python3 scripts/build_frontend.py
python3 learning-path/gen_path_page.py
```

`build_frontend.py` 构建首页模块包、UI Kit 样式和首页依赖区。`gen_path_page.py` 按页面 manifest 构建学习路径、测验地图、测验窗口脚本及静态 HTML。源码与生成文件不一致时，`sh scripts/check-local.sh` 会在门禁中报告。

### 当前部署实例

- 固定入口：`http://192.168.33.146:8100/learn/`（systemd 服务 `zixueshe-web`；旧 `:8091/learn/` 地址自动跳转）
- 后端：`http://192.168.33.146:8101`（systemd 服务 `study-assistant`）
- 静态根：`/DATA/AppData/zixueshe-web`（`web_server.py` :8100）

## 配置

### 后端环境变量（`deploy/study-assistant.service`）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8101` | 监听端口 |
| `LLM_BASE` | `http://192.168.33.110:8000/v1`（当前部署所用网关） | OpenAI 兼容网关地址；部署到其他环境必须显式设置 |
| `LLM_KEY` | （空） | 网关密钥；**仓库内以 `CHANGE_ME` 占位，部署时替换，禁止提交真实密钥** |
| `LLM_MODEL` | `deepseek` | 模型名 |
| `REASONING_EFFORT` | `max` | 推理档位（`none` 关闭 / `minimal` / `high` / `max`） |
| `SEARXNG_BASE` | `http://192.168.33.146:8103`（当前部署所用） | SearXNG 地址（可选；「主动研究」用） |
| `SEARXNG_ENGINES` | `brave,google cse,wikipedia` | 学习网站专用的搜索引擎列表；不修改共享 SearXNG 配置。候选来源还需通过主题相关性筛选才进入简报。 |
| `STATE_DIR` | `<脚本目录>/state` | 学习数据存储目录；账号文件放在同级的 `state-accounts`（实际为 `STATE_DIR` 加 `-accounts`） |
| `MANIM_ENGINE` | `manimgx` | 动画引擎：`manimgx` 使用封闭场景与固定镜像；`manimgl` 为旧代码链路回滚模式 |
| `DELETE_PASSWORD` | （空） | 首次启动初始化 admin 的密码；账号文件存在后不会覆盖管理员密码 |

### 前端运行配置

静态服务 `/learn/config.js` 提供公共地址，全部页面使用 `LearnUser.apiBase`。同机默认后端端口为 8101；隔离测试通过 `web_server.py --api-port 8111` 配置。`--api-base` 或 `API_PUBLIC_BASE` 支持完整地址及同源代理前缀，无需修改生成页面。

## 数据与备份

学习数据使用 `STATE_DIR/state.sqlite3`，首次运行自动事务导入旧 JSON 文件并保留其原始内容。迁移后的 SQLite 是权威数据源，旧 JSON 仅为升级快照。备份必须包含 WAL 已提交数据及配套账号；停服后使用 `study-assistant/backup_state.py`。

Schema、事务边界、队列恢复、运行参数和回滚规则详见 [可靠性设计](docs/RELIABILITY.md)。UI 组件见 [前端 UI Kit](docs/UIKIT.md)。

## 硬性约定

- 首页、身份管理、任务状态和测验弹窗支持手机
- 页面业务代码由 manifest 声明并构建为独立脚本；共享身份、保存、任务和 UI Kit 按依赖顺序加载
- 第一方前端无框架；Markdown-it、Mermaid、KaTeX 和代码高亮由独立 vendor 文件提供
- 每单元 = 每对话；数据实时同步到服务端，浏览器 localStorage 作为本机缓存
- 学习路径门控：节点依赖全部完成后才解锁；自测 ≥60 分标记完成
- AI 纪律：引导式学习——不主动给答案，学习者提交后再评估；明确索要才给解答

## 备注

- 对话上下文由前端维护并随请求携带；每对话上限 500K token，超出自动压缩（页面有上下文计量）
- `/path/requiz`（换新题重测）：输入节点 + 已出过的题目 + 上次批改要点，输出全新 2~3 题（含答案与解析），避免重测时重复出同一套题

## 版本

- 2026-09-15：移除独立知识地图及预置数学教材；旧地址返回 404，已有学习记录保留。测验参考答案、解题思路和评分标准默认隐藏，确认后展开。

- **v1.0**（2026-09-14）：首个发布版。知识地图 + 学习路径全流程（采集 / 研究 / 路径图 / 门控自测）+ `/state/*` 服务端数据同步。修复项：untitled 根因治理、卡片布局与间距、KaTeX 公式渲染、空回复重试、输出预算 384K。
- 仓库整理：移除测试资料（示例知识地图数据与产物），仅保留工具与文档；模板与生成器去品牌化。
- 项目更名：Learn MySelf → 自学社（ZiXueShe）。
- 部署调整（2026-09-14）：前端迁至专用段 `:8100`（`zixueshe-web` 服务），AI 后端迁至 `:8101`；旧入口地址自动跳转。
