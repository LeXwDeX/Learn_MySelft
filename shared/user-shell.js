/* Identity presentation. The session supplies context; this module owns no requests. */
(function () {
  'use strict';
  var ui = window.LearnUI;
  function errorView(message) {
    ui.dom.ready(function () {
      var box = document.createElement('section');
      box.className = 'learn-session-error';
      box.setAttribute('role', 'alert');
      var text = document.createElement('p'); text.textContent = message;
      var link = document.createElement('a');
      link.href = '/learn/'; link.textContent = '返回首页登录或选择自己的空间';
      box.append(text, link); document.body.appendChild(box);
    });
  }
  function freezeReadOnly() {
    var selectors = '#btn-reset,#gen-all-btn,#quizmap-btn,#restart-btn,#chat-send,#chat-input,#ai-send,#ai-text,#ai-file,#ai-attach,[data-mark],[data-state],#complete-node,#redo-quiz,#refine-node,.lib-del,#gaps-btn,#refine-btn,#again,[data-gen]';
    function freeze() {
      document.querySelectorAll(selectors).forEach(function (element) {
        if (!element.disabled) { element.disabled = true; element.title = '管理员只读查看'; }
        var descriptions = (element.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
        if (descriptions.indexOf('learn-readonly-notice') === -1) {
          descriptions.push('learn-readonly-notice'); element.setAttribute('aria-describedby', descriptions.join(' '));
        }
      });
    }
    freeze();
    new MutationObserver(freeze).observe(document.body, {childList: true, subtree: true});
  }
  function mount(context) {
    if (!context.user) return;
    ui.dom.ready(function () {
      var bar = document.createElement('nav');
      bar.className = 'user-bar'; bar.setAttribute('aria-label', '用户导航');
      var name = document.createElement('strong'); name.textContent = context.target.display_name + '的学习空间';
      var home = document.createElement('a'); home.href = context.link(''); home.textContent = '空间首页';
      bar.append(name, home);
      if (context.user.role === 'admin') {
        var manage = document.createElement('a'); manage.href = '/learn/'; manage.textContent = '管理所有用户'; bar.appendChild(manage);
      }
      if (context.readOnly) {
        var badge = document.createElement('span'); badge.className = 'user-readonly'; badge.id = 'learn-readonly-notice'; badge.textContent = '只读查看：修改和生成不可用'; bar.appendChild(badge);
      }
      var account = document.createElement('span'); account.className = 'user-end'; account.textContent = '当前账号：' + context.user.username;
      var settings = document.createElement('a'); settings.href = context.space(context.user.id) + '?account=1'; settings.textContent = '修改密码';
      var button = document.createElement('button'); button.type = 'button'; button.textContent = '退出登录';
      button.onclick = function () {
        button.disabled = true;
        context.logout().catch(function (error) { alert(error.message); }).finally(function () { button.disabled = false; });
      };
      bar.append(account, settings, button); document.body.prepend(bar);
      if (context.readOnly) freezeReadOnly();
    });
  }
  window.LearnUserShell = Object.freeze({mount: mount, errorView: errorView});
})();
