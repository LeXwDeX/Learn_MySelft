define('home.entry', ["home.platform", "home.admin", "home.tasks", "home.account"], function (deps) {
  var platform = deps['home.platform'];
  var context = platform.context, ui = platform.ui;
  var $ = ui.dom.byId, esc = ui.dom.escapeHTML, error = ui.dom.showError;
  context.ready.then(function () {
    if (!context.user) {
      $("login-panel").hidden = false;
      $("login-username").focus();
      return;
    }
    var managing =
      context.user.role === "admin" && !/^\/learn\/u\//.test(location.pathname);
    $("page-title").textContent = managing
      ? "管理所有学习者"
      : context.target.display_name + "的学习空间";
    $("page-subtitle").textContent = managing
      ? "在这里创建和管理账号，查看每位用户的学习情况。每个用户都有独立入口与资料。"
      : context.readOnly
        ? "你正在只读查看该用户的资料，作答和学习进度不会被修改。"
        : "你的学习地图、讨论、测验和进度都保存在这个独立空间。";
    if (managing) {
      $("admin-panel").hidden = false;
      $("tools-title").textContent = "我的学习入口";
      deps['home.admin'].load();
    }
    $("workspace").hidden = false;
    $("tools-section").hidden = context.readOnly;
    deps['home.tasks'].load();
    document.querySelectorAll("[data-page]").forEach(function (link) {
      link.href = context.link(link.dataset.page);
    });
    if (
      new URLSearchParams(location.search).get("account") &&
      context.userId === context.user.id
    ) {
      ui.dialog.open($("password-dialog"), $("old-password"));
    }
  });

  return {};
});
