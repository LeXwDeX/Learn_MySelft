(function () {
  "use strict";
  var users = [],
    editing = null;
  var context = window.LearnUser;
  function $(id) {
    return document.getElementById(id);
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }
  function error(id, message) {
    $(id).textContent = message || "";
    $(id).hidden = !message;
  }
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
  var taskTimer = null;
  function loadTasks() {
    if (taskTimer) clearTimeout(taskTimer);
    return context.request('/jobs?view=recent').then(function (result) {
      var jobs = result.jobs.slice(0, 8);
      $('tasks-panel').hidden = !jobs.length;
      $('task-list').replaceChildren();
      jobs.forEach(function (job) {
        var row = document.createElement('div'); row.className = 'learn-task';
        var info = document.createElement('div');
        var title = document.createElement('strong'); title.textContent = job.title || '学习任务';
        var detail = document.createElement('small');
        var statuses = {queued: '排队中', running: '正在处理', succeeded: '已完成', failed: '未完成', interrupted: '等待恢复', cancelled: '已取消'};
        detail.textContent = window.LearnJobs.label(job.operation) + ' · ' + (statuses[job.status] || job.status) + ' · ' + new Date(job.created_ms).toLocaleString('zh-CN');
        info.append(title, detail);
        if (job.error) { var error = document.createElement('small'); error.textContent = job.error; info.appendChild(error); }
        row.appendChild(info);
        var actions = document.createElement('div'); actions.className = 'actions';
        var business = (job.key || '').slice(context.userId.length + 1);
        var page = business.startsWith('quiz-map-v1-') ? 'quiz-map.html' : 'learning-path.html';
        var slug = business.replace(/^(?:learn-path|quiz-map)-v1-/, '');
        var link = document.createElement('a'); link.className = 'btn'; link.href = context.link(page) + '?t=' + encodeURIComponent(slug); link.textContent = '继续查看';
        actions.appendChild(link);
        if (!context.readOnly && ['failed', 'interrupted'].includes(job.status)) {
          var retry = document.createElement('button'); retry.className = 'btn'; retry.textContent = '重试';
          retry.onclick = function () {
            retry.disabled = true;
            context.request('/jobs/' + job.id + '/retry', {}).then(loadTasks).catch(function (error) {
              window.LearnUI.set('tasks', error.message, 'error', loadTasks, '刷新状态');
            });
          };
          actions.appendChild(retry);
        }
        row.appendChild(actions); $('task-list').appendChild(row);
      });
      if (jobs.some(function (job) { return ['queued', 'running'].includes(job.status); })) taskTimer = setTimeout(loadTasks, 5000);
    }).catch(function (error) { window.LearnUI.set('tasks', '任务状态暂时不可用：' + error.message, 'error', loadTasks, '重新连接'); });
  }
  $('refresh-tasks').onclick = loadTasks;
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
    $("user-dialog").showModal();
    $("user-name").focus();
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
        $("user-dialog").close();
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
  function renderLibrary(entries) {
    var maps = [],
      quizzes = [],
      prefix = context.userId + "/";
    Object.keys(entries).forEach(function (key) {
      if (!key.startsWith(prefix) || typeof entries[key] !== "string") return;
      var business = key.slice(prefix.length),
        data;
      try {
        data = JSON.parse(entries[key]);
      } catch (e) {
        return;
      }
      if (!data || typeof data !== "object") return;
      if (
        business.startsWith("learn-path-v1-") &&
        business !== "learn-path-v1-last"
      ) {
        if (!data.topic && !data.plan && !(data.history || []).length) return;
        var total = ((data.plan || {}).nodes || []).length,
          done = Object.values(data.nodeState || {}).filter(function (n) {
            return n && n.completed;
          }).length;
        maps.push({
          slug: business.slice("learn-path-v1-".length),
          title:
            data.topic ||
            (data.plan || {}).title ||
            (data.spec || {}).topic ||
            "学习地图",
          meta: total
            ? done + "/" + total + " 单元已完成"
            : { intake: "正在确认学习目标", research: "正在研究学习资料" }[
                data.stage
              ] || "尚未生成路径",
        });
      } else if (business.startsWith("quiz-map-v1-")) {
        var result = data.lastResult || (data.attempts || []).slice(-1)[0];
        quizzes.push({
          slug: business.slice("quiz-map-v1-".length),
          title: data.title || "综合测验",
          meta:
            (data.questions || []).length +
            "题" +
            (result && typeof result.score === "number"
              ? " · 最近 " + result.score + " 分"
              : ""),
        });
      }
    });
    function rows(items, page) {
      return (
        items
          .map(function (item) {
            return (
              '<a class="row" href="' +
              context.link(page) +
              "?t=" +
              encodeURIComponent(item.slug) +
              '"><span>' +
              esc(item.title) +
              "<small>" +
              esc(item.meta) +
              '</small></span><span class="go">打开 →</span></a>'
            );
          })
          .join("") || '<p class="empty">这里还没有资料。</p>'
      );
    }
    $("map-list").innerHTML = rows(maps, "learning-path.html");
    $("quiz-list").innerHTML = rows(quizzes, "quiz-map.html");
    $("library-count").textContent = maps.length + quizzes.length + "份资料";
  }
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
  $("create-user").onclick = function () {
    openUser(null);
  };
  $("user-search").oninput = renderUsers;
  $("user-form").onsubmit = saveUser;
  $("user-cancel").onclick = function () {
    $("user-dialog").close();
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
  $("password-cancel").onclick = function () {
    $("password-dialog").close();
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
      loadUsers();
    }
    $("workspace").hidden = false;
    loadTasks();
    document.querySelectorAll("[data-page]").forEach(function (link) {
      link.href = context.link(link.dataset.page);
    });
    context
      .request("/state/all")
      .then(function (result) {
        renderLibrary(result.entries);
      })
      .catch(function (e) {
        error("library-error", e.message);
      });
    if (
      new URLSearchParams(location.search).get("account") &&
      context.userId === context.user.id
    ) {
      $("password-dialog").showModal();
      $("old-password").focus();
    }
  });
})();
