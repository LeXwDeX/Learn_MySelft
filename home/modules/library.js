define('home.library', ["home.platform"], function (deps) {
  var platform = deps['home.platform'];
  var context = platform.context, ui = platform.ui;
  var $ = ui.dom.byId, esc = ui.dom.escapeHTML, error = ui.dom.showError;
  var loadVersion = 0;
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
              esc(item.meta) +
              '</small></span><span class="go">打开 →</span></a>'
            );
          })
          .join("") || '<p class="empty">' + (context.readOnly ? '该用户还没有这类资料。' :
            page === 'learning-path.html' ? '还没有学习地图。从上方「从一个目标开始」创建第一份。' :
              '还没有测验地图。可从学习地图生成，或打开上方测验地图入口。') + '</p>'
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
    var version = ++loadVersion, button = $('refresh-library');
    $('library-panel').setAttribute('aria-busy', 'true');
    $('library-status').textContent = '正在读取学习资料…';
    $('library-status').hidden = false;
    button.disabled = true;
    return context.request('/state/all').then(function (result) {
      if (version !== loadVersion) return;
      if (!result.entries || typeof result.entries !== 'object' || Array.isArray(result.entries)) throw new Error('资料响应不完整，请重新读取。');
      renderLibrary(result.entries);
      error('library-error', '');
    }).catch(function (cause) {
      if (version !== loadVersion) return;
      error('library-error', '暂时无法读取学习资料。请点击「刷新资料」重试。' + (cause.message || ''));
    }).finally(function () {
      if (version !== loadVersion) return;
      $('library-panel').setAttribute('aria-busy', 'false');
      $('library-status').hidden = true;
      button.disabled = false;
    });
  }
  $('refresh-library').onclick = loadLibrary;

  return {render: renderLibrary, load: loadLibrary};
});
