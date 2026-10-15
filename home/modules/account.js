define('home.account', ["home.platform"], function (deps) {
  var platform = deps['home.platform'];
  var context = platform.context, ui = platform.ui;
  var $ = ui.dom.byId, esc = ui.dom.escapeHTML, error = ui.dom.showError;
  $("login-form").addEventListener("submit", function (event) {
    event.preventDefault();
    error("login-error", "");
    $("login-submit").disabled = true;
    $("login-submit").textContent = "正在登录…";
    $("login-form").setAttribute("aria-busy", "true");
    context
      .request("/auth/login", {
        username: $("login-username").value,
        password: $("login-password").value,
      })
      .then(function (result) {
        $("login-password").value = "";
        location.href =
          result.user.role === "admin"
            ? "/learn/"
            : context.space(result.user.id);
      })
      .catch(function (e) {
        error("login-error", e.message);
        $("login-submit").disabled = false;
        $("login-submit").textContent = "登录";
        $("login-form").setAttribute("aria-busy", "false");
      });
  });
  var passwordBusy = false;
  ui.dialog.bind($("password-dialog"), $("password-cancel"), function () {
    error("password-error", "", "old-password");
  });
  $("password-dialog").addEventListener("cancel", function (event) {
    if (passwordBusy) event.preventDefault();
  });
  $("password-form").onsubmit = function (event) {
    event.preventDefault();
    if (passwordBusy) return;
    passwordBusy = true;
    error("password-error", "", "old-password");
    $("password-save").disabled = true;
    $("password-cancel").disabled = true;
    $("password-save").textContent = "正在保存…";
    $("password-form").setAttribute("aria-busy", "true");
    context
      .request("/auth/password", {
        old_password: $("old-password").value,
        new_password: $("new-password").value,
      })
      .then(function () {
        $("old-password").value = "";
        $("new-password").value = "";
        location.href = "/learn/";
      })
      .catch(function (e) {
        error("password-error", e.message, "old-password");
        $("old-password").focus();
      })
      .finally(function () {
        passwordBusy = false;
        $("password-save").disabled = false;
        $("password-cancel").disabled = false;
        $("password-save").textContent = "保存并重新登录";
        $("password-form").setAttribute("aria-busy", "false");
      });
  };

  return {};
});
