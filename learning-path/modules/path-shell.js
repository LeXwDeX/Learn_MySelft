/* 阶段导航、进度、提示和复习标记。 */
define("path.shell", ["path.model", "path.format", "path.persistence", "path.domain", "path.hooks"], function (deps) {
  'use strict';
  var model = deps["path.model"];
  var format = deps["path.format"];
  var persistence = deps["path.persistence"];
  var domain = deps["path.domain"];
  var hooks = deps["path.hooks"];

function showError(msg, retry) {
    model.session.retryFn = retry || null;
    format.$('errtext').textContent = msg;
    format.$('errretry').hidden = !retry;
    format.$('errbar').hidden = false;
  }

function hideError() { format.$('errbar').hidden = true; model.session.retryFn = null; }

function setStage(s) {
    model.state.stage = s;
    if (model.session.materialsPanel) model.session.materialsPanel.lock(s !== 'intake' || model.session.busy);
    viewStage(s);
    persistence.save();
  }

// 阶段导航：只切视图，不改 state.stage（数据齐的阶段可随时回看）

function viewStage(s) {
    format.$('stage-intake').hidden = s !== 'intake';
    format.$('stage-research').hidden = s !== 'research';
    format.$('stage-learning').hidden = s !== 'learning';
    var qb = format.$('quizmap-btn');
    if (qb) qb.hidden = !(s === 'learning' && model.state.plan);
    var ga = format.$('gen-all-btn');
    if (ga) ga.hidden = !(s === 'learning' && model.state.plan);
    var rf = format.$('review-filter-btn');
    if (rf) rf.hidden = !(s === 'learning' && model.state.plan);
    if (rf) updateReviewFilterBtn();
    var tabs = document.querySelectorAll('.stab');
    for (var i = 0; i < tabs.length; i++) {
      var k = tabs[i].dataset.stage;
      tabs[i].classList.toggle('on', k === s);
      tabs[i].disabled = (k === 'research' && !model.state.spec) || (k === 'learning' && !model.state.plan);
    }
  }

function bindStageNav() {
    var tabs = document.querySelectorAll('.stab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        if (this.disabled) return;
        viewStage(this.dataset.stage);
      });
    }
  }

function renderProgress() {
    var nodes = (model.state.plan && model.state.plan.nodes) || [];
    var done = nodes.filter(function (n) { return domain.isDone(n.id); }).length;
    format.$('progress-text').textContent = '已完成 ' + done + '/' + nodes.length;
    format.$('progress-fill').style.width = nodes.length ? (done / nodes.length * 100) + '%' : '0%';
    updateReviewFilterBtn();
  }

function updateReviewFilterBtn() {
    var b = format.$('review-filter-btn');
    if (!b) return;
    b.textContent = '只看需复习 (' + domain.countReview() + ')';
    b.classList.toggle('on', model.session.reviewFilter);
  }

function markButtonsHtml(id, cls) {
    var cur = domain.markOf(id);
    return model.session.MARK_LABELS.map(function (kv) {
      return '<button class="mark-btn ' + cls + (cur === kv[0] ? ' on' : '') + '" type="button" ' +
        'data-mark="' + kv[0] + '" title="' + kv[1] + '">' + kv[1] + '</button>';
    }).join('');
  }

function setMark(id, mark) {
    var st = model.state.nodeState[id] || {};
    st.mark = mark;
    model.state.nodeState[id] = st;
    persistence.save();
    // 就地刷新该卡片的四态按钮（不重建 DOM，避免丢掉卡内问答输入）
    var card = format.$('node-' + id);
    if (card) {
      var btns = card.querySelectorAll('.mark-btn');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('on', btns[i].getAttribute('data-mark') === mark);
      }
    }
    updateReviewFilterBtn();
    // 过滤激活时，取消「需复习」标记的卡片应从列表消失
    if (model.session.reviewFilter && mark !== 'review') {
      if (model.session.expandedId === id) { model.session.expandedId = null; model.session.activeScope = null; }
      hooks.renderPlan();
    }
  }

// 把一组标记按钮的点击事件绑到容器（stopPropagation 避免触发卡片其它点击）

function bindMarkButtons(container, id) {
    var btns = container.querySelectorAll('.mark-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function (e) {
        e.stopPropagation();
        setMark(id, this.getAttribute('data-mark'));
      });
    }
  }

  return Object.freeze({showError: showError, hideError: hideError, setStage: setStage, viewStage: viewStage, bindStageNav: bindStageNav, renderProgress: renderProgress, updateReviewFilterBtn: updateReviewFilterBtn, markButtonsHtml: markButtonsHtml, setMark: setMark, bindMarkButtons: bindMarkButtons});
});
