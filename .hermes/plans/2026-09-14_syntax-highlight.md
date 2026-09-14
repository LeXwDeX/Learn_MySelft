# 语法高亮（highlight.js 自托管）设计文档

## Goal
学习路径页的代码块（围栏代码）显示语法高亮（Go/Python/JS 等关键字、字符串、注释着色）。全离线自托管、无 CDN，不破坏现有渲染（md-code 样式、KaTeX、答题区纯文本）。

## 架构
自托管 `@highlightjs/cdn-assets` 的 **highlight.min.js**（common 语言包，含 go/python/js/c/rust/java 等）+ **github.min.css** 主题，部署到站点 `./highlight/`（与 katex 同级目录；Hermes 负责下载与部署资源文件，已备好）。
`path_app.js`：md-code 输出时保留围栏语言（`class="language-xx"`），渲染完成后调用 `highlightIn(el)` 对 `pre.md-code code` 执行 `hljs.highlightElement()`；无语言标注的块用 `hljs.highlightAuto()`。

## 既有上下文（关键文件与锚点）
源码目录：`/home/suntao/projects/ZiXueShe/learning-path/`
- `path_app.js` — 页面全部逻辑（生成时整体内联进 learning-path.html）
  - 迷你 Markdown：`mdText(t)`（转义 + 行内 `code` + **加粗**）、`mdRender(text)`（``` 围栏 → `<pre class="md-code"><code>…</code></pre>`，其余走 mdText）
  - `renderNotes(s)`：按行处理讲义（## 标题 / - 列表 / ``` 围栏块，围栏块当前未保留语言）
  - `renderMathIn(el)`：KaTeX 渲染（ignore pre/code/textarea）
  - `highlightIn` 需要新增；调用点：
    - `renderMathIn($('panel-body'));` 共 **2 处**（renderNodeDetail 节点面板、showQuizResult 结果视图）——两处后面都要加 highlightIn
    - `renderMathIn($('qm-body'));` 共 1 处（openQuizModal 放大答题模态框）——后面加 highlightIn
    - `renderMathIn($('brief-text'));`（研究报告）——**不加**（语法高亮只针对代码块区域）
- `path_template.html` — 单文件页面模板（`gen_path_page.py` 替换占位符生成 `learning-path.html`）
  - `<link rel="stylesheet" href="./katex/katex.min.css">`（katex 样式引入，仿照它在旁边加 highlight 样式）
  - `<script src="./katex/katex.min.js"></script>` / `<script src="./katex/contrib/auto-render.min.js"></script>`（在它们旁边加 highlight 脚本）
  - `.md-code{background:#f7f7f8;…;white-space:pre}` 等样式在 `<style>` 内
- 部署（Hermes 负责，pi 不要 scp）：生成后 scp 到 `33.146:/DATA/AppData/zixueshe-web/diagram-design/learning-path/learning-path.html`；`highlight/` 资源目录由 Hermes 放好。

## Task 列表（按顺序）

### Task 1 — path_app.js：mdRender 保留围栏语言
在 `mdRender` 的围栏分支把 code 标签加上语言 class。
- 找到这一行（唯一）：
  `out += '<pre class="md-code"><code>' + esc(m[2].replace(/\r/g, '').replace(/\n+$/, '')) + '</code></pre>';`
- 替换为：
  `out += '<pre class="md-code"><code' + (m[1] ? ' class="language-' + m[1] + '"' : '') + '>' + esc(m[2].replace(/\r/g, '').replace(/\n+$/, '')) + '</code></pre>';`
- 说明：`m[1]` 是正则里已限定为 `[a-zA-Z0-9+#-]*` 的语言捕获，直接拼接安全。
- 验证：`node --check path_app.js` 通过。

### Task 2 — path_app.js：renderNotes 围栏块保留语言
把 `renderNotes` 整个函数替换为下面版本（其余行为不变：## 标题、- 列表、空行、正文）：

```js
  // 简单 markdown：## 小标题 + 空行分段 + ``` 围栏代码块 + 行内 `code`；$...$ 交给 KaTeX
  function renderNotes(s) {
    var lines = String(s || '').split('\n');
    var out = [], fence = null;
    lines.forEach(function (ln) {
      var m = ln.match(/^\s*```([a-zA-Z0-9+#-]*)\s*$/);
      if (fence === null && m) { fence = { lang: m[1] || '', lines: [] }; return; }
      if (fence !== null) {
        if (m) {
          out.push('<pre class="md-code"><code' + (fence.lang ? ' class="language-' + fence.lang + '"' : '') + '>' + esc(fence.lines.join('\n')) + '</code></pre>');
          fence = null;
        } else fence.lines.push(ln);
        return;
      }
      var t = ln.trim();
      if (/^#{2,3}\s+/.test(t)) out.push('<h5>' + esc(t.replace(/^#{2,3}\s+/, '')) + '</h5>');
      else if (/^\s*[-*]\s+/.test(ln)) out.push('<div style="padding-left:14px">· ' + mdText(t.replace(/^\s*[-*]\s+/, '')) + '</div>');
      else if (t === '') out.push('<div style="height:8px"></div>');
      else out.push('<div>' + mdText(ln) + '</div>');
    });
    if (fence !== null) out.push('<pre class="md-code"><code' + (fence.lang ? ' class="language-' + fence.lang + '"' : '') + '>' + esc(fence.lines.join('\n')) + '</code></pre>');
    return out.join('');
  }
```

- 验证：`node --check path_app.js` 通过。

### Task 3 — path_app.js：新增 highlightIn(el)（放在 renderMathIn 函数之后、mdText 之前或之后均可，保持同层缩进）
```js
  // 语法高亮：对迷你 Markdown 输出的代码块执行 highlight.js（库缺失时静默跳过）
  function highlightIn(el) {
    if (typeof hljs === 'undefined' || !el) return;
    var codes = el.querySelectorAll('pre.md-code code');
    for (var i = 0; i < codes.length; i++) {
      var c = codes[i];
      try {
        if (/\blanguage-/.test(c.className)) {
          hljs.highlightElement(c);
        } else {
          var r = hljs.highlightAuto(c.textContent);
          c.innerHTML = r.value;
          c.className = 'hljs';
        }
      } catch (e) { /* 高亮失败不影响正文 */ }
    }
  }
```

### Task 4 — path_app.js：三处调用 highlightIn
1. `renderNodeDetail` 里：`    renderMathIn($('panel-body'));` 之后加 `    highlightIn($('panel-body'));`
2. `openQuizModal` 里：`    renderMathIn($('qm-body'));` 之后加 `    highlightIn($('qm-body'));`
3. `showQuizResult` 里：另一处 `    renderMathIn($('panel-body'));` 之后加 `    highlightIn($('panel-body'));`
（注意 1 和 3 是同一行文本出现两次，两处都要加；brief-text 那处不加。）
- 验证：`grep -c "highlightIn(" path_app.js` 应为 4（1 处定义 + 3 处调用）。

### Task 5 — path_template.html：引入资源 + 覆盖样式
1. 在 `<link rel="stylesheet" href="./katex/katex.min.css">` 的**后面一行**加：
   `<link rel="stylesheet" href="./highlight/github.min.css">`
2. 在 `<script src="./katex/contrib/auto-render.min.js"></script>` 的**后面一行**加：
   `<script src="./highlight/highlight.min.js"></script>`
3. 在 `<style>` 内、`.panel-sec ul.mdlist li{white-space:pre-wrap}` 的**后面一行**加（覆盖 github 主题 .hljs 默认白底/padding，保持灰底代码框观感）：
   `pre.md-code code.hljs{background:transparent;padding:0}`
- 验证：`grep -n "highlight" path_template.html` 能看到 3 处新增（link、script、css）。

### Task 6 — 重新生成页面并自查
- 运行：`python3 gen_path_page.py`（生成 learning-path.html；确认输出「生成完成」）
- 自查：`grep -c "highlightIn" learning-path.html` ≥4；`grep -c "highlight.min.js" learning-path.html` =1；`grep -c "github.min.css" learning-path.html` =1
- `node --check path_app.js` 最终跑一次。

## 验证标准（Hermes 终验会执行）
1. `git diff --stat` 改动仅限 `learning-path/path_app.js`、`learning-path/path_template.html`、`learning-path/learning-path.html`（生成产物）
2. node 语法检查通过
3. 浏览器实测：代码块出现 `code.hljs.language-go`，`.hljs-keyword` 数量 > 0（着色生效），截图可见彩色代码
4. KaTeX 公式仍正常；答题区 textarea 不受影响

## 风险
- github.min.css 的 `.hljs` 自带 `display:block;overflow-x:auto;padding:1em;background:#fff` → 已用 Task 5.3 覆盖 background/padding；display/overflow 保留亦无碍
- hljs 未加载时 highlightIn 静默跳过，正文不受影响（全离线：资源由 Hermes 部署到 ./highlight/）
- highlight.min.js 约 120KB，可接受
