/* Shared identity, stable links and credentials for all learning pages. */
(function () {
  "use strict";
  var configuration = window.LearnConfig || {};
  var api = new URL(configuration.apiBase || (location.protocol + "//" + location.hostname + ":" + (configuration.apiPort || 8101)), location.href).href.replace(/\/$/, "");
  var apiURL = new URL(api);
  var match = location.pathname.match(/^\/learn\/u\/(u0|u[0-9a-f]{16})\//);
  var context = {
    apiBase: api,
    userId: match ? match[1] : null,
    user: null,
    target: null,
    readOnly: false,
  };
  var writes = new Set();
  var nativeFetch = window.fetch.bind(window);
  context.space = function (id) {
    return "/learn/u/" + encodeURIComponent(id || context.userId) + "/";
  };
  context.link = function (page) {
    return context.space() + (page || "");
  };
  context.fetch = function (url, options) {
    options = Object.assign({}, options || {});
    var target = new URL(url, location.href);
    var prefix = apiURL.pathname.replace(/\/$/, '');
    if (target.origin !== apiURL.origin || (prefix && !target.pathname.startsWith(prefix + '/'))) return nativeFetch(url, options);
    var endpoint = target.pathname.slice(prefix.length);
    var method = (options.method || "GET").toUpperCase();
    var read = method === "GET" || endpoint === "/path/quiz/state";
    if (context.readOnly && !read && !endpoint.startsWith("/auth/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: endpoint === "/state/put",
            read_only: true,
            error:
              endpoint === "/state/put"
                ? undefined
                : "管理员查看其他用户资料时只读",
          }),
          {
            status: endpoint === "/state/put" ? 200 : 403,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }
    if (context.exiting && !read && !endpoint.startsWith('/auth/')) {
      return Promise.resolve(new Response(JSON.stringify({error:'正在退出，草稿已保留在本机'}), {status:409, headers:{'Content-Type':'application/json'}}));
    }
    options.credentials = "include";
    options.headers = new Headers(options.headers || {});
    if (context.userId) options.headers.set("X-Learn-User", context.userId);
    var dispatch = function () { return nativeFetch(url, options); };
    var request = endpoint === '/state/put' && window.LearnSaves
      ? window.LearnSaves.send(options, dispatch) : dispatch();
    if ((endpoint === '/state/delete' || endpoint === '/state/del') && window.LearnSaves) {
      request = request.then(function (response) {
        if (response.ok) {
          var body = JSON.parse(options.body || '{}');
          window.LearnSaves.forget(body.keys || []);
        }
        return response;
      });
    }
    if (!read) {
      writes.add(request);
      request
        .finally(function () {
          writes.delete(request);
        })
        .catch(function () {});
    }
    return request;
  };
  context.request = function (path, body) {
    return context
      .fetch(
        api + path,
        body === undefined
          ? { cache: "no-store" }
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      )
      .then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok || data.ok === false || data.error)
            throw new Error(data.error || "请求失败");
          return data;
        });
      });
  };
  var logoutWork = null;
  async function logout() {
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 5000);
    var session;
    try {
      var response = await context.fetch(api + '/auth/session', {cache:'no-store', signal:controller.signal});
      if (!response.ok) throw new Error('无法确认登录状态，请检查网络后重试');
      session = await response.json();
    } finally { clearTimeout(timer); }
    if (session.user) {
      window.dispatchEvent(new Event('pagehide'));
      var waitTimer;
      try {
        await Promise.race([Promise.allSettled(Array.from(writes)), new Promise(function (resolve) { waitTimer = setTimeout(resolve, 5000); })]);
      } finally { clearTimeout(waitTimer); }
      if (window.LearnSaves && window.LearnSaves.pending()) {
        await window.LearnSaves.refresh();
        if (window.LearnSaves.pending() && !window.confirm('仍有内容未同步到服务器。保留本机草稿并退出？下次登录可以继续恢复。')) return;
      }
    }
    // Expired sessions cannot flush drafts. Keep them locally, then reconcile
    // against server tombstones after the next successful login.
    if (window.LearnSaves) window.LearnSaves.prepareExit();
    context.exiting = true;
    try {
      await context.request('/auth/logout', {});
      location.href = '/learn/';
    } catch (error) {
      context.exiting = false;
      if (window.LearnSaves) window.LearnSaves.cancelExit();
      throw error;
    }
  }
  context.logout = function () {
    if (!logoutWork) logoutWork = logout().finally(function () { logoutWork = null; });
    return logoutWork;
  };
  function domReady(callback) {
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", callback);
    else callback();
  }
  function errorView(message) {
    domReady(function () {
      var box = document.createElement("div");
      box.style.cssText =
        "position:fixed;inset:0;z-index:10000;background:#f5f5f5;display:grid;place-content:center;padding:32px;gap:16px";
      var text = document.createElement("p");
      text.textContent = message;
      var link = document.createElement("a");
      link.href = "/learn/";
      link.textContent = "返回首页登录或选择自己的空间";
      box.append(text, link);
      document.body.appendChild(box);
    });
  }
  function mountBar() {
    if (!context.user) return;
    domReady(function () {
      var style = document.createElement("style");
      style.textContent =
        ".user-bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:10px 24px;background:#fff;border-bottom:1px solid #ddd;font:13px/1.5 system-ui;color:#4f5d75}.user-bar a{color:#b64b22;text-decoration:none}.user-bar button{font:inherit;padding:4px 12px;border:1px solid #ddd;background:white;border-radius:5px;cursor:pointer}.user-bar .user-end{margin-left:auto}.user-bar strong{color:#2d3142}.user-readonly{background:#fff3dc;color:#7a4c00;padding:3px 8px;border-radius:4px}";
      document.head.appendChild(style);
      var bar = document.createElement("nav");
      bar.className = "user-bar";
      bar.setAttribute("aria-label", "用户导航");
      var name = document.createElement("strong");
      name.textContent = context.target.display_name + "的学习空间";
      var home = document.createElement("a");
      home.href = context.link("");
      home.textContent = "空间首页";
      bar.append(name, home);
      if (context.user.role === "admin") {
        var manage = document.createElement("a");
        manage.href = "/learn/";
        manage.textContent = "管理所有用户";
        bar.appendChild(manage);
      }
      if (context.readOnly) {
        var badge = document.createElement("span");
        badge.className = "user-readonly";
        badge.textContent = "管理员只读查看";
        bar.appendChild(badge);
      }
      var account = document.createElement("span");
      account.className = "user-end";
      account.textContent = "当前账号：" + context.user.username;
      var settings = document.createElement("a");
      settings.href = context.space(context.user.id) + "?account=1";
      settings.textContent = "修改密码";
      var logout = document.createElement("button");
      logout.type = "button";
      logout.textContent = "退出登录";
      logout.onclick = function () {
        logout.disabled = true;
        context.logout().catch(function (error) {
          alert(error.message);
        }).finally(function () { logout.disabled = false; });
      };
      bar.append(account, settings, logout);
      document.body.prepend(bar);
      if (context.readOnly) {
        var selectors =
          "#btn-reset,#gen-all-btn,#quizmap-btn,#restart-btn,#chat-send,#chat-input,#ai-send,#ai-text,#ai-file,#ai-attach,[data-mark],[data-state],#complete-node,#redo-quiz,#refine-node,.lib-del,#gaps-btn,#refine-btn,#again,[data-gen]";
        function freeze() {
          document.querySelectorAll(selectors).forEach(function (element) {
            if (!element.disabled) {
              element.disabled = true;
              element.title = "管理员只读查看";
            }
          });
        }
        freeze();
        new MutationObserver(freeze).observe(document.body, {
          childList: true,
          subtree: true,
        });
      }
    });
  }
  var onHome =
    /^\/learn\/(?:index\.html)?$/.test(location.pathname) ||
    (!!match && /\/$/.test(location.pathname));
  context.ready = context
    .request("/auth/session")
    .then(function (result) {
      if (!result.user) {
        if (!onHome) {
          location.replace("/learn/");
          return new Promise(function () {});
        }
        return context;
      }
      context.user = result.user;
      context.target = result.target;
      context.readOnly = result.read_only;
      context.userId = result.target.id;
      var oldPage = location.pathname.match(
        /\/diagram-design\/learning-path\/(learning-path\.html|quiz-map\.html)$/,
      );
      if (oldPage) {
        location.replace(context.link(oldPage[1]) + location.search);
        return new Promise(function () {});
      }
      if (!match && result.user.role !== "admin") {
        location.replace(context.space());
        return new Promise(function () {});
      }
      mountBar();
      return context;
    })
    .catch(function (error) {
      errorView(error.message);
      return new Promise(function () {});
    });
  window.LearnUser = context;
})();
