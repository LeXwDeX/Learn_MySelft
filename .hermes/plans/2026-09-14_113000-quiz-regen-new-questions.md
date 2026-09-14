# 学习路径 · 自测「换新题」功能（/path/requiz + 前端 redoQuiz）

- 日期：2026-09-14
- 项目：自学社（ZiXueShe）— 学习路径产品
- 目标读者：pi（实现者）。**本文档是唯一权威设计，严格按文档实现，不要自由发挥。**

## Goal（一句话）

修复「自测失败后重做仍然出**同一套题**」的缺陷：重做/再测时必须生成**全新的变式题**（针对上次的薄弱点），让「判分→讲解→重测」形成有意义的引导式学习闭环。

## 背景与现状（必须理解）

1. 学生流程：打开节点 → 生成学习材料（含 1~3 道自测题，存在 `nodeDetail[id].quiz.questions`）→ 作答 → `POST /path/quiz` **判分**（返回 score/pass/feedback/per_question）→ 未通过时显示「再想想，可重做」按钮。
2. **缺陷**：`learning-path/path_app.js` 中该按钮点击后只调用 `renderNodeDetail(id)` —— 纯重新渲染，题目还是同一套（且判分时已把参考答案/解析都展示给学生）。学生重测 = 抄答案，毫无意义。后端也**没有任何重新出题的端点**。
3. 产品原则（回答纪律）：引导学习；判分后重测必须换新题（变式题，优先覆盖薄弱点）；题目不得与已出过的重复或仅换数字的机械重复。

## 改动清单（3 个文件 + 1 个再生成产物）

| # | 文件（仓库根 = ZiXueShe 项目根） | 改动 |
|---|---|---|
| 1 | `study-assistant/study_assistant.py` | 新增 `_PATH_SYSTEM["requiz"]` 提示词、`_norm_quiz_questions()` 归一函数、`/path/requiz` 路由分支 |
| 2 | `learning-path/path_app.js` | 判分结果里存 `lastResult`；新增 `redoQuiz(id)`；失败结果页 + 节点重进页都加「换新题，再试一次」按钮 |
| 3 | `README.md` | 端点清单补一行 `/path/requiz`（找现有端点列表处补，风格一致） |
| 4 | `learning-path/learning-path.html` | **自动生成产物**：改完全部后用 `learning-path/gen_path_page.py` 重新生成（先读脚本确认运行方式），不得手改 |

---

## 1. 后端：study-assistant/study_assistant.py

### 1a. 新提示词（加在 `_PATH_SYSTEM` dict 里，紧跟 `"quiz"` 项之后）

```python
    "requiz": """你在为同一学习节点重新出题（学生上一次自测未通过，且已看过题目与讲解）。

只输出一个 JSON 对象字面量，不要解释、不要代码围栏，格式：
{"questions":[{"q":"...","answer":"...","explain":"..."}]}

规则：
1. 出 2~3 道全新题；覆盖本节点的知识要点，难度与上次相当或略低（学生未通过，以巩固与补漏为主）。
2. 严禁与「已出过的题目」相同或近似：题目情境、数字、问法、考察角度都必须变化；允许针对同一考点出变式题，但不得照搬。
3. 结合「上次批改要点」，优先覆盖学生暴露的薄弱点：先补错，再巩固。
4. 每题必须给 answer（参考答案）与 explain（解析）。
5. 公式统一用 $...$ 的 LaTeX（前端 KaTeX 渲染），不要用 \\( \\)、\\[ \\] 或 $$ 定界。
6. 数值必须自行验算正确。""",
```

### 1b. 归一函数（加在 `_norm_quiz_result()` 之前或之后，风格与 `_norm_node_detail` 一致）

```python
def _norm_quiz_questions(obj):
    """归一「重新出题」结果：{questions:[{q,answer,explain}]}，最多 3 题，至少 1 题有效，否则 None。"""
    if not isinstance(obj, dict):
        return None
    qs = []
    for q in (obj.get("questions") if isinstance(obj.get("questions"), list) else []):
        if not isinstance(q, dict):
            continue
        question = clip(q.get("q") or q.get("question"), 300)
        if not question:
            continue
        qs.append({"q": question, "answer": clip(q.get("answer"), 600),
                   "explain": clip(q.get("explain"), 600)})
        if len(qs) >= 3:
            break
    if not qs:
        return None
    return {"questions": qs}
```

### 1c. 路由分支（加在 do_POST 的路由链里；**位置：`/path/node` 分支之后、`/path/quiz` 分支之前**）

```python
        # -- 重新出题（换新题重测）--
        if path.startswith("/path/requiz"):
            node = body.get("node") or {}
            spec = _norm_spec(body.get("spec")) if body.get("spec") else None
            used = []
            for q in (body.get("used") or [])[:12]:
                if isinstance(q, dict) and clip(q.get("q"), 300):
                    used.append({"q": clip(q.get("q"), 300), "answer": clip(q.get("answer"), 300)})
            fb = body.get("feedback") if isinstance(body.get("feedback"), dict) else {}
            fb_payload = {
                "上次得分": fb.get("score"),
                "上次总评": clip(fb.get("feedback"), 600),
                "逐题批语": [{"ok": bool(x.get("ok")), "comment": clip(x.get("comment"), 300)}
                            for x in (fb.get("per_question") or [])[:3] if isinstance(x, dict)],
            }
            payload = {
                "需求单": spec,
                "节点": {"title": clip(node.get("title"), 120), "essence": clip(node.get("essence"), 200),
                       "objectives": _str_list(node.get("objectives"), 3, 160)},
                "已出过的题目": used,
                "上次批改要点": fb_payload,
            }
            def _mk_requiz(extra=""):
                return [
                    {"role": "system", "content": _path_system("requiz")},
                    {"role": "user", "content": json.dumps(payload, ensure_ascii=False)
                     + "\n请输出全新的自测题 JSON。" + extra},
                ]
            rq = _norm_quiz_questions(_json_block(_upstream_nonempty(
                _mk_requiz(), max_tokens=PATH_MAX_TOKENS, temperature=0.6)))
            if rq is None:
                rq = _norm_quiz_questions(_json_block(_upstream_nonempty(
                    _mk_requiz(" 注意：只输出一个完整闭合的 JSON 对象（大括号成对），必须含 2~3 道题，且与已出过的题目完全不同。"),
                    max_tokens=PATH_MAX_TOKENS, temperature=0.4)))
            if rq is None:
                self._json(502, {"error": "requiz failed"})
                return
            self._json(200, rq)
            return
```

注意：
- 复用现有辅助：`clip` / `_str_list` / `_norm_spec` / `_json_block` / `_upstream_nonempty` / `PATH_MAX_TOKENS` / `_path_system`。全部已存在，不要新建重复功能。
- `_upstream_nonempty` 的调用形态照抄 `/path/node` 分支里的用法（含 max_tokens/temperature 关键字）。
- 路由顺序：必须在 `/path/quiz` 的 `startswith` 判断**之前**（虽然 `/path/requiz` 不以 `/path/quiz` 开头，但保持放在之前更稳）。
- 纯标准库、无新依赖；注释用中文；不要动其它分支。

## 2. 前端：learning-path/path_app.js

### 2a. `submitQuiz()` 里记录上次结果（供换题针对性出题）

在 `submitQuiz` 的 `.then(function (res) {` 里，`st.score = res.score;` 之后加一行：

```js
      st.lastResult = { score: res.score, pass: res.pass, feedback: res.feedback || '',
                        per_question: res.per_question || [] };
```

### 2b. 新增 `redoQuiz(id)`（放在 `showQuizResult` 之后，`completeNode` 之前）

```js
  // 换新题重测：调用 /path/requiz 生成全新变式题，替换当前题集后重新渲染
  function redoQuiz(id) {
    var n = nodeById(id), d = state.nodeDetail[id];
    if (!n || !d) return;
    var quiz = d.quiz || {};
    var used = ((quiz.used) || []).concat((quiz.questions || []).map(function (q) {
      return { q: q.q, answer: q.answer };
    }));
    var st = state.nodeState[id] || {};
    var btn = $('redo-quiz');
    if (btn) { btn.disabled = true; btn.textContent = '正在出新题…'; }
    hideError();
    post('/path/requiz', {
      node: { title: n.title, essence: n.essence, objectives: n.objectives || [] },
      spec: state.spec,
      used: used.slice(-12),
      feedback: st.lastResult || null
    }).then(function (r) {
      var qs = (r && r.questions) || [];
      if (!qs.length) throw new Error('未获得新题');
      d.quiz = { questions: qs, used: used.slice(-30) };
      save();
      renderNodeDetail(id);
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '换新题，再试一次'; }
      showError('换题失败：' + e.message, function () { redoQuiz(id); });
    });
  }
```

### 2c. 两个入口挂按钮「换新题，再试一次」

**(i) `renderNodeDetail()` 底部按钮区** —— 现有代码：

```js
    var foot = '';
    if (qs.length && !isDone(id)) foot += '<button class="btn primary" id="submit-quiz" type="button">提交自测</button>';
```

改为（上次没过时，重进节点也能换新题）：

```js
    var foot = '';
    if (qs.length && !isDone(id)) foot += '<button class="btn primary" id="submit-quiz" type="button">提交自测</button>';
    if (qs.length && !isDone(id) && typeof prev.score === 'number') foot += '<button class="btn" id="redo-quiz" type="button">换新题，再试一次</button>';
```

并在后面的事件绑定处（`submit-quiz` 绑定之后）加：

```js
    if ($('redo-quiz')) $('redo-quiz').addEventListener('click', function () { redoQuiz(id); });
```

**(ii) `showQuizResult()` 未通过的按钮** —— 现有代码：

```js
      foot += '<button class="btn primary" id="redo-quiz" type="button">再想想，可重做</button>';
```

改为：

```js
      foot += '<button class="btn primary" id="redo-quiz" type="button">换新题，再试一次</button>';
```

并把该按钮的绑定从 `renderNodeDetail(id)` 改为 `redoQuiz(id)`：

```js
    if ($('redo-quiz')) $('redo-quiz').addEventListener('click', function () { redoQuiz(id); });
```

（注：`renderNodeDetail` 与 `showQuizResult` 两处的 redo-quiz 绑定都统一为 `redoQuiz(id)`。）

### 2d. 前端注意事项

- 全部原生 JS 风格（函数声明、`var`、字符串拼接），不要引入 ES6+ 新语法以外的风格变化；照抄现有代码习惯。
- `post()` 辅助超时 180s；后端出题可能 30~60s，无需改超时。
- 不改变任何其它流程（提交、判分、完成、解锁、状态同步）。

## 3. README.md

在端点列表（/path/* 说明处）补一行：`/path/requiz` —— 重新出题（换新题重测）：输入节点 + 已出过的题目 + 上次批改要点，输出全新 2~3 题（含答案与解析）。风格与相邻行一致。

## 4. 重新生成页面

```
cd learning-path && python3 gen_path_page.py     # 先自行读脚本确认用法/输出路径
```

生成后必须验证：`grep -c "redoQuiz" learning-path.html` ≥ 2，且 `grep -c "再想想，可重做" learning-path.html` 为 0。

## 验证标准（写完必须逐条自测并贴出输出）

1. `cd study-assistant && python3 -m py_compile study_assistant.py` → 无输出。
2. 本地起服务实测（上游可达）：
   ```
   cd study-assistant && PORT=8199 LLM_BASE=http://192.168.33.110:8000/v1 LLM_KEY=CHANGE_ME LLM_MODEL=deepseek python3 study_assistant.py &
   curl -s -m 120 http://127.0.0.1:8199/health
   ```
   （LLM_KEY 用内网网关虚拟 key，测试时由环境注入；不要写进任何文件，仓库内一律 CHANGE_ME 占位。）
3. `/path/requiz` 冒烟（自己构造一个初中数学节点 payload，观察返回的 questions）：
   ```
   curl -s -m 180 -X POST http://127.0.0.1:8199/path/requiz -H 'Content-Type: application/json' -d '{"node":{"title":"有理数与实数","essence":"把数系从整数扩展到实数","objectives":["会算有理数混合运算","会估无理数大小"]},"used":[{"q":"计算 (-2)^3+(-3)*(-4)-|-5|","answer":"-1"}],"feedback":{"score":40,"feedback":"符号法则与估算薄弱","per_question":[{"ok":false,"comment":"负负得正未掌握"}]}}'
   ```
   预期：HTTP 200，JSON `{"questions":[...2~3题...]}`，每题含 q/answer/explain，且**不是**给定 used 那道题。
4. 再调一次（把第 3 步返回的 2~3 题全部放进 `used` 再加一次）→ 返回的题与上一轮**明显不同**（贴出两轮 questions 的 q 字段对比）。
5. `/path/quiz` 回归：用第 3 步的题构造一次判分请求 → 返回 pass/score/feedback/per_question 正常。
6. 生成页面：第 4 节的两个 grep 通过；`python3 -m py_compile` 通过。
7. 收尾：kill 掉 8199 的测试进程；`git diff --stat` 输出改动范围（应为 3~4 个文件，learning-path.html 行数变化大属正常）。

## 已知坑（避免踩）

- `study_assistant.py` 是 **纯标准库单文件**，绝不允许引入 import 新依赖（连 `dataclasses` 也不必要）。
- 路由分支插错位置会 404 —— 必须放 `/path/quiz` 判断之前。
- `_norm_spec(None)` 可能报错 —— 文档里已用 `if body.get("spec")` 保护，照抄。
- 生成产物 `learning-path.html` 只能由脚本生成，禁止手改；脚本输出路径若不是同名文件，读脚本注释按说明处理。
- 不要 commit、不要 push —— 提交由 Hermes 验完后统一做。
