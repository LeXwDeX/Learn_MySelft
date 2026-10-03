define('home.admin', ["home.platform"], function (deps) {
  var platform = deps['home.platform'];
  var context = platform.context, ui = platform.ui;
  var $ = ui.dom.byId, esc = ui.dom.escapeHTML, error = ui.dom.showError;
  var users = [], editing = null;
  function renderUsers() {
    var search = $("user-search").value.trim().toLowerCase();
    var shown = users.filter(function (user) {
      return (user.display_name + " " + user.username)
        .toLowerCase()
        .includes(search);
    });
    $("user-count").textContent = users.length + "人";
    $("user-list").innerHTML =
      shown
        .map(function (user) {
          var stats = user.stats;
          return (
            '<article class="card person" data-user="' +
            esc(user.id) +
            '"><div class="person-head"><span class="avatar">' +
            esc(user.display_name.slice(0, 1)) +
            "</span><div><h3>" +
            esc(user.display_name) +
            "</h3><p>" +
            esc(user.username) +
            '</p></div><span class="badge' +
            (!user.active ? " off" : "") +
            '">' +
            (user.role === "admin"
              ? "管理员"
              : user.active
                ? "正常"
                : "已停用") +
            '</span></div><div class="stats"><span><b>' +
            stats.maps +
            "</b>学习地图</span><span><b>" +
            stats.quizzes +
            "</b>测验</span><span><b>" +
            stats.completed_nodes +
            "/" +
            stats.total_nodes +
            '</b>已完成单元</span></div><div class="actions"><a class="btn primary" href="' +
            context.space(user.id) +
            '">' +
            (user.id === context.user.id ? "进入我的空间" : "查看学习资料") +
            "</a>" +
            (user.role === "user"
              ? '<button class="btn" data-edit="' +
                esc(user.id) +
                '">管理</button>'
              : "") +
            '<button class="btn" data-copy="' +
            esc(user.id) +
            '">复制入口</button></div></article>'
          );
        })
        .join("") || '<p class="empty">没有匹配的用户。</p>';
  }
  function loadUsers() {
    return context
      .request("/admin/users")
      .then(function (result) {
        users = result.users;
        renderUsers();
      })
      .catch(function (e) {
        error("admin-error", e.message);
      });
  }
  function openUser(id) {
    editing = id
      ? users.find(function (user) {
          return user.id === id;
        })
      : null;
    $("user-form").reset();
    error("user-error", "");
    $("user-dialog-title").textContent = editing
      ? "管理 " + editing.display_name
      : "创建用户";
    $("user-name").value = editing ? editing.display_name : "";
    $("user-username").value = editing ? editing.username : "";
    $("user-username").disabled = !!editing;
    $("user-password").required = !editing;
    $("user-password-label").textContent = editing
      ? "重置密码（选填）"
      : "初始密码";
    $("password-hint").textContent = editing
      ? "留空则保持原密码，填写后该用户需重新登录。"
      : "至少8个字符。";
    $("user-active-field").hidden = !editing;
    $("user-active").checked = editing ? editing.active : true;
    $("user-save").textContent = editing ? "保存修改" : "创建用户";
    $("user-save").disabled = false;
    ui.dialog.open($("user-dialog"), $("user-name"));
  }
  function saveUser(event) {
    event.preventDefault();
    $("user-save").disabled = true;
    error("user-error", "");
    var password = $("user-password").value,
      body,
      endpoint;
    if (editing) {
      var changes = {
        display_name: $("user-name").value,
        active: $("user-active").checked,
      };
      if (password) changes.password = password;
      body = { user_id: editing.id, changes: changes };
      endpoint = "/admin/users/update";
    } else {
      body = {
        display_name: $("user-name").value,
        username: $("user-username").value,
        password: password,
      };
      endpoint = "/admin/users/create";
    }
    context
      .request(endpoint, body)
      .then(function () {
        ui.dialog.close($("user-dialog"));
        $("user-form").reset();
        return loadUsers();
      })
      .catch(function (e) {
        error("user-error", e.message);
      })
      .finally(function () {
        $("user-save").disabled = false;
      });
  }
  $("create-user").onclick = function () {
    openUser(null);
  };
  $("user-search").oninput = renderUsers;
  $("user-form").onsubmit = saveUser;
  $("user-cancel").onclick = function () {
    ui.dialog.close($("user-dialog"));
    $("user-form").reset();
  };
  $("user-dialog").addEventListener("close", function () {
    $("user-password").value = "";
  });
  $("user-list").addEventListener("click", function (event) {
    var edit = event.target.closest("[data-edit]"),
      copy = event.target.closest("[data-copy]");
    if (edit) openUser(edit.dataset.edit);
    if (copy) {
      var url = location.origin + context.space(copy.dataset.copy);
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard
          .writeText(url)
          .then(function () {
            copy.textContent = "已复制";
          })
          .catch(function () {
            prompt("复制用户入口", url);
          });
      } else {
        prompt("复制用户入口", url);
      }
    }
  });

  return {load: loadUsers};
});
