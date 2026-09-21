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
  // Convert only known MathML structures; unknown operators/layout keep the full TeX.
  function readableMath(node) {
    var name = node.localName, children = Array.from(node.children || []);
    if (node.hasAttribute('mathvariant') && !['normal','italic'].includes(node.getAttribute('mathvariant'))) return null;
    if (name === 'mfrac' && node.hasAttribute('linethickness') && /^0(?:px|em|pt)?$/.test(node.getAttribute('linethickness'))) return null;
    if (['mi','mn','mo','mtext'].includes(name)) {
      var text = node.textContent.replace(/\u2061/g, ' ').replace(/\u2062/g, '×');
      return {text:text, html:escape(text)};
    }
    if (name === 'annotation') return {text:'', html:''};
    if (name === 'semantics') return readableMath(children[0]);
    var parts = children.map(readableMath);
    if (parts.some(function (part) { return !part; })) return null;
    var text = parts.map(function (part) { return part.text; }).join('');
    var html = parts.map(function (part) { return part.html; }).join('');
    if (['math','mrow','mstyle','mpadded'].includes(name)) return {text:text, html:html};
    if (name === 'mspace') return {text:' ',html:' '};
    if (name === 'mfrac' && parts.length === 2) return {text:'(' + parts[0].text + ')/(' + parts[1].text + ')',html:'(' + parts[0].html + ')/(' + parts[1].html + ')'};
    if (name === 'msqrt') return {text:'√(' + text + ')',html:'√(' + html + ')'};
    if (name === 'mroot' && parts.length === 2) return {text:'root(' + parts[1].text + ', ' + parts[0].text + ')',html:'root(' + parts[1].html + ', ' + parts[0].html + ')'};
    if (['msup','msub','msubsup'].includes(name) && parts.length >= 2) {
      if (/[∑∏∫∮]/.test(parts[0].text)) return null;
      var base = parts[0], simple = /^[\p{L}\p{N}]$/u.test(base.text);
      var result = {text:simple ? base.text : '(' + base.text + ')', html:simple ? base.html : '(' + base.html + ')'};
      parts.slice(1).forEach(function (part, index) {
        var sup = name === 'msup' || (name === 'msubsup' && index === 1);
        var digits = sup ? '⁰¹²³⁴⁵⁶⁷⁸⁹' : '₀₁₂₃₄₅₆₇₈₉';
        result.text += /^\d+$/.test(part.text) ? part.text.replace(/\d/g, function (n) {return digits[Number(n)];}) : (sup ? '^(' : '_(') + part.text + ')';
        result.html += (sup ? '<sup>' : '<sub>') + part.html + (sup ? '</sup>' : '</sub>');
      });
      return result;
    }
    return null;
  }
  function formulaHTML(tex, display) {
    if (window.katex) {
      try { return window.katex.renderToString(tex, {displayMode:display,throwOnError:true,trust:false,strict:'warn',maxExpand:1000}); }
      catch (error) { /* Keep the exact expression instead of guessing a correction. */ }
    }
    return '<span class="md-math-fallback" role="note"><span>公式暂无法排版，完整表达式：</span><code>' + escape(tex) + '</code></span>';
  }
  function teachingNotes(md) {
    // Capture definitions before CommonMark's link-reference rule can consume them.
    md.block.ruler.before('reference', 'learn_note_definition', function (state, line, end, silent) {
      if (state.sCount[line] - state.blkIndent >= 4) return false;
      var start = state.bMarks[line] + state.tShift[line];
      var match = /^\[\^([^\]\s]{1,64})\]:[ \t]*(.*)$/.exec(state.src.slice(start, state.eMarks[line]));
      if (!match) return false;
      if (silent) return true;
      var text = match[2], next = line + 1;
      while (next < end && !state.isEmpty(next) && state.sCount[next] >= state.blkIndent + 4) {
        text += '\n' + state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]); next++;
      }
      var open = state.push('blockquote_open','blockquote',1); open.attrSet('class','md-note');
      state.push('paragraph_open','p',1);
      var inline = state.push('inline','',0); inline.content = '补充说明〔' + match[1] + '〕：' + text; inline.children = [];
      state.push('paragraph_close','p',-1); state.push('blockquote_close','blockquote',-1);
      state.line = next; return true;
    }, {alt:['paragraph','reference','blockquote']});
    md.inline.ruler.before('link', 'learn_note_reference', function (state, silent) {
      var match = /^\[\^([^\]\s]{1,64})\]/.exec(state.src.slice(state.pos));
      if (!match) return false;
      if (!silent) { var token = state.push('text','',0); token.content = '〔补充说明 ' + match[1] + '〕'; }
      state.pos += match[0].length; return true;
    });
    md.core.ruler.before('inline', 'learn_callout', function (state) {
      state.tokens.forEach(function (token,index,tokens) {
        if (token.type !== 'blockquote_open' || !tokens[index+2] || tokens[index+2].type !== 'inline') return;
        var inline = tokens[index+2], labels = {NOTE:'补充说明',TIP:'学习提示',IMPORTANT:'重点',WARNING:'易错提醒',CAUTION:'注意'};
        inline.content = inline.content.replace(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\n|$)/, function (_,kind) {
          token.attrSet('class','md-note'); return labels[kind] + '：\n';
        });
      });
    });
  }
  function diagramFallback(figure, reason) {
    figure.dataset.diagram = 'failed';
    figure.querySelector('figcaption').textContent = reason + '，已保留文字讲解。';
    if (figure.querySelector('.md-diagram-fallback')) return;
    var source = figure.querySelector('code').textContent, lines = source.trim().split('\n');
    var relations = [], valid = /^(flowchart|graph)\s+(TD|TB|BT|LR|RL)\s*;?$/.test(lines[0].trim());
    var labels = Object.create(null);
    var node = '([A-Za-z][A-Za-z0-9_]*)(?:\\["([^"\\]<>]+)"\\])?';
    var edge = new RegExp('^\\s*' + node + '\\s*-->\\s*' + node + '\\s*;?\\s*$');
    lines.slice(1).filter(function (line) {return line.trim() && !/^\s*%%/.test(line);}).forEach(function (line) {
      var match = edge.exec(line);
      if (!match) {valid = false; return;}
      if (match[2]) { if (labels[match[1]] && labels[match[1]] !== match[2]) valid = false; labels[match[1]] = match[2]; }
      if (match[4]) { if (labels[match[3]] && labels[match[3]] !== match[4]) valid = false; labels[match[3]] = match[4]; }
      relations.push([match[1],match[3]]);
    });
    var fallback = document.createElement('p'); fallback.className = 'md-diagram-fallback';
    fallback.textContent = valid && relations.length ? '流程关系：' + relations.map(function (pair) {return (labels[pair[0]] || pair[0]) + ' → ' + (labels[pair[1]] || pair[1]);}).join('；') : '请先阅读本图前后的讲解；图示暂未显示，不影响其他内容。';
    figure.insertBefore(fallback, figure.querySelector('details'));
  }
  function unitFilename(course, index, title) {
    function safe(value, fallback) {
      var text = String(value || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g,' ').trim().replace(/[. ]+$/g,'');
      var bytes = 0, result = '';
      for (var character of Array.from(text || fallback)) {
        var code = character.codePointAt(0), size = code > 65535 ? 4 : code > 2047 ? 3 : code > 127 ? 2 : 1;
        if (bytes + size > 96) break;
        result += character; bytes += size;
      }
      return result;
    }
    var number = typeof index === 'string' && /^L[1-9]\d*(?:\.[1-9]\d*)*$/.test(index) ? index : (Number.isSafeInteger(index) && index > 0 ? 'L' + index : 'L未编号');
    return safe(course,'学习资料') + '_' + number + '_' + safe(title,'未命名单元') + '.md';
  }
  function getParser() {
    if (parser) return parser;
    if (!window.markdownit) return null;
    parser = window.markdownit({html:false, breaks:true, linkify:false});
    parser.core.ruler.after('block', 'learn_table_boundary', separateTableProse);
    teachingNotes(parser);
    parser.renderer.rules.learn_formula = function (tokens, index) { return formulaHTML(tokens[index].content, ['$$','\\['].includes(tokens[index].markup)); };
    // Keep LaTeX untouched by Markdown's backslash/underscore processing.
    parser.inline.ruler.before('escape', 'learn_math', function (state, silent) {
      var start = state.pos, opening = state.src.slice(start, start + 2);
      var delimiter = ['$$','\\(','\\['].includes(opening) ? opening : state.src[start] === '$' ? '$' : null;
      if (!delimiter) return false;
      var closing = delimiter === '\\(' ? '\\)' : delimiter === '\\[' ? '\\]' : delimiter;
      var end = state.src.indexOf(closing, start + delimiter.length);
      while (end >= 0 && state.src[end - 1] === '\\') end = state.src.indexOf(closing, end + closing.length);
      if (end < 0) return false;
      if (!silent) { var token = state.push('learn_formula', '', 0); token.content = state.src.slice(start + delimiter.length, end); token.markup = delimiter; }
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
      image.onerror = function () { image.remove(); figure.querySelectorAll('button').forEach(function (button) {button.remove();}); diagramFallback(figure, '图示暂无法显示'); };
      figure.insertBefore(image, figure.querySelector('details'));
      var button = document.createElement('button'); button.type = 'button'; button.textContent = '放大查看';
      button.onclick = function () { zoom(result.svg, button); }; figure.appendChild(button);
      var save = document.createElement('button'); save.type = 'button'; save.textContent = '下载图示';
      save.onclick = function () { download(result.svg, '知识图示.svg', 'image/svg+xml'); }; figure.appendChild(save);
      caption.textContent = '知识图示'; figure.dataset.diagram = 'ready';
    } catch (error) {
      if (!figure.isConnected) return;
      diagramFallback(figure, '图示暂无法显示');
    }
  }
  function enhance(root) {
    if (!root || !root.querySelectorAll) return Promise.resolve();
    root.querySelectorAll('[data-diagram="invalid"]').forEach(function (figure) { diagramFallback(figure, '图示尚不完整'); });
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
    if (!math.length || math.some(function (node) {
      var whole = document.createRange(); whole.selectNode(node);
      return range.compareBoundaryPoints(Range.START_TO_START, whole) > 0 || range.compareBoundaryPoints(Range.END_TO_END, whole) < 0;
    })) return;
    var fragment = range.cloneContents(), formulas = Array.from(fragment.querySelectorAll('.katex'));
    if (formulas.length !== math.length || formulas.some(function (node) { return !node.querySelector('annotation[encoding="application/x-tex"]'); })) return;
    formulas.forEach(function (node) {
      var tex = node.querySelector('annotation[encoding="application/x-tex"]').textContent;
      var mathml = node.querySelector('math'), readable = mathml && readableMath(mathml);
      var replacement = document.createElement('span'); replacement.className = 'md-copied-math';
      replacement.textContent = readable ? readable.text : tex;
      replacement.dataset.copyHtml = readable ? readable.html : escape(tex);
      node.replaceWith(replacement);
    });
    var container = document.createElement('div');
    if (range.commonAncestorContainer.nodeName === 'TABLE') {
      var table = document.createElement('table'); table.appendChild(fragment); container.appendChild(table);
    } else container.appendChild(fragment);
    var rich = container.cloneNode(true);
    rich.querySelectorAll('.md-copied-math').forEach(function (node) { node.innerHTML = node.dataset.copyHtml; node.removeAttribute('data-copy-html'); });
    var html = rich.innerHTML;
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
  window.LearnMarkdown = {render:render, enhance:enhance, exportButton:exportButton, unitFilename:unitFilename};
})();
