/* 学习数据同步 —— 浏览器 localStorage ⇄ 服务端（study-assistant :8096）
   策略：
   1) 写入即推：拦截所有 localStorage 写入，去抖 600ms 批量 POST /state/put（删除写墓碑）；
   2) 加载即拉：GET /state/all，以服务端为准写回本地，有差异自动刷新一次（≤2 次防环）；
   3) 兜底：页面隐藏/卸载时用 sendBeacon 冲掉未发送的改动；
   4) 静默降级：后端不可用时页面功能不受影响（改动先存本机，下次打开再补推）。
   调试开关：localStorage['__sync_off']='1' 可整体停用本脚本。 */
(function () {
  'use strict';
  if (window.__stateSyncLoaded) return;
  window.__stateSyncLoaded = true;
  try { if (localStorage.getItem('__sync_off') === '1') return; } catch (e) { return; }

  var API = location.protocol + '//' + location.hostname + ':8096';
  function keep(k) { return !!k && k.indexOf('__sync') !== 0; }

  /* ---- 1) 写入拦截 + 去抖推送 ---- */
  var oSet = Storage.prototype.setItem,
      oDel = Storage.prototype.removeItem,
      oClr = Storage.prototype.clear;
  var puts = {}, dels = {}, timer = null;

  function collect() {
    var p = puts, d = dels; puts = {}; dels = {};
    var entries = {}, ks = Object.keys(p), i;
    for (i = 0; i < ks.length; i++) if (keep(ks[i])) entries[ks[i]] = p[ks[i]];
    ks = Object.keys(d);
    for (i = 0; i < ks.length; i++) if (keep(ks[i])) entries[ks[i]] = null;
    return entries;
  }
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    var entries = collect();
    if (!Object.keys(entries).length) return;
    try {
      fetch(API + '/state/put', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: entries }), keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }
  function flushBeacon() {
    if (timer) { clearTimeout(timer); timer = null; }
    var entries = collect();
    if (!Object.keys(entries).length) return;
    var payload = JSON.stringify({ entries: entries });
    if (navigator.sendBeacon) {
      try { if (navigator.sendBeacon(API + '/state/put', new Blob([payload], { type: 'text/plain;charset=UTF-8' }))) return; } catch (e) {}
    }
    try {
      fetch(API + '/state/put', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: payload, keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }
  function schedule() { if (!timer) timer = setTimeout(flush, 600); }

  Storage.prototype.setItem = function (k, v) {
    oSet.call(this, k, v);
    try {
      var s = String(k);
      if (keep(s)) { delete dels[s]; puts[s] = String(v); schedule(); }
    } catch (e) {}
  };
  Storage.prototype.removeItem = function (k) {
    oDel.call(this, k);
    try {
      var s = String(k);
      if (keep(s)) { delete puts[s]; dels[s] = 1; schedule(); }
    } catch (e) {}
  };
  Storage.prototype.clear = function () {
    try {
      for (var i = 0; i < this.length; i++) {
        var s = this.key(i);
        if (keep(s)) { delete puts[s]; dels[s] = 1; }
      }
    } catch (e) {}
    oClr.call(this);
    schedule();
  };
  window.addEventListener('pagehide', flushBeacon);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushBeacon();
  });

  /* ---- 2) 加载即拉（服务端为准） ---- */
  var GUARD = '__sync_reloads', reloads = 0;
  try { reloads = parseInt(sessionStorage.getItem(GUARD) || '0', 10) || 0; } catch (e) {}
  try {
    fetch(API + '/state/all', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok || !j.entries) return;
      var server = j.entries, changed = false, migrate = {}, k;
      Object.keys(server).forEach(function (k2) {
        if (!keep(k2)) return;
        if (k2 in puts || k2 in dels) return;            // 本地刚改过：等推送，别用旧值覆盖
        var v = server[k2], local = localStorage.getItem(k2);
        if (v === null) {                                 // 墓碑：服务端已删除
          if (local !== null) { oDel.call(localStorage, k2); changed = true; }
        } else if (typeof v === 'string' && local !== v) {
          oSet.call(localStorage, k2, v);
          changed = true;
        }
      });
      try {                                               // 本地有、服务端没有 → 首次迁移推上去
        for (var i = 0; i < localStorage.length; i++) {
          k = localStorage.key(i);
          if (keep(k) && !(k in server)) migrate[k] = localStorage.getItem(k);
        }
      } catch (e) {}
      if (Object.keys(migrate).length) {
        for (k in migrate) puts[k] = migrate[k];
        flush();
      }
      if (changed) {
        if (reloads < 2) {                                // 写回本地后刷新一次让页面读到新数据；防环
          try { sessionStorage.setItem(GUARD, String(reloads + 1)); } catch (e) {}
          location.reload();
        }
      } else {
        try { sessionStorage.removeItem(GUARD); } catch (e) {}
      }
    }).catch(function () {});
  } catch (e) {}
})();
