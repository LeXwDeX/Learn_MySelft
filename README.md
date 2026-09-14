# Learn MySelf — 内网 AI 学习工具

自托管的 AI 辅助学习工具套件：静态知识页 + 单元级 AI 对话 + 学习路径生成（对话采集 → 主动研究 → 路径图）+ 解锁门控自测。
学习数据全部存浏览器本地（localStorage），后端为纯 Python 标准库服务（无第三方依赖）。

## 组成

| 目录 | 组件 | 说明 |
|------|------|------|
| `knowledge-map/` | 知识地图 | 《初中数学+几何 知识体系 & 线性代数一周冲刺》交互式知识页。每个知识点卡片带「AI 辅助」按钮，点选后右侧常驻面板进入该单元的独立对话（每单元 = 每对话） |
| `learning-path/` | 学习路径 | 输入主题 → 对话式采集需求 → 主动研究 → 生成依赖路径图。节点按依赖解锁（前置全部完成才可学），自测通过（≥60 分）标记完成 |
| `study-assistant/` | AI 后端 | 两个页面共用的 AI 服务（SSE 流式）。端点：`/ask`、`/suggest`、`/compress`、`/health`、`/path/intake`、`/path/research`、`/path/plan`、`/path/node`、`/path/quiz`、`/state/all`、`/state/put`、`/state/del`（学习数据服务端存储） |
| `home/` | 固定首页 | 学习工具固定入口（部署为 `<站点>/learn/`）。收藏这一页即可，两个工具的链接都在上面；`state_sync.js` 为全站学习数据同步脚本（部署为 `<站点>/state_sync.js`） |
| `deploy/` | 部署 | systemd 单元文件 |

## 部署

### 1. AI 后端

```bash
# 纯标准库；先把 deploy/study-assistant.service 里的 LLM_KEY 填成实际值
sudo mkdir -p /opt/study-assistant
sudo cp study-assistant/study_assistant.py /opt/study-assistant/
sudo cp deploy/study-assistant.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now study-assistant
```

### 2. 静态页面

```bash
# 任意静态服务器即可（示例见 deploy/static-pages.service，python http.server 监听 8091）
# 知识地图：math-knowledge-map.html → 部署为 <站点>/diagram-design/learning-path/junior-math-linalg.html
# 学习路径：learning-path.html      → 部署为 <站点>/diagram-design/learning-path/learning-path.html
# KaTeX 公式渲染（0.18.7 自托管）：解压官方 dist 到 <站点>/.../learning-path/katex/（第三方资源，本仓库未收录）
```

### 3. 生成器（改内容后重新生成）

```bash
python3 knowledge-map/gen_math_map.py        # math_data.py → math-knowledge-map.html + .json
cd learning-path && python3 gen_path_page.py # path_template.html + path_app.js → learning-path.html
```

## 硬性约定

- 仅适配桌面（整页最低宽度 1360px），无手机适配
- 页面为单文件、无 CDN 依赖；公式走自托管 KaTeX
- 每单元 = 每对话；对话历史与学习数据实时同步到服务端（study-assistant `/state/*`，每键一个 JSON 文件，存于 `/opt/study-assistant/state/`），浏览器 localStorage 作为本机缓存；换设备打开自动恢复
- 学习路径门控：节点依赖全部完成后才解锁；自测 ≥60 分标记完成
- AI 纪律：引导式学习——不主动给答案，学习者提交后再评估；明确索要才给解答
- 后端对接内部 LLM 网关（OpenAI 兼容接口，模型名 `deepseek`，推理档 max，输出上限 384K）

## 备注

- 后端无状态：对话上下文由前端维护并随请求携带；每对话上限 500K token，超出自动压缩
- 知识地图自测「看答案」为手动展开；学习路径自测走后端自动判分
