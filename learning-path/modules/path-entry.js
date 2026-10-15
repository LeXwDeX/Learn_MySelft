/* 页面装配；具名回调在此连接一次。 */
define("path.entry", ["path.model", "path.format", "path.persistence", "path.shell", "path.workflow", "path.cards", "path.assistant", "path.generation", "path.assessment", "path.library", "path.hooks"], function (deps) {
  'use strict';
  deps["path.hooks"].connect({renderDocumentTitle: deps["path.cards"].renderDocumentTitle, renderPlan: deps["path.cards"].renderPlan, refreshDirectory: deps["path.cards"].refreshDirectory, selectNode: deps["path.cards"].selectNode, genAllStart: deps["path.generation"].genAllStart, genQuizMap: deps["path.assessment"].genQuizMap, renderAgentPanel: deps["path.assistant"].renderAgentPanel, showAgent: deps["path.assistant"].showAgent, requestNodeDetail: deps["path.generation"].requestNodeDetail, syncAiMaterial: deps["path.assistant"].syncAiMaterial, renderNodeDetail: deps["path.assessment"].renderNodeDetail});
  var model = deps["path.model"];
  var format = deps["path.format"];
  var persistence = deps["path.persistence"];
  var shell = deps["path.shell"];
  var workflow = deps["path.workflow"];
  var cards = deps["path.cards"];
  var assistant = deps["path.assistant"];
  var generation = deps["path.generation"];
  var assessment = deps["path.assessment"];
  var library = deps["path.library"];

// ---------- 初始化 ----------
  // 学习资料从服务端恢复；临时阅读位置和待同步恢复由各自组件管理。

function init() { window.LearnUser.ready.then(boot); }

function boot() {
    model.session.quizCreation = new URLSearchParams(location.search).get("mode") === "quiz";
    assistant.bindAgentLayout();
    cards.bindWorkspace();
    function revisitStage(stage) {
      cards.captureReadingPosition();
      window.LearnUI.dialog.close(format.$('path-dialog'));
      if (stage === 'research') { workflow.renderSpecCard(); workflow.renderResearch(); }
      else workflow.renderChat();
      shell.viewStage(stage);
      var heading = format.$('stage-' + stage).querySelector('h2');
      if (heading) { heading.tabIndex = -1; heading.focus(); }
    }
    format.$('workspace-goal').addEventListener('click', function () { revisitStage('intake'); });
    format.$('workspace-research').addEventListener('click', function () { revisitStage('research'); });
    model.session.materialsPanel = window.LearnMaterials.mount(format.$('learning-materials'), {
      get: function () { return model.state.materials; },
      set: async function (next) {
        if (model.session.bootState !== 'ready' || window.LearnUser.readOnly) throw new Error('资料尚未准备好或当前为只读');
        model.state.materials = next;
        if (!model.state.topic && next.length) {
          model.state.topic = next[0].name.replace(/\.[^.]+$/, '');
          model.session.materialSlug = format.slug(model.state.topic) + '-' + window.LearnJobs.requestId().slice(0, 8);
          var url = new URL(location.href); url.searchParams.delete('new'); url.searchParams.set('t', model.session.materialSlug);
          window.history.replaceState(null, '', url.pathname + url.search);
          workflow.renderChat();
        }
        persistence.save(); await persistence.flushSave(); await persistence.waitForWrites();
      },
      busy: function (off) { workflow.setChatDisabled(off); }
    });
    workflow.setChatDisabled(false);
    if (model.session.quizCreation) {
      format.$('stage-intake').querySelector('h2').textContent = '用自己的资料创建测验地图';
      format.$('chat-input').placeholder = '说明测验范围、难度和目标，回车开始…';
    }
    format.$('chat-send').addEventListener('click', workflow.sendMessage);
    format.$('research-recheck').addEventListener('click', workflow.recheckResearch);
    format.$('chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); workflow.sendMessage(); }
    });
    format.$('restart-btn').addEventListener('click', library.restart);
    shell.bindStageNav();
    format.$('errretry').addEventListener('click', function () { var f = model.session.retryFn; shell.hideError(); if (f) f(); });
    format.$('backend-label').textContent = model.session.API;
    window.LearnUI.dialog.bind(format.$('del-modal'), null, function () { if (!format.$('del-modal').open) library.resetDeletion(); });
    format.$('dm-cancel').addEventListener('click', library.closeDelModal);
    format.$('dm-ok').addEventListener('click', library.submitDel);
    format.$('dm-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); library.submitDel(); } });
    format.$('del-modal').addEventListener('cancel', function (e) { e.preventDefault(); library.closeDelModal(); });
    format.$('quizmap-btn').addEventListener('click', assessment.genQuizMap);
    var gab = format.$('gen-all-btn');
    if (gab) gab.addEventListener('click', generation.onGenAllClick);
    var rfb = format.$('review-filter-btn');
    if (rfb) rfb.addEventListener('click', function () {
      model.session.reviewFilter = !model.session.reviewFilter;
      shell.updateReviewFilterBtn();
      cards.refreshDirectory();
    });
    if (window.LearnUser.readOnly) format.$('restart-btn').hidden = true;
    library.libBind();

    persistence.purgeLocalLegacy();   // 清理旧版资料缓存；保留临时阅读位置与待同步恢复。
    var bootRun = 0;
    function loadDocument() {
      var run = ++bootRun, search = location.search;
      model.session.bootState = 'loading';
      workflow.setChatDisabled(false);
      shell.hideError();
      persistence.serverLoad().then(function (restored) {
        if (run !== bootRun || search !== location.search) return;
        if (restored) {
          workflow.renderChat();
          if (model.state.spec) workflow.renderSpecCard();
          if (model.state.stage === 'learning' && model.state.plan) {
            shell.setStage('learning');
            cards.renderPlan();
          } else if (model.state.stage === 'research') {
            shell.setStage('research');
            workflow.renderResearch();
            format.$('research-status').innerHTML = '上次研究已完成或中断，<button class="btn" id="resume-research" type="button">继续生成路径</button>';
            var rb = format.$('resume-research');
            if (rb) rb.addEventListener('click', function () { workflow.startResearch(); });
          } else {
            shell.setStage('intake');
          }
        } else {
          shell.setStage('intake');
          workflow.renderChat();
        }
        workflow.setChatDisabled(false);
        model.session.materialsPanel.render();
        shell.renderProgress();
        assistant.renderAgentPanel();
        if (restored) assessment.restoreRequiz();
        if (restored && !window.LearnUser.readOnly) workflow.resumeIfPending();   // 上次生成中断→自动取回/重放（节点会自动展开卡片）
      }).catch(function (error) {
        if (run !== bootRun || search !== location.search || error.staleLoad) return;
        model.session.bootState = 'error';
        workflow.setChatDisabled(false);
        shell.showError('无法读取学习资料：' + error.message, loadDocument);
      });
    }
    loadDocument();
  }

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return Object.freeze({init: init, boot: boot});
});
