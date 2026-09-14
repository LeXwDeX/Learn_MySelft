# 自学社 — AI 学习工具（v1.0）

自托管的 AI 辅助学习工具套件：**知识地图**（单元级 AI 对话）+ **学习路径**（对话采集 → 主动研究 → 依赖路径图 → 门控自测）+ **服务端学习数据同步**（换设备自动恢复）。

纯原生前端（无框架、无 CDN）+ 纯 Python 标准库后端（无第三方依赖）。仅适配桌面（整页最低宽度 1360px）。

---

本次测验流程与评分规则见 [Quiz Harness](docs/QUIZ_HARNESS.md)：历史轮次保留、出题查重与独立验题、逐题评分点计分。

## 组成

| 目录 | 组件 | 说明 |
|------|------|------|
| `knowledge-map/` | 知识地图 | 将结构化知识数据生成为交互式知识页：单元卡片 + 四态进度标记 + 每单元独立 AI 对话（每单元 = 每对话）。数据自备（未随仓库提供），由 `gen_math_map.py` 生成 |
| `learning-path/` | 学习路径 | 输入主题 → 对话式采集需求 → 主动研究（SearXNG 检索）→ 生成依赖路径图。节点按依赖解锁（前置全部完成才可学），自测通过（≥60 分）标记完成 |
| `study-assistant/` | AI 后端 | 两个页面共用的 AI 服务（SSE 流式）。端点：`/ask` `/suggest` `/compress` `/health` `/path/intake` `/path/research` `/path/plan` `/path/node` `/path/quiz` `/path/requiz` `/state/all` `/state/put` `/state/del` |
| `home/` | 固定首页 | 学习工具固定入口（部署为 `<站点>/learn/`）；`state_sync.js` 为全站学习数据同步脚本（部署为 `<站点>/state_sync.js`） |
| `deploy/` | 部署 | systemd 单元文件（`zixueshe-web.service`、`study-assistant.service`、`static-pages.service`） |

## 架构与数据流

```
浏览器                                 服务器
┌────────────────────┐   SSE / JSON  ┌─────────────────────┐         ┌──────────────────┐
│ 静态页面（无框架）    │ ────────────▶ │ study-assistant     │ ──────▶ │ OpenAI 兼容 LLM   │
│ 知识地图 / 路径 / 首页 │ ◀──────────── │ :8101（纯标准库）     │         │ 网关（模型 deepseek）│
└────────────────────┘               │                     │         └──────────────────┘
         │ localStorage              │ /state/*            │
         └─── 写入即推 / 加载即拉 ─────▶ │ 每键一个 JSON 文件    │
```

## 部署

### 0. 前置条件

- Linux 主机 + Python 3.10+（前后端均只用标准库）
- 一个 OpenAI 兼容对话接口（LLM 网关）及其密钥
- （可选）SearXNG 检索服务（「主动研究」阶段用；没有也能生成路径、只是无外部来源）
- 一个静态文件服务器（示例：`python3 -m http.server`）

### 1. AI 后端

```bash
sudo mkdir -p /opt/study-assistant
sudo cp study-assistant/study_assistant.py study-assistant/quiz_harness.py /opt/study-assistant/
# 编辑 deploy/study-assistant.service：把 LLM_KEY 改为实际密钥（按需调整 LLM_BASE 等，见下表）
sudo cp deploy/study-assistant.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now study-assistant
curl -s http://127.0.0.1:8101/health   # 验证
```

### 2. 静态页面

```bash
# R = 静态根目录（当前部署：/DATA/AppData/zixueshe-web，由 deploy/zixueshe-web.service 以 :8100 服务）
R=/path/to/static-root
mkdir -p $R/learn $R/diagram-design/learning-path
cp home/index.html                     $R/learn/index.html
cp home/state_sync.js                  $R/state_sync.js
# 知识地图页（可选）：先用「生成器」把自备数据生成为页面，再把产物放到：
#   $R/diagram-design/learning-path/<你的页面名>.html
cp learning-path/learning-path.html    $R/diagram-design/learning-path/learning-path.html
# KaTeX（公式渲染，第三方 0.18.7，未收录本仓库）：从 npm 镜像取 dist 解压到：
#   $R/diagram-design/learning-path/katex/
#   npm pack katex@0.18.7 --registry=https://registry.npmmirror.com && tar xf katex-0.18.7.tgz
```

固定入口：`http://<站点>:<端口>/learn/`

### 3. 生成器（页面内容改动后重新生成）

```bash
python3 knowledge-map/gen_math_map.py         # 自备数据（math_data.py）→ 页面 + 种子 JSON
cd learning-path && python3 gen_path_page.py  # path_template.html + path_app.js → learning-path.html
```

### 当前部署实例

- 固定入口：`http://192.168.33.146:8100/learn/`（systemd 服务 `zixueshe-web`；旧 `:8091/learn/` 地址自动跳转）
- 后端：`http://192.168.33.146:8101`（systemd 服务 `study-assistant`）
- 静态根：`/DATA/AppData/zixueshe-web`（python http.server :8100）

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
| `STATE_DIR` | `<脚本目录>/state` | 学习数据存储目录 |

### 前端地址约定（换部署地址时看这里）

- `state_sync.js`：自动请求「当前页面主机名 `:8101`」——**静态站与后端同机部署时零配置**。
- `learning-path/path_app.js`：顶部常量 `var API = 'http://192.168.33.146:8101'`——部署到其他地址时改这一处，然后重新执行 `gen_path_page.py` 生成页面。
- `knowledge-map/ai_panel.js`：知识地图的 API 常量同理（改动后重新执行 `gen_math_map.py`）。
- 后端内置 CORS 白名单：`localhost / 127.0.0.1 / 192.168.x.x / 10.x.x.x`——只允许这些来源，刻意如此。

## 数据与备份

- 学习数据存服务端 `STATE_DIR`（默认 `study-assistant/state/`），**每键一个 JSON 文件**：`{"key", "v", "ts"}`；`v=null` 表示已删除（墓碑，防止旧设备把已删数据推回来）。
- 同步机制：浏览器写入即推（去抖 600ms、关页兜底）+ 打开页面即拉（服务端为准）→ 换浏览器 / 换设备自动恢复。
- **备份**：直接复制 `STATE_DIR` 目录。**恢复**：复制回去并重启服务。
- **重置**：停服 → 清空目录 → 起服（浏览器端数据会在下次打开页面时自动上传回来）。

## 硬性约定

- 仅适配桌面（整页最低宽度 1360px），无手机适配
- 页面为单文件、无 CDN 依赖；公式走自托管 KaTeX
- 每单元 = 每对话；数据实时同步到服务端，浏览器 localStorage 作为本机缓存
- 学习路径门控：节点依赖全部完成后才解锁；自测 ≥60 分标记完成
- AI 纪律：引导式学习——不主动给答案，学习者提交后再评估；明确索要才给解答

## 备注

- 对话上下文由前端维护并随请求携带；每对话上限 500K token，超出自动压缩（页面有上下文计量）
- 知识地图自测「看答案」为手动展开；学习路径自测走后端自动判分
- `/path/requiz`（换新题重测）：输入节点 + 已出过的题目 + 上次批改要点，输出全新 2~3 题（含答案与解析），避免重测时重复出同一套题

## 版本

- **v1.0**（2026-09-14）：首个发布版。知识地图 + 学习路径全流程（采集 / 研究 / 路径图 / 门控自测）+ `/state/*` 服务端数据同步。修复项：untitled 根因治理、卡片布局与间距、KaTeX 公式渲染、空回复重试、输出预算 384K。
- 仓库整理：移除测试资料（示例知识地图数据与产物），仅保留工具与文档；模板与生成器去品牌化。
- 项目更名：Learn MySelf → 自学社（ZiXueShe）。
- 部署调整（2026-09-14）：前端迁至专用段 `:8100`（`zixueshe-web` 服务），AI 后端迁至 `:8101`；旧入口地址自动跳转。
