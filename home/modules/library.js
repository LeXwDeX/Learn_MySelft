define('home.library', ["home.platform"], function (deps) {
  var platform = deps['home.platform'];
  var context = platform.context, ui = platform.ui;
  var $ = ui.dom.byId, esc = ui.dom.escapeHTML, error = ui.dom.showError;
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

  return {render: renderLibrary};
});
