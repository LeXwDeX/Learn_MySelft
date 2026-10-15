define('home.library', ["home.platform"], function (deps) {
  var platform = deps['home.platform'];
  var context = platform.context, ui = platform.ui;
  var $ = ui.dom.byId, esc = ui.dom.escapeHTML, error = ui.dom.showError;
  var loadVersion = 0, hasSnapshot = false;
  function renderLibrary(entries) {
    hasSnapshot = true;
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
        var nodes = Array.isArray((data.plan || {}).nodes) ? data.plan.nodes : [],
          total = nodes.length,
          done = nodes.filter(function (node) {
            return node && (data.nodeState || {})[node.id] && data.nodeState[node.id].completed;
          }).length;
        maps.push({
          slug: business.slice("learn-path-v1-".length),
          title: platform.titles.document(data),
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
          title: platform.titles.document(data),
          meta:
            (data.questions || []).length +
            "题" +
            (result && typeof result.score === "number"
              ? " · 最近 " + result.score + " 分"
              : ""),
        });
      }
    });
    var last = entries[prefix + 'learn-path-v1-last'];
    var previous = typeof last === 'string' && maps.find(function (item) { return item.slug === last; });
    $('new-learning').hidden = context.readOnly;
    var link = $('continue-link');
    link.hidden = false;
    if (previous) {
      $('continue-title').textContent = '继续学习';
      $('continue-description').textContent = previous.title + ' · ' + previous.meta;
      link.href = context.link('learning-path.html') + '?t=' + encodeURIComponent(previous.slug);
      link.textContent = '继续上次打开的学习';
    } else if (maps.length || quizzes.length) {
      $('continue-title').textContent = '从已有资料继续';
      $('continue-description').textContent = maps.length ? '在资料库中选择要继续的学习。' : '你已有测验资料，可以继续作答或回看结果。';
      link.href = maps.length ? '#map-list' : '#quiz-list';
      link.textContent = maps.length ? '选择学习资料' : '查看测验资料';
    } else {
      $('continue-title').textContent = context.readOnly ? '还没有学习资料' : '开始你的第一次学习';
      $('continue-description').textContent = context.readOnly ? '该用户还没有保存学习或测验资料。' : '说说想学什么，学习助手会和你一起确定目标、准备资料与学习路径。';
      link.hidden = true;
    }
    function rows(items, page) {
      return (
        items
          .map(function (item) {
            return (
              '<a class="row" href="' +
              context.link(page) +
              "?t=" +
              encodeURIComponent(item.slug) +
              '"><span class="row-info"><span class="row-title">' +
              esc(item.title) +
              "</span><small>" +
              esc(item.meta + (page === 'learning-path.html' && previous && previous.slug === item.slug ? ' · 上次打开' : '')) +
              '</small></span><span class="go">打开 →</span></a>'
            );
          })
          .join("") || '<p class="empty">' + (context.readOnly ? '该用户还没有这类资料。' :
            page === 'learning-path.html' ? '还没有学习资料。从上方「开始新学习」创建第一份。' :
              '还没有测验资料。可从学习路径生成，或选择「开始综合测验」。') + '</p>'
      );
    }
    function updateList(id, markup) {
      var list = $(id);
      if (list.innerHTML === markup) return;
      var focused = list.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
      list.innerHTML = markup;
      if (focused) list.querySelectorAll('a').forEach(function (link) {
        if (link.getAttribute('href') === focused) link.focus({preventScroll: true});
      });
    }
    updateList("map-list", rows(maps, "learning-path.html"));
    updateList("quiz-list", rows(quizzes, "quiz-map.html"));
    $("library-count").textContent = maps.length + quizzes.length + "份资料";
  }

  function loadLibrary() {
    var version = ++loadVersion, button = $('refresh-library'), restoreFocus = false;
    $('library-panel').setAttribute('aria-busy', 'true');
    $('library-status').textContent = '正在读取学习资料…';
    $('continue-panel').setAttribute('aria-busy', 'true');
    if (!hasSnapshot) $('continue-link').hidden = true;
    $('library-status').hidden = false;
    button.disabled = true;
    return context.request('/state/all').then(function (result) {
      if (version !== loadVersion) return;
      if (!result.entries || typeof result.entries !== 'object' || Array.isArray(result.entries)) throw new Error('资料响应不完整，请重新读取。');
      renderLibrary(result.entries);
      error('library-error', '');
    }).catch(function (cause) {
      if (version !== loadVersion) return;
      var continueLink = $('continue-link');
      restoreFocus = document.activeElement === continueLink;
      continueLink.hidden = true;
      $('continue-title').textContent = '资料暂时无法读取';
      $('continue-description').textContent = '已有资料未被清空。请刷新资料后再选择继续学习。';
      error('library-error', '暂时无法读取学习资料。请点击「刷新资料」重试。' + (cause.message || ''));
    }).finally(function () {
      if (version !== loadVersion) return;
      $('library-panel').setAttribute('aria-busy', 'false');
      $('continue-panel').setAttribute('aria-busy', 'false');
      $('library-status').hidden = true;
      button.disabled = false;
      if (restoreFocus) button.focus({preventScroll: true});
    });
  }
  $('refresh-library').onclick = loadLibrary;

  return {render: renderLibrary, load: loadLibrary};
});
