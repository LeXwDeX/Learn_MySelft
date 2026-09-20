/* Shared Markdown contract: source stays Markdown; each diagram fails independently. */
(function () {
  'use strict';
  var parser, loader, serial = Promise.resolve(), sequence = 0;
  var sources = new WeakMap();
  function escape(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function separateTableProse(state) {
    var lines = state.src.split('\n'), boundaries = [];
    state.tokens.forEach(function (token, index) {
      if (token.type !== 'table_open' || token.level !== 0 || !token.map) return;
      var columns = 0;
      for (var i = index + 1; i < state.tokens.length && state.tokens[i].type !== 'thead_close'; i++) {
        if (state.tokens[i].type === 'th_open') columns++;
      }
      if (columns < 2) return;
      var start = token.map[0] + 2, end = token.map[1], row = start;
      // Only explicit, complete pipe rows establish the generated-table pattern.
      while (row < end && /^\s*\|.*\|\s*$/.test(lines[row])) row++;
      if (row === start || row === end) return;
      var prose = lines.slice(row, end), first = prose[0].trim();
      if (first.length < 12 || !/[。！？.!?][”’"']?$/.test(first)) return;
      if (prose.some(function (line) { return !line.trim() || line.indexOf('|') !== -1; })) return;
      boundaries.push(row);
    });
    if (!boundaries.length) return;
    boundaries.reverse().forEach(function (line) { lines.splice(line, 0, ''); });
    // Display-only normalization: saved source and Markdown exports stay intact.
    state.src = lines.join('\n');
    state.env.lines = lines;
    state.tokens = [];
    state.md.block.parse(state.src, state.md, state.env, state.tokens);
  }
  function getParser() {
    if (parser) return parser;
    if (!window.markdownit) return null;
    parser = window.markdownit({html:false, breaks:true, linkify:false});
    parser.core.ruler.after('block', 'learn_table_boundary', separateTableProse);
    // Keep LaTeX untouched by Markdown's backslash/underscore processing.
    parser.inline.ruler.before('escape', 'learn_math', function (state, silent) {
      if (state.src[state.pos] !== '$') return false;
      var start = state.pos, delimiter = state.src.slice(start, start + 2) === '$$' ? '$$' : '$';
      var end = state.src.indexOf(delimiter, start + delimiter.length);
      while (end >= 0 && state.src[end - 1] === '\\') end = state.src.indexOf(delimiter, end + delimiter.length);
      if (end < 0) return false;
      if (!silent) { var token = state.push('text', '', 0); token.content = state.src.slice(start, end + delimiter.length); }
      state.pos = end + delimiter.length;
      return true;
    });
    // Generated remote image URLs are not fetched automatically.
    parser.renderer.rules.image = function (tokens, index) {
      return '<span class="md-image-alt">[图片：' + escape(tokens[index].content) + ']</span>';
    };
    parser.renderer.rules.fence = function (tokens, index, options, env) {
      var token = tokens[index], lang = token.info.trim().split(/\s+/)[0];
      if (lang !== 'mermaid') return '<pre class="md-code"><code' + (/^[\w+#-]+$/.test(lang) ? ' class="language-' + lang + '"' : '') + '>' + escape(token.content) + '</code></pre>';
      var lastLine = env.lines[token.map[1] - 1] || '';
      var closed = new RegExp('^ {0,3}' + token.markup[0] + '{' + token.markup.length + ',}\\s*$').test(lastLine);
      var status = env.streaming ? 'waiting' : closed ? 'pending' : 'invalid';
      var message = env.streaming ? '图示正在生成，回复完成后显示…' : closed ? '正在校验图示…' : '图示代码未完整闭合，请参考周围文字，或让 AI 重新画图。';
      return '<figure class="md-diagram" data-diagram="' + status + '"><figcaption role="status">' + message + '</figcaption><details><summary>查看图示源代码</summary><pre><code>' + escape(token.content) + '</code></pre></details></figure>';
    };
    return parser;
  }
  function render(text, options) {
    var source = String(text == null ? '' : text), md = getParser();
    try { return '<div class="learn-markdown">' + (md ? md.render(source, {lines:source.split(/\r?\n/), streaming:!!(options && options.streaming)}) : '<pre>' + escape(source) + '</pre>') + '</div>'; }
    catch (error) { return '<pre class="md-fallback">' + escape(source) + '</pre>'; }
  }
  function loadMermaid() {
    if (!loader) loader = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      var timer = setTimeout(function () { reject(new Error('图示组件加载超时')); }, 15000);
      script.src = '/learn/assets/vendor-mermaid.js';
      script.onload = function () {
        clearTimeout(timer);
        try {
          window.mermaid.initialize({startOnLoad:false, securityLevel:'strict', suppressErrorRendering:true,
            maxTextSize:8000, maxEdges:100, flowchart:{htmlLabels:false}, theme:'neutral'});
          resolve(window.mermaid);
        } catch (error) { reject(error); }
      };
      script.onerror = function () { clearTimeout(timer); reject(new Error('图示组件未能加载')); };
      document.head.appendChild(script);
    }).catch(function (error) { loader = null; throw error; });
    return loader;
  }
  function download(text, filename, type) {
    var url = URL.createObjectURL(new Blob([text], {type:type})), a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function svgImage(svg) {
    var img = document.createElement('img');
    img.alt = '知识图示，说明见相邻正文';
    // An image document cannot execute diagram scripts or access the parent DOM.
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    return img;
  }
  function zoom(svg, trigger) {
    var dialog = document.createElement('dialog'); dialog.className = 'md-zoom';
    dialog.innerHTML = '<div class="md-zoom-tools"><strong>查看图示</strong><button type="button">放大</button><button type="button">缩小</button><button type="button">关闭</button></div><div class="md-zoom-scroll"></div>';
    var pane = dialog.querySelector('.md-zoom-scroll'), img = svgImage(svg), scale = 1;
    pane.appendChild(img); var buttons = dialog.querySelectorAll('button');
    function fit() { img.style.width = Math.round(Math.max(640, pane.clientWidth) * scale) + 'px'; }
    buttons[0].onclick = function () { scale = Math.min(4, scale + 0.25); fit(); };
    buttons[1].onclick = function () { scale = Math.max(0.5, scale - 0.25); fit(); };
    buttons[2].onclick = function () { dialog.close(); };
    dialog.addEventListener('close', function () { dialog.remove(); if (trigger.isConnected) trigger.focus({preventScroll:true}); });
    document.body.appendChild(dialog); dialog.showModal(); fit(); buttons[2].focus();
  }
  async function draw(figure) {
    if (!figure.isConnected) return;
    if (figure.closest('[hidden]')) { figure.dataset.diagram = 'pending'; return; }
    var source = figure.querySelector('code').textContent, caption = figure.querySelector('figcaption');
    try {
      if (source.length > 8000) throw new Error('图示过长，请让 AI 拆成小图');
      if (!/^\s*(flowchart|graph|sequenceDiagram)\b/.test(source) || /%%\{|^\s*---|\bclick\s|<[^>]*>/m.test(source)) throw new Error('图示含不支持的语法，请使用普通流程图或时序图');
      var mermaid = await loadMermaid();
      if (!figure.isConnected) return;
      await mermaid.parse(source);
      var staging = document.createElement('div');
      staging.style.cssText = 'position:fixed;left:-20000px;top:0;width:1200px;visibility:hidden;pointer-events:none';
      staging.setAttribute('aria-hidden', 'true'); document.body.appendChild(staging);
      var result;
      try { result = await mermaid.render('learn-diagram-' + (++sequence), source, staging); }
      finally { staging.remove(); }
      if (!figure.isConnected) return;
      var image = svgImage(result.svg);
      image.onerror = function () { image.remove(); caption.textContent = '图示显示失败，源代码和文字说明已保留。'; figure.dataset.diagram = 'failed'; };
      figure.insertBefore(image, figure.querySelector('details'));
      var button = document.createElement('button'); button.type = 'button'; button.textContent = '放大查看';
      button.onclick = function () { zoom(result.svg, button); }; figure.appendChild(button);
      var save = document.createElement('button'); save.type = 'button'; save.textContent = '下载图示';
      save.onclick = function () { download(result.svg, '知识图示.svg', 'image/svg+xml'); }; figure.appendChild(save);
      caption.textContent = '知识图示'; figure.dataset.diagram = 'ready';
    } catch (error) {
      if (!figure.isConnected) return;
      caption.textContent = /组件|过长|不支持/.test(error.message) ? error.message + '。文字与源代码已保留。' : '图示语法校验失败，请参考周围文字，或让 AI 修正图示。源代码已保留。';
      figure.dataset.diagram = 'failed';
    }
  }
  function enhance(root) {
    if (!root || !root.querySelectorAll) return Promise.resolve();
    var tasks = [];
    root.querySelectorAll('[data-diagram="pending"]').forEach(function (figure) {
      if (figure.closest('[hidden]')) return;
      figure.dataset.diagram = 'queued';
      // Mermaid owns global render state; serialize graphs, including separate roots.
      var task = serial.then(function () { return draw(figure); });
      serial = task.catch(function () {}); tasks.push(task);
    });
    return Promise.all(tasks);
  }
  function exportButton(root, source, filename) {
    if (!root || !root.querySelector) return;
    sources.set(root, {source:source, filename:filename});
    var button = root.querySelector(':scope > .md-export');
    if (!button) {
      button = document.createElement('button'); button.type = 'button'; button.className = 'md-export'; button.textContent = '导出 Markdown';
      button.onclick = function () { var current = sources.get(root); download(current.source, current.filename || '学习内容.md', 'text/markdown;charset=utf-8'); };
      root.appendChild(button);
    }
  }
  function copyMathSelection(event) {
    if (event.defaultPrevented || !event.clipboardData || !window.getSelection) return;
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
    var range = selection.getRangeAt(0), start = range.startContainer;
    var element = start.nodeType === 1 ? start : start.parentElement;
    var root = element && element.closest('.learn-markdown');
    if (!root || !root.contains(range.endContainer)) return;
    var math = Array.from(root.querySelectorAll('.katex')).filter(function (node) { return range.intersectsNode(node); });
    if (!math.length || math.some(function (node) { return !selection.containsNode(node, false); })) return;
    var fragment = range.cloneContents(), formulas = Array.from(fragment.querySelectorAll('.katex'));
    if (formulas.length !== math.length || formulas.some(function (node) { return !node.querySelector('annotation[encoding="application/x-tex"]'); })) return;
    formulas.forEach(function (node) {
      var tex = node.querySelector('annotation[encoding="application/x-tex"]').textContent;
      var delimiter = node.closest('.katex-display') ? '$$' : '$';
      node.replaceWith(document.createTextNode(delimiter + tex + delimiter));
    });
    var container = document.createElement('div');
    if (range.commonAncestorContainer.nodeName === 'TABLE') {
      var table = document.createElement('table'); table.appendChild(fragment); container.appendChild(table);
    } else container.appendChild(fragment);
    var html = container.innerHTML;
    container.querySelectorAll('br').forEach(function (node) { node.replaceWith(document.createTextNode('\n')); });
    container.querySelectorAll('table').forEach(function (table) {
      var rows = Array.from(table.rows).map(function (row) {
        return Array.from(row.cells).map(function (cell) { return cell.textContent.trim(); }).join('\t');
      });
      table.replaceWith(document.createTextNode(rows.join('\n') + '\n'));
    });
    container.querySelectorAll('tr,p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,.katex-display').forEach(function (node) { node.appendChild(document.createTextNode('\n')); });
    var text = container.textContent.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    try {
      event.clipboardData.setData('text/plain', text);
      event.clipboardData.setData('text/html', html);
      event.preventDefault();
    } catch (error) { /* Preserve native copy when the browser refuses clipboard data. */ }
  }
  if (typeof document !== 'undefined') document.addEventListener('copy', copyMathSelection);
  window.LearnMarkdown = {render:render, enhance:enhance, exportButton:exportButton};
})();
