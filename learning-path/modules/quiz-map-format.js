/* 资料标识和共用渲染适配。 */
define("quiz-map.format", ["quiz-map.model","page.format"], function (deps) {
  'use strict';
  var common = deps['page.format'];
  var model = deps["quiz-map.model"];

var $ = common.$;

var esc = common.esc;

function param(k) {
    try { return new URLSearchParams(location.search).get(k); } catch (e) { return null; }
  }

// 服务端状态键统一带固定用户前缀；扫描/匹配前先剥掉它再按原业务键逻辑

function stripUser(k) {
    return (typeof k === 'string' && k.indexOf(model.session.USER_PATH) === 0) ? k.slice(model.session.USER_PATH.length) : k;
  }

// 读状态：优先固定前缀键，兼容无前缀旧键

function entryVal(entries, bizKey) {
    if (typeof entries[model.session.USER_PATH + bizKey] === 'string') return entries[model.session.USER_PATH + bizKey];
    if (typeof entries[bizKey] === 'string') return entries[bizKey];
    return undefined;
  }

var renderMathIn = common.renderMathIn;

var highlightIn = common.highlightIn;

var mdText = common.mdText;

var mdRender = common.mdRender;

// 知识点标签归一显示：内部 n1 → 展示 L1

function dispPoint(s) { return String(s == null ? '' : s).replace(/\bn(\d+)\b/g, 'L$1'); }

  return Object.freeze({$: $, esc: esc, param: param, stripUser: stripUser, entryVal: entryVal, renderMathIn: renderMathIn, highlightIn: highlightIn, mdText: mdText, mdRender: mdRender, dispPoint: dispPoint});
});
