/* 资料标识和页面渲染适配。 */
define("path.format", ["path.model","page.format"], function (deps) {
  'use strict';
  var common = deps['page.format'];
  var model = deps["path.model"];


// ---------- 小工具 ----------

var $ = common.$;

var esc = common.esc;

function slug(s) {
    return String(s || 'untitled').toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'untitled';
  }

// 服务端状态键统一带固定用户前缀；做前缀匹配/列表扫描前先剥掉它再按原业务键逻辑处理

function stripUser(k) {
    return (typeof k === 'string' && k.indexOf(model.session.USER_PATH) === 0) ? k.slice(model.session.USER_PATH.length) : k;
  }

// 读状态：优先固定前缀键，兼容无前缀旧键（迁移未覆盖时的兜底）

function entryVal(entries, bizKey) {
    if (typeof entries[model.session.USER_PATH + bizKey] === 'string') return entries[model.session.USER_PATH + bizKey];
    if (typeof entries[bizKey] === 'string') return entries[bizKey];
    return undefined;
  }

// KaTeX：把 $...$ / $$...$$ 渲染成公式（失败不影响正文）

var renderMathIn = common.renderMathIn;

// 语法高亮：对迷你 Markdown 输出的代码块执行 highlight.js（库缺失时静默跳过）

var highlightIn = common.highlightIn;

// 迷你 Markdown：``` 围栏代码块 + 行内 `code`；文本换行由容器 pre-wrap 保留

var mdText = common.mdText;

var mdRender = common.mdRender;

function storeKey() { return model.session.USER_PATH + model.session.STORE_PREFIX + (model.session.materialSlug || slug(model.state.topic)); }

function aiKey() { return model.session.USER_PATH + 'learn-ai-v1-' + (model.session.materialSlug || slug(model.state.topic)); }

// 答案框自动扩展：随输入增高（以 CSS min-height 为下限）

var bindAutoGrow = common.bindAutoGrow;

var domain = common.domain;

  return Object.freeze({$: $, esc: esc, slug: slug, stripUser: stripUser, entryVal: entryVal, renderMathIn: renderMathIn, highlightIn: highlightIn, mdText: mdText, mdRender: mdRender, storeKey: storeKey, aiKey: aiKey, bindAutoGrow: bindAutoGrow, domain: domain});
});
