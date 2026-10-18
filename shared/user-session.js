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
  var persistence = null;
  var shell = window.LearnUserShell;
  context.attachPersistence = function (port) {
    if (persistence) throw new Error("保存组件已注册");
    persistence = port;
  };
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
            ok: false,
            read_only: true,
            error: "管理员查看其他用户资料时只读，修改不会保存",
          }),
          {
            status: 403,
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
    var request = endpoint === '/state/put' && persistence
      ? persistence.send(options, dispatch) : dispatch();
    if (endpoint === '/state/delete' && persistence) {
      request = request.then(function (response) {
        if (response.ok) {
          var body = JSON.parse(options.body || '{}');
          persistence.forget(body.keys || []);
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
      if (persistence && persistence.pending()) {
        await persistence.refresh();
        if (persistence.pending() && !window.confirm('仍有内容未同步到服务器。保留本机草稿并退出？下次登录可以继续恢复。')) return;
      }
    }
    // Expired sessions cannot flush drafts. Keep them locally, then reconcile
    // against server tombstones after the next successful login.
    if (persistence) persistence.prepareExit();
    context.exiting = true;
    try {
      await context.request('/auth/logout', {});
      location.href = '/learn/';
    } catch (error) {
      context.exiting = false;
      if (persistence) persistence.cancelExit();
      throw error;
    }
  }
  context.logout = function () {
    if (!logoutWork) logoutWork = logout().finally(function () { logoutWork = null; });
    return logoutWork;
  };
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
      shell.mount(context);
      return context;
    })
    .catch(function (error) {
      shell.errorView(error.message);
      return new Promise(function () {});
    });
  window.LearnUser = context;
})();
