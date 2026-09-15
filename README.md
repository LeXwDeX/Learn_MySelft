# 自学社 — AI 学习工具（v1.0）

自托管的 AI 辅助学习工具套件：**学习路径**（对话采集 → 主动研究 → 依赖路径图 → 门控自测）+ **服务端学习数据同步**（换设备自动恢复）。

纯原生前端（无框架、无 CDN）+ 纯 Python 标准库后端（无第三方依赖）。入口管理页和测验弹窗支持手机布局。

---

本次测验流程与评分规则见 [Quiz Harness](docs/QUIZ_HARNESS.md)：历史轮次保留、出题查重与独立验题、逐题评分点计分。

## 组成

| 目录 | 组件 | 说明 |
|------|------|------|
| `learning-path/` | 学习路径 | 输入主题 → 对话式采集需求 → 主动研究（SearXNG 检索）→ 生成依赖路径图。节点按依赖解锁（前置全部完成才可学），自测通过（≥60 分）标记完成 |
| `study-assistant/` | AI 后端 | 两个页面共用的 AI 服务（SSE 流式）。端点：`/ask` `/suggest` `/compress` `/health` `/path/intake` `/path/research` `/path/plan` `/path/node` `/path/quiz` `/path/requiz` `/state/all` `/state/put` `/state/del` |
| `home/` | 固定首页 | 登录、账号管理与个人资料库（部署为 `<站点>/learn/`）；公共身份脚本位于 `shared/user-session.js` |
| `deploy/` | 部署 | systemd 单元文件（`zixueshe-web.service`、`study-assistant.service`、`static-pages.service`） |

## 多用户

管理员从 `/learn/` 登录后创建、搜索、改名、停用用户或重置密码，并查看所有用户的学习资料。普通用户登录后进入自己的 `/learn/u/<用户ID>/`，学习地图、讨论、测验和进度按服务端身份隔离。管理员查看别人的空间时只读。

已有 `u0` 数据归 `admin`，原有学习文件保留；首次初始化使用服务器原有 `DELETE_PASSWORD`，之后可在页面修改密码。删除自己的资料也使用当前登录密码。停用、重置密码和修改密码使该用户现有会话失效；账号停用不会删除资料。

备份时同时保存学习数据目录与其同级的账号目录，后者包含密码哈希及会话，应保留目录 700、账号文件 600 权限。恢复后运行 `scripts/check-local.sh` 并验证登录和各用户路径。

## 架构与数据流

```
浏览器                                 服务器
┌────────────────────┐   SSE / JSON  ┌─────────────────────┐         ┌──────────────────┐
│ 静态页面（无框架）    │ ────────────▶ │ study-assistant     │ ──────▶ │ OpenAI 兼容 LLM   │
│ 学习路径 / 测验 / 首页 │ ◀──────────── │ :8101（纯标准库）     │         │ 网关（模型 deepseek）│
└────────────────────┘               │                     │         └──────────────────┘
         │ localStorage              │ /state/*            │
         └─── 写入即推 / 加载即拉 ─────▶ │ SQLite 文档与任务表   │
```

## 部署

### 0. 前置条件

- Linux 主机 + Python 3.10+（前后端均只用标准库）
- 一个 OpenAI 兼容对话接口（LLM 网关）及其密钥
- （可选）SearXNG 检索服务（「主动研究」阶段用；没有也能生成路径、只是无外部来源）
- 使用随仓库提供的 `study-assistant/web_server.py` 静态服务，以支持用户独立路径

### 1. AI 后端

```bash
sudo mkdir -p /opt/study-assistant
sudo cp study-assistant/*.py /opt/study-assistant/
# 编辑 deploy/study-assistant.service：把 LLM_KEY 改为实际密钥（按需调整 LLM_BASE 等，见下表）
sudo cp deploy/study-assistant.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now study-assistant
curl -s http://127.0.0.1:8101/health   # 验证
```

### 2. 静态页面

```bash
# R = 静态根目录（当前部署：/DATA/AppData/zixueshe-web，由 deploy/zixueshe-web.service 以 :8100 服务）
R=/path/to/static-root
mkdir -p $R/learn/assets $R/diagram-design/learning-path
cp home/index.html                     $R/learn/index.html
cp home/home.js                       $R/learn/assets/home.js
cp shared/*.js shared/*.css           $R/learn/assets/
cp learning-path/learning-path.html learning-path/quiz-map.html $R/diagram-design/learning-path/
sudo cp deploy/zixueshe-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart zixueshe-web
# KaTeX（公式渲染，第三方 0.18.7，未收录本仓库）：从 npm 镜像取 dist 解压到：
#   $R/diagram-design/learning-path/katex/
#   npm pack katex@0.18.7 --registry=https://registry.npmmirror.com && tar xf katex-0.18.7.tgz
```

固定入口：`http://<站点>:<端口>/learn/`

### 3. 生成器（页面内容改动后重新生成）

```bash
cd learning-path && python3 gen_path_page.py  # path_template.html + path_app.js → learning-path.html
```

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
| `STATE_DIR` | `<脚本目录>/state` | 学习数据存储目录；账号文件放在同级的 `state-accounts`（实际为 `STATE_DIR` 加 `-accounts`） |
| `DELETE_PASSWORD` | （空） | 首次启动初始化 admin 的密码；账号文件存在后不会覆盖管理员密码 |

### 前端运行配置

静态服务 `/learn/config.js` 提供公共地址，全部页面使用 `LearnUser.apiBase`。同机默认后端端口为 8101；隔离测试通过 `web_server.py --api-port 8111` 配置。`--api-base` 或 `API_PUBLIC_BASE` 支持完整地址及同源代理前缀，无需修改生成页面。

## 数据与备份

学习数据使用 `STATE_DIR/state.sqlite3`，首次运行自动事务导入旧 JSON 文件并保留其原始内容。迁移后的 SQLite 是权威数据源，旧 JSON 仅为升级快照。备份必须包含 WAL 已提交数据及配套账号；停服后使用 `study-assistant/backup_state.py`。

Schema、事务边界、队列恢复、运行参数、UI 组件和回滚规则详见 [可靠性设计](docs/RELIABILITY.md)。

## 硬性约定

- 首页、身份管理、任务状态和测验弹窗支持手机
- 生成页面内嵌业务代码，共用身份、保存和任务组件；无 CDN 依赖，公式走自托管 KaTeX
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
