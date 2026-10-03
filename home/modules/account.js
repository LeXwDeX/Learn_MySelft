define('home.account', ["home.platform"], function (deps) {
  var platform = deps['home.platform'];
  var context = platform.context, ui = platform.ui;
  var $ = ui.dom.byId, esc = ui.dom.escapeHTML, error = ui.dom.showError;
  $("login-form").addEventListener("submit", function (event) {
    event.preventDefault();
    error("login-error", "");
    $("login-submit").disabled = true;
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
      });
  });
  $("password-cancel").onclick = function () {
    ui.dialog.close($("password-dialog"));
  };
  $("password-form").onsubmit = function (event) {
    event.preventDefault();
    error("password-error", "");
    $("password-save").disabled = true;
    context
      .request("/auth/password", {
        old_password: $("old-password").value,
        new_password: $("new-password").value,
      })
      .then(function () {
        location.href = "/learn/";
      })
      .catch(function (e) {
        error("password-error", e.message);
        $("password-save").disabled = false;
      });
  };

  return {};
});
