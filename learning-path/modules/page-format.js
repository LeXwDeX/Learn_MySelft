/* Common page rendering adapters. The UI Kit owns DOM primitives. */
define('page.format', [], function () {
  'use strict';
function $(id) { return window.LearnUI.dom.byId(id); }

function esc(value) { return window.LearnUI.dom.escapeHTML(value); }

function renderMathIn(el) {
    if (window.LearnMarkdown) window.LearnMarkdown.enhance(el);
    if (!el || typeof window.renderMathInElement !== 'function') return;
    try {
      window.renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\(', right: '\\)', display: false },
          { left: '$', right: '$', display: false }
        ],
        throwOnError: false,
        ignoredClasses: ['learn-markdown', 'katex', 'md-math-fallback'],
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option']
      });
    } catch (e) { /* 渲染失败保留原始文本 */ }
  }

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

function mdText(t) {
    return esc(t)
      .replace(/`([^`\n]+)`/g, function (_, c) { return '<code class="md-inline">' + c + '</code>'; })
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  }

function mdRender(text, options) {
    return window.LearnMarkdown ? window.LearnMarkdown.render(text, options) : mdText(String(text || ''));
  }

function bindAutoGrow(el) {
    if (!el || el.__ag) return;
    el.__ag = true;
    var fit = function () {
      el.style.height = 'auto';
      var mh = parseFloat(window.getComputedStyle(el).minHeight) || 140;
      el.style.height = Math.max(el.scrollHeight, mh) + 'px';
    };
    el.addEventListener('input', fit);
    fit();
  }

function domain(u) { try { return new URL(u).hostname; } catch (e) { return u; } }
  return Object.freeze({$: $, esc: esc, renderMathIn: renderMathIn, highlightIn: highlightIn, mdText: mdText, mdRender: mdRender, bindAutoGrow: bindAutoGrow, domain: domain});
});
