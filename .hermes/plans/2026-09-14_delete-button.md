# 删除资料按钮（需输入密码）设计文档

## Goal
「学习资料库」每条资料右侧增加 🗑 删除按钮；点击弹出密码框，密码正确才允许删除。**校验在服务端**（环境变量 `DELETE_PASSWORD`，真实值部署时注入 146，仓库不保存）。删的是服务端数据（墓碑语义）。

## 架构
- 服务端：新增 `POST /state/delete`，body `{"keys":[...],"password":"..."}`；服务端校验密码，错误返回 403 `{"ok":false,"error":"密码错误"}`。原 `/state/del`（内部维护通道）保持不变。
- 前端：资料库条目右侧 🗑 按钮 → 密码模态框 → 提交 `/state/delete` → 成功刷新资料库；若删的是当前打开的资料则跳 `?new=1`。

## 既有上下文（关键锚点）
- `study-assistant/study_assistant.py`：
  - 状态仓库配置段：`STATE_MAX_VALUE = 2_000_000`（第 ~70 行）
  - `do_POST` 中现有分支：`if path.startswith("/state/put") or path.startswith("/state/del"):`（第 ~964 行）
  - `/health` 的 endpoints 数组（第 ~717 行）
- `learning-path/path_template.html`：
  - `<style>` 结束于 `</style>`（第 175 行），其前一条规则是 `.lib-sub{...}`（174 行）
  - `#quiz-modal` 模态框标记结束于第 300 行，其后是 `</body>`
- `learning-path/path_app.js`：
  - `libRender()` 内条目 HTML（866-867 行）：`h += '<a class="lib-item" ...>...'`
  - `libBind()`（876-891 行）现有点击外部关闭：`document.addEventListener('click', function (e) { if (!pop.hidden && wrap && !wrap.contains(e.target)) pop.hidden = true; });`
  - `boot()` 中 quiz-modal 绑定（904-910 行）、`libBind();` 调用（911 行）
  - 全局函数 `slug(topic)`（主题→slug）与 `STORE_PREFIX`、`API`、`$`、`esc`、`libRender` 已有，直接复用
- `deploy/study-assistant.service`：`Environment=LLM_MODEL=deepseek`（第 12 行）

## Task 列表（按顺序）

### Task 1 — study_assistant.py：配置项
在 `STATE_MAX_VALUE = 2_000_000      # 单键值长度上限（字符）` 行后新增一行：
```python
DELETE_PASSWORD = os.environ.get("DELETE_PASSWORD", "")   # 「删除资料」按钮密码（/state/delete 校验）；未配置则拒绝删除
```

### Task 2 — study_assistant.py：新端点 `/state/delete`
在 `do_POST` 中**必须放在** `if path.startswith("/state/put") or path.startswith("/state/del"):` **之前**（否则 "/state/delete" 会先命中 "/state/del" 前缀分支）插入：
```python
        # 删除资料（学习资料库 🗑 按钮）：与 /state/del 分开、必须校验密码；注意放在 put/del 分支之前
        if path.startswith("/state/delete"):
            if not DELETE_PASSWORD:
                self._json(503, {"ok": False, "error": "服务端未配置删除密码"})
                return
            try:
                body = self._read_body()
            except Exception as e:
                self._json(400, {"error": "bad json: %s" % e})
                return
            if body.get("password") != DELETE_PASSWORD:
                self._json(403, {"ok": False, "error": "密码错误"})
                return
            keys = body.get("keys") or []
            entries = {k: None for k in keys if isinstance(k, str)}
            n = self._state_put(entries)
            self._json(200, {"ok": True, "n": n})
            return
```

### Task 3 — study_assistant.py：/health 端点清单
endpoints 数组里 `"/state/del"` 之后补 `"/state/delete"`。

### Task 4 — path_template.html：CSS（插在 `.lib-sub{...}` 行之后、`</style>` 之前）
```css
/* ---- 删除资料（需密码） ---- */
.lib-row{display:flex;align-items:stretch;gap:6px;margin:2px 0}
.lib-row .lib-item{flex:1 1 auto;margin:0;min-width:0}
.lib-del{flex:none;border:1px solid var(--rule);background:#fff;border-radius:6px;width:34px;color:var(--soft);cursor:pointer;font-size:14px;line-height:1;padding:0}
.lib-del:hover{border-color:#c0392b;color:#c0392b}
#del-modal{position:fixed;inset:0;z-index:110;display:flex;align-items:center;justify-content:center;background:rgba(45,49,66,.38)}
#del-modal[hidden]{display:none}
.dm-card{background:#fff;border:1px solid var(--rule);border-radius:10px;width:min(430px,92vw);box-shadow:0 18px 50px rgba(45,49,66,.18)}
.dm-body{padding:18px 22px 8px;font-size:14px;line-height:1.7}
.dm-tip{color:var(--soft);font-size:12.5px;margin:6px 0 0}
.dm-pass{width:100%;box-sizing:border-box;margin-top:10px;padding:9px 12px;border:1px solid var(--rule);border-radius:6px;font-size:14px;font-family:var(--sans)}
.dm-pass:focus{outline:none;border-color:var(--accent)}
.dm-err{color:#c0392b;font-size:12.5px;margin:8px 0 0}
.dm-foot{display:flex;gap:10px;justify-content:flex-end;padding:14px 22px;border-top:1px solid var(--rule);background:#fbfbfb;border-radius:0 0 10px 10px}
```

### Task 5 — path_template.html：模态框标记（插在 `#quiz-modal` 结束 `</div>` 之后、`</body>` 之前）
```html
<div id="del-modal" hidden>
  <div class="dm-card">
    <div class="dm-body">
      <p style="margin:0">删除学习资料「<b id="dm-topic"></b>」？</p>
      <p class="dm-tip">删除后将从服务端移除，无法恢复。请输入删除密码：</p>
      <input class="dm-pass" id="dm-pass" type="password" autocomplete="off" placeholder="删除密码">
      <p class="dm-err" id="dm-err" hidden>密码错误，请重试。</p>
    </div>
    <div class="dm-foot">
      <button class="btn" id="dm-cancel" type="button">取消</button>
      <button class="btn primary" id="dm-ok" type="button">确认删除</button>
    </div>
  </div>
</div>
```

### Task 6 — path_app.js：资料库条目加删除按钮（libRender 内）
现有：
```js
          h += '<a class="lib-item" href="learning-path.html?t=' + encodeURIComponent(it.slug) + '">' +
               '<span class="t">' + esc(it.topic) + '</span><span class="m">' + esc(meta) + '</span></a>';
```
替换为：
```js
          h += '<div class="lib-row">' +
               '<a class="lib-item" href="learning-path.html?t=' + encodeURIComponent(it.slug) + '">' +
               '<span class="t">' + esc(it.topic) + '</span><span class="m">' + esc(meta) + '</span></a>' +
               '<button class="lib-del" type="button" data-slug="' + esc(it.slug) + '" data-topic="' + esc(it.topic) + '" title="删除这份资料">🗑</button>' +
               '</div>';
```

### Task 7 — path_app.js：libBind 内调整
(a) 在 `btn.addEventListener('click', ...)` 之后新增（事件委托，pop 持久不随 innerHTML 重建）：
```js
    pop.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('.lib-del') : null;
      if (b) { e.stopPropagation(); openDelModal(b.getAttribute('data-slug'), b.getAttribute('data-topic')); }
    });
```
(b) 将现有：
```js
    document.addEventListener('click', function (e) {
      if (!pop.hidden && wrap && !wrap.contains(e.target)) pop.hidden = true;
    });
```
改为：
```js
    document.addEventListener('click', function (e) {
      var dm = $('del-modal');
      if (!pop.hidden && wrap && !wrap.contains(e.target) && !(dm && !dm.hidden && dm.contains(e.target))) pop.hidden = true;
    });
```

### Task 8 — path_app.js：删除逻辑函数（放在 `libBind()` 函数之后、`// ---------- 初始化` 注释之前）
```js
  // ---------- 删除资料（需密码；校验在服务端） ----------
  var delSlug = null;
  function openDelModal(s, topic) {
    delSlug = s;
    $('dm-topic').textContent = topic || s;
    var err = $('dm-err'); if (err) err.hidden = true;
    var inp = $('dm-pass'); if (inp) inp.value = '';
    $('del-modal').hidden = false;
    if (inp) inp.focus();
  }
  function closeDelModal() {
    $('del-modal').hidden = true;
    delSlug = null;
  }
  function submitDel() {
    if (!delSlug) return;
    var target = delSlug;
    var pass = ($('dm-pass') || {}).value || '';
    fetch(API + '/state/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [STORE_PREFIX + target], password: pass })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) {
        var wasCurrent = slug(state.topic || '') === target;
        closeDelModal();
        if (wasCurrent) { location.href = location.pathname + '?new=1'; return; }
        libRender();
        var pop = $('lib-pop'); if (pop) pop.hidden = false;
      } else {
        var err = $('dm-err');
        if (err) { err.textContent = (j && j.error) || '删除失败'; err.hidden = false; }
      }
    }).catch(function () {
      var err = $('dm-err');
      if (err) { err.textContent = '网络错误，请重试'; err.hidden = false; }
    });
  }
```
注意：`slug()` 是既有全局函数（主题→slug）；本段参数命名用 `s`/`target`，**不要用 `slug` 做参数名**以免遮蔽。

### Task 9 — path_app.js：boot() 绑定（在 quiz-modal 的 `keydown` 绑定之后、`libBind();` 之前插入）
```js
    $('dm-cancel').addEventListener('click', closeDelModal);
    $('dm-ok').addEventListener('click', submitDel);
    $('dm-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitDel(); });
    $('del-modal').addEventListener('click', function (e) { if (e.target === this) closeDelModal(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('del-modal').hidden) closeDelModal();
    });
```

### Task 10 — deploy/study-assistant.service：加环境变量行
在 `Environment=LLM_MODEL=deepseek` 后加两行：
```
# 删除密码：部署时注入真实值（仓库不保存）；未配置则 /state/delete 拒绝删除
Environment=DELETE_PASSWORD=CHANGE_ME
```

### Task 11 — 重生成 + 自检
- `cd learning-path && node --check path_app.js` → 通过
- `python3 -m py_compile /home/suntao/projects/ZiXueShe/study-assistant/study_assistant.py` → 通过
- `cd learning-path && python3 gen_path_page.py` → 生成 learning-path.html
- 自检：
  - `grep -c "del-modal" learning-path.html` ≥ 3（CSS+标记+JS）
  - `grep -c "state/delete" learning-path.html` ≥ 1
  - `grep -n "state/delete" study-assistant/study_assistant.py` —— 确认新分支行号 < put/del 分支行号
  - `git diff --stat` 仅允许：study-assistant/study_assistant.py、learning-path/path_app.js、learning-path/path_template.html、learning-path/learning-path.html、deploy/study-assistant.service

## 验证标准（Hermes 终验会执行）
1. 部署后浏览器实测：资料库出现 🗑 → 点击弹出密码框 → 错误密码显示「密码错误」且资料仍在（服务端仍存活）→ 正确密码后条目消失、服务端变墓碑；截图留证。
2. `curl /state/delete` 错误密码 → 403；正确密码 → 200 且置墓碑。
3. `/health` 的 endpoints 含 `/state/delete`。

## 风险
- **前缀碰撞**：`"/state/delete".startswith("/state/del") == True` → 新分支必须在 put/del 分支**之前**（Task 2 已强调），否则密码校验被绕过。
- 密码不得写入仓库任何文件（service 用 CHANGE_ME；146 上部署时注入真实值）。
- 资料库 innerHTML 整体重建 → 删除按钮务必用事件委托（绑定在持久的 `#lib-pop` 上），不要绑定到单个按钮。
- 删除当前打开的资料 → `?new=1` 重新开始（不留在空白页）。
