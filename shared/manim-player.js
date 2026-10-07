/* Authenticated ManimGL media. Each step owns a bounded frame interval. */
(function () {
  'use strict';
  var players = new WeakMap();
  function text(value, max) { return typeof value === 'string' && value.length <= max; }
  function reference(raw) {
    var ref = JSON.parse(raw);
    if (!ref || ref.version !== 1 || !/^[a-f0-9]{32}$/.test(ref.asset_id) || !text(ref.title, 200) || !text(ref.summary, 2000)) throw new Error('动画引用无效');
    return ref;
  }
  function validate(manifest, id) {
    if (!manifest || manifest.version !== 1 || manifest.asset_id !== id || manifest.fps !== 30 || manifest.width !== 1280 || manifest.height !== 720 || !Number.isFinite(manifest.duration) || manifest.duration <= 0 || manifest.duration > 90 || !manifest.engine || manifest.engine.name !== 'ManimGL' || manifest.engine.version !== '1.7.2' || !Array.isArray(manifest.steps) || manifest.steps.length < 1 || manifest.steps.length > 8) throw new Error('动画清单无效');
    var end = 0;
    manifest.steps.forEach(function (step) {
      if (!step || !text(step.caption, 1000) || !step.caption.trim() || !Number.isInteger(step.start_frame) || !Number.isInteger(step.end_frame) || !Number.isInteger(step.result_frame) || !Number.isInteger(step.hold_start_frame) || step.hold_start_frame < step.start_frame || step.hold_start_frame > step.end_frame - 21 || step.start_frame !== end || step.end_frame - step.start_frame < 21 || step.result_frame !== step.end_frame - 1) throw new Error('动画步骤无效');
      end = step.end_frame;
    });
    if (Math.abs(end / manifest.fps - manifest.duration) > 1 / manifest.fps + 0.00001) throw new Error('动画时长无效');
    return manifest;
  }
  function mediaBase(id) {
    var user = window.LearnUser;
    return user.apiBase.replace(/\/$/, '') + '/manim/assets/' + id + '/';
  }
  function mediaURL(base, file) {
    var user = window.LearnUser;
    return base + file + (user.userId ? '?user=' + encodeURIComponent(user.userId) : '');
  }
  function build(figure, ref) {
    var doc = figure.ownerDocument;
    function element(tag, cls, content) {
      var node = doc.createElement(tag);
      if (cls) node.className = cls;
      if (content !== undefined) node.textContent = content;
      return node;
    }
    var shell = element('section', 'learn-manim');
    var title = element('h4', '', ref.title), summary = element('p', 'learn-manim-summary', ref.summary);
    var screen = element('div', 'learn-manim-screen');
    var video = element('video');
    video.preload = 'none'; video.playsInline = true; video.crossOrigin = 'use-credentials';
    video.setAttribute('aria-label', ref.title + '，ManimGL 教学动画');
    var snapshot = element('img', 'learn-manim-snapshot');
    snapshot.crossOrigin = 'use-credentials'; snapshot.alt = '本步结果'; snapshot.hidden = true;
    screen.appendChild(video); screen.appendChild(snapshot);
    var caption = element('p', 'learn-manim-caption'); caption.setAttribute('aria-live', 'polite');
    var steps = element('div', 'learn-manim-steps'); steps.setAttribute('aria-label', '教学步骤');
    var progressLabel = element('label', 'learn-manim-progress', '本步进度');
    var progress = element('input'); progress.type = 'range'; progress.min = '0'; progress.max = '0'; progress.step = '1'; progress.value = '0'; progress.disabled = true; progress.setAttribute('aria-label', '本步进度'); progressLabel.appendChild(progress);
    var controls = element('div', 'learn-manim-controls');
    function button(label) { var b = element('button', 'btn', label); b.type = 'button'; controls.appendChild(b); return b; }
    var previous = button('上一步'), play = button('播放本步'), replay = button('重播本步'), next = button('下一步');
    var continuousLabel = element('label', 'learn-manim-continuous');
    var continuous = element('input'); continuous.type = 'checkbox'; continuousLabel.appendChild(continuous); continuousLabel.appendChild(doc.createTextNode('连续演示')); controls.appendChild(continuousLabel);
    var status = element('p', 'learn-manim-status', '正在加载动画…'); status.setAttribute('role', 'status');
    var retry = button('重新加载'); retry.hidden = true;
    shell.appendChild(title); shell.appendChild(summary); shell.appendChild(screen); shell.appendChild(caption); shell.appendChild(steps); shell.appendChild(progressLabel); shell.appendChild(controls); shell.appendChild(status);
    // Keep source and surrounding teaching text available during media failures.
    figure.insertBefore(shell, figure.firstChild);
    var originalStatus = figure.querySelector('figcaption'); if (originalStatus) originalStatus.hidden = true;
    var state = {manifest:null, index:0, playing:false, dead:false, failed:false, tick:null, frameCallback:false, epoch:0, request:null, timeout:null, pendingFrame:null, snapshotResult:null, listeners:[], stepButtons:[]};
    function on(node, event, handler) { node.addEventListener(event, handler); state.listeners.push([node, event, handler]); }
    function update() {
      var ready = !!state.manifest && !state.failed;
      previous.disabled = !ready || state.index === 0; next.disabled = !ready || state.index === state.manifest.steps.length - 1;
      play.disabled = replay.disabled = continuous.disabled = progress.disabled = !ready;
      play.textContent = state.playing ? '暂停' : '播放本步';
      state.stepButtons.forEach(function (b, i) { b.setAttribute('aria-current', i === state.index ? 'step' : 'false'); b.disabled = !ready; });
      if (state.manifest) {
        var step = state.manifest.steps[state.index];
        caption.textContent = '第 ' + (state.index + 1) + ' / ' + state.manifest.steps.length + ' 步 · ' + step.caption;
        progress.min = String(step.start_frame); progress.max = String(step.result_frame);
      }
    }
    function cancelTick() {
      if (state.tick !== null) {
        if (state.frameCallback) video.cancelVideoFrameCallback(state.tick);
        else window.cancelAnimationFrame(state.tick);
        state.tick = null;
      }
    }
    function pause() {
      var wasPlaying = state.playing;
      state.epoch++; state.playing = false; cancelTick(); video.pause();
      if (wasPlaying && state.manifest && !state.failed) status.textContent = '已暂停。可继续播放，或观察当前画面。';
      update();
    }
    function fail(message) {
      if (state.dead) return;
      pause(); state.failed = true; status.textContent = message; retry.hidden = false; update();
    }
    function seek(frame) {
      snapshot.hidden = true; state.snapshotResult = null;
      progress.value = String(frame);
      state.pendingFrame = frame;
      try { video.currentTime = frame / state.manifest.fps; } catch (error) { fail('动画无法定位。请重新加载。'); }
    }
    function select(index) {
      if (!state.manifest || state.failed || index < 0 || index >= state.manifest.steps.length) return;
      pause(); state.index = index; status.textContent = '观察本步说明，准备好后播放。'; update(); seek(state.manifest.steps[index].start_frame);
    }
    function finish() {
      var step = state.manifest.steps[state.index];
      pause(); seek(step.result_frame);
      state.snapshotResult = state.index;
      snapshot.src = mediaURL(mediaBase(ref.asset_id), 'step-' + state.index + '.png');
      showSnapshot();
      status.textContent = '本步完成。观察结果后，再进入下一步。';
    }
    function showSnapshot() {
      if (!state.dead && !state.playing && !state.failed && state.snapshotResult === state.index && snapshot.complete && snapshot.naturalWidth > 0) snapshot.hidden = false;
    }
    function observe(time) {
      if (state.dead || !state.playing) return;
      var step = state.manifest.steps[state.index], frame = Math.floor(time * state.manifest.fps + 0.0001);
      progress.value = String(Math.min(step.result_frame, Math.max(step.start_frame, frame)));
      if (!continuous.checked && frame >= step.hold_start_frame) { finish(); return; }
      if (continuous.checked && frame >= step.end_frame) {
        if (state.index + 1 === state.manifest.steps.length) { finish(); return; }
        state.index++; update();
        // Playback continues through the authored hold without adding another delay.
        observe(time);
      }
    }
    function schedule() {
      if (!state.playing || state.dead || state.tick !== null) return;
      state.frameCallback = typeof video.requestVideoFrameCallback === 'function';
      if (state.frameCallback) state.tick = video.requestVideoFrameCallback(function (now, metadata) { state.tick = null; observe(metadata.mediaTime); schedule(); });
      else state.tick = window.requestAnimationFrame(function () { state.tick = null; observe(video.currentTime); schedule(); });
    }
    function start(restart) {
      if (!state.manifest || state.failed || state.dead) return;
      var step = state.manifest.steps[state.index];
      if (restart || video.currentTime * 30 >= step.hold_start_frame) seek(step.start_frame);
      snapshot.hidden = true;
      var epoch = ++state.epoch;
      state.playing = true; status.textContent = '正在播放本步…'; update(); schedule();
      var playback;
      try { playback = video.play(); } catch (error) { fail('浏览器未能播放动画。请重新加载后重试。'); return; }
      Promise.resolve(playback).then(function () {
        if (state.dead || epoch !== state.epoch) { if (!state.playing) video.pause(); return; }
        schedule();
      }).catch(function () { if (!state.dead && epoch === state.epoch) fail('浏览器未能播放动画。请重新加载后重试。'); });
    }
    function load() {
      pause(); state.failed = false; state.manifest = null; state.index = 0;
      retry.hidden = true; status.textContent = '正在加载动画…'; update();
      if (state.request) state.request.abort();
      if (state.timeout !== null) window.clearTimeout(state.timeout);
      var controller = new AbortController(); state.request = controller;
      state.timeout = window.setTimeout(function () {
        state.timeout = null;
        if (!state.dead && state.request === controller) { controller.abort(); fail('动画加载超时。请重新加载。'); }
      }, 30000);
      window.LearnUser.fetch(mediaBase(ref.asset_id) + 'manifest', {signal:controller.signal}).then(function (response) {
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? '无权查看这段动画。请检查登录账号。' : response.status === 404 ? '动画文件已不可用。请重新生成动画。' : '动画加载失败。请重新加载。');
        return response.json();
      }).then(function (data) {
        if (state.dead || state.request !== controller) return;
        window.clearTimeout(state.timeout); state.timeout = null;
        state.manifest = validate(data, ref.asset_id);
        video.poster = mediaURL(mediaBase(ref.asset_id), 'poster.png');
        video.src = mediaURL(mediaBase(ref.asset_id), 'video.mp4'); video.preload = 'metadata';
        steps.replaceChildren(); state.stepButtons = [];
        state.manifest.steps.forEach(function (step, i) {
          var b = element('button', 'btn', String(i + 1)); b.type = 'button'; b.setAttribute('aria-label', '第 ' + (i + 1) + ' 步：' + step.caption);
          // These buttons live for the player lifetime and are removed on retry.
          b.onclick = function () { select(i); }; steps.appendChild(b); state.stepButtons.push(b);
        });
        status.textContent = '按步骤观察。点击“播放本步”开始。'; progress.value = '0'; update();
      }).catch(function (error) {
        if (state.dead || state.request !== controller || error.name === 'AbortError') return;
        window.clearTimeout(state.timeout); state.timeout = null;
        fail(error.message || '动画加载失败。请重新加载。');
      });
    }
    on(previous, 'click', function () { select(state.index - 1); });
    on(next, 'click', function () { select(state.index + 1); });
    on(play, 'click', function () { if (state.playing) pause(); else start(false); });
    on(replay, 'click', function () { pause(); start(true); });
    on(retry, 'click', load);
    on(progress, 'input', function () { if (state.manifest && !state.failed) { pause(); var step = state.manifest.steps[state.index]; seek(Math.min(step.result_frame, Math.max(step.start_frame, Number(progress.value)))); } });
    on(video, 'loadedmetadata', function () { if (state.manifest && state.pendingFrame !== null) seek(state.pendingFrame); });
    on(video, 'seeked', function () { state.pendingFrame = null; showSnapshot(); });
    on(video, 'error', function () { fail('视频网络或解码失败。文字说明仍可阅读，请重新加载。'); });
    on(video, 'ended', function () { if (state.playing) { if (state.index === state.manifest.steps.length - 1) finish(); else fail('视频提前结束。请重新加载。'); } });
    on(video, 'waiting', function () { if (state.playing) status.textContent = '视频正在缓冲…'; });
    on(video, 'playing', function () { if (state.playing) status.textContent = '正在播放本步…'; });
    on(snapshot, 'load', showSnapshot);
    on(snapshot, 'error', function () { snapshot.hidden = true; });
    state.dispose = function () {
      state.dead = true; pause(); if (state.request) state.request.abort();
      if (state.timeout !== null) window.clearTimeout(state.timeout);
      state.listeners.forEach(function (item) { item[0].removeEventListener(item[1], item[2]); });
      state.stepButtons.forEach(function (b) { b.onclick = null; });
      video.removeAttribute('src'); video.load(); shell.remove();
      if (originalStatus) originalStatus.hidden = false;
      figure.dataset.manim = 'pending'; players.delete(figure);
    };
    update(); load(); return state;
  }
  function figures(root) {
    var found = Array.from(root.querySelectorAll('figure[data-manim]'));
    if (root.matches && root.matches('figure[data-manim]')) found.unshift(root);
    return found;
  }
  function enhance(root) {
    figures(root).forEach(function (figure) {
      if (figure.dataset.manim !== 'pending' || players.has(figure)) return;
      try {
        var ref = reference(figure.querySelector('pre code').textContent);
        var state = build(figure, ref); players.set(figure, state); figure.dataset.manim = 'ready';
      } catch (error) {
        figure.dataset.manim = 'invalid'; figure.querySelector('figcaption').textContent = '动画引用无效。请阅读文字说明，或重新生成动画。';
      }
    });
  }
  function dispose(root) { figures(root).forEach(function (figure) { var state = players.get(figure); if (state) state.dispose(); }); }
  window.LearnManim = {enhance:enhance, dispose:dispose, validate:validate};
}());
