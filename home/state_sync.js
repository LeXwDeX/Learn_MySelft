/* 学习数据同步 —— 浏览器 localStorage ⇄ 服务端（study-assistant :8101）
   策略：
   1) 写入即推：拦截所有 localStorage 写入，去抖 600ms 批量 POST /state/put（删除写墓碑）；
   2) 加载即拉：GET /state/all，以服务端为准写回本地，有差异自动刷新一次（≤2 次防环）；
      墓碑（v=null）优先：即使本地刚写入过，服务端墓碑也会删除本地并撤销待推送（防旧设备把已删数据顶回来）；
   3) 空壳保护：历史脏数据（learn-path-v1-* 无主题、无路径、无对话的空状态）不上推、不下发；
      若本地有内容而服务端是空壳，用本地上推修复服务端（防止服务器空壳覆盖设备上的真实数据）；
   4) 兜底：页面隐藏/卸载时用 sendBeacon 冲掉未发送的改动；
   5) 静默降级：后端不可用时页面功能不受影响（改动先存本机，下次打开再补推）。
   调试开关：localStorage['__sync_off']='1' 可整体停用本脚本。
   页面用原始删除（不产生墓碑）：window.__syncRawRemove(key) —— 供清理历史空壳使用。 */
(function () {
  'use strict';
  if (window.__stateSyncLoaded) return;
  window.__stateSyncLoaded = true;
  try { if (localStorage.getItem('__sync_off') === '1') return; } catch (e) { return; }

  var API = location.protocol + '//' + location.hostname + ':8101';
  function keep(k) { return !!k && k.indexOf('__sync') !== 0; }

  // 空壳判定：历史脏数据既不上推也不下发（本地有真实内容时以本地为准并回推修复）
  function isJunkVal(k, v) {
    if (typeof v !== 'string' || !v) return false;
    if (k.indexOf('learn-path-v1-') === 0) {
      try {
        var d = JSON.parse(v);
        if (!d || typeof d !== 'object') return true;
        return !d.topic && !d.plan && (!d.history || !d.history.length);
      } catch (e) { return false; }
    }
    return v === '{}' || v === 'null' || v === '[]';
  }

  /* ---- 1) 写入拦截 + 去抖推送 ---- */
  var oSet = Storage.prototype.setItem,
      oDel = Storage.prototype.removeItem,
      oClr = Storage.prototype.clear;
  var puts = {}, dels = {}, timer = null;

  // 原始删除：绕过同步层（不产生删除墓碑）
  window.__syncRawRemove = function (k) { try { oDel.call(localStorage, k); } catch (e) {} };

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
      var s = String(k), vs = String(v);
      if (keep(s) && !isJunkVal(s, vs)) { delete dels[s]; puts[s] = vs; schedule(); }
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

  /* ---- 2) 加载即拉（服务端为准；空壳除外） ---- */
  var GUARD = '__sync_reloads', reloads = 0;
  try { reloads = parseInt(sessionStorage.getItem(GUARD) || '0', 10) || 0; } catch (e) {}
  try {
    fetch(API + '/state/all', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok || !j.entries) return;
      var server = j.entries, changed = false, migrate = {}, k;
      Object.keys(server).forEach(function (k2) {
        if (!keep(k2)) return;
        var v = server[k2], local = localStorage.getItem(k2);
        if (v === null) {                                 // 墓碑优先：撤销待推送并删除本地（防旧设备顶回）
          delete puts[k2]; delete dels[k2];
          if (local !== null) { oDel.call(localStorage, k2); changed = true; }
          return;
        }
        if (k2 in puts || k2 in dels) return;            // 本地刚改过：等推送，别用旧值覆盖
        if (isJunkVal(k2, v)) {                           // 服务端是空壳：不下发；本地有内容则回推修复
          if (local !== null && !isJunkVal(k2, local)) { puts[k2] = local; flush(); }
          return;
        }
        if (typeof v === 'string' && local !== v) {
          oSet.call(localStorage, k2, v);
          changed = true;
        }
      });
      try {                                               // 本地有、服务端没有的键 → 首次迁移推上去（空壳除外）
        for (var i = 0; i < localStorage.length; i++) {
          k = localStorage.key(i);
          if (keep(k) && !(k in server) && !isJunkVal(k, localStorage.getItem(k))) migrate[k] = localStorage.getItem(k);
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
