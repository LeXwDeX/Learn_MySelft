/* Authenticated ManimGL media. Each step owns a bounded frame interval. */
(function () {
  'use strict';
  var players = new WeakMap();
  var playbackRate = 0.9;
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
    var media = element('div', 'learn-manim-media');
    var video = element('video');
    video.preload = 'none'; video.playsInline = true; video.muted = true; video.playbackRate = playbackRate; video.crossOrigin = 'use-credentials';
    video.setAttribute('aria-label', ref.title + '，ManimGL 教学动画');
    var snapshot = element('img', 'learn-manim-snapshot');
    snapshot.crossOrigin = 'use-credentials'; snapshot.alt = '本步结果'; snapshot.hidden = true;
    media.appendChild(video); media.appendChild(snapshot); screen.appendChild(media);
    var caption = element('p', 'learn-manim-caption'); caption.setAttribute('aria-live', 'polite');
    var steps = element('div', 'learn-manim-steps'); steps.setAttribute('aria-label', '教学步骤');
    var progressLabel = element('label', 'learn-manim-progress', '本步进度');
    var progress = element('input'); progress.type = 'range'; progress.min = '0'; progress.max = '0'; progress.step = '1'; progress.value = '0'; progress.disabled = true; progress.setAttribute('aria-label', '本步进度'); progressLabel.appendChild(progress);
    var controls = element('div', 'learn-manim-controls');
    function button(label) { var b = element('button', 'btn', label); b.type = 'button'; controls.appendChild(b); return b; }
    var previous = button('上一步'), play = button('播放'), replay = button('重播本步'), next = button('下一步');
    var automatic = button('自动播放'); automatic.className = 'btn learn-manim-automatic';
    var status = element('p', 'learn-manim-status', '正在加载动画…'); status.setAttribute('role', 'status');
    var retry = button('重新加载'); retry.hidden = true;
    shell.appendChild(title); shell.appendChild(summary); shell.appendChild(screen); shell.appendChild(caption); shell.appendChild(steps); shell.appendChild(progressLabel); shell.appendChild(controls); shell.appendChild(status);
    // Keep source and surrounding teaching text available during media failures.
    figure.insertBefore(shell, figure.firstChild);
    var originalStatus = figure.querySelector('figcaption'); if (originalStatus) originalStatus.hidden = true;
    var state = {manifest:null, index:0, awaitingIndex:null, playing:false, automatic:true, runAutomatic:false, phase:'idle', dead:false, failed:false, tick:null, frameCallback:false, epoch:0, request:null, timeout:null, phaseTimer:null, seekTimer:null, pendingFrame:null, afterSeek:null, snapshotResult:null, snapshotFileIndex:null, listeners:[], stepButtons:[]};
    function on(node, event, handler) { node.addEventListener(event, handler); state.listeners.push([node, event, handler]); }
    function update() {
      var ready = !!state.manifest && !state.failed;
      previous.disabled = !ready || state.index === 0; next.disabled = !ready || state.index === state.manifest.steps.length - 1;
      play.disabled = replay.disabled = automatic.disabled = progress.disabled = !ready;
      play.textContent = state.playing ? '暂停' : state.automatic ? '播放' : '播放本步';
      automatic.setAttribute('aria-pressed', String(state.automatic));
      shell.dataset.phase = state.phase;
      state.stepButtons.forEach(function (b, i) { b.setAttribute('aria-current', i === state.index ? 'step' : 'false'); b.disabled = !ready; });
      if (state.manifest) {
        var step = state.manifest.steps[state.index];
        caption.textContent = '第 ' + (state.index + 1) + ' / ' + state.manifest.steps.length + ' 步 · ' + step.caption;
        progress.min = String(step.start_frame); progress.max = String(step.result_frame);
        if (state.snapshotFileIndex !== state.index) {
          snapshot.hidden = true; state.snapshotFileIndex = state.index;
          snapshot.src = mediaURL(mediaBase(ref.asset_id), 'step-' + state.index + '.png');
        }
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
      var restoreResult = state.awaitingIndex !== null;
      state.epoch++; state.playing = false; cancelTick(); video.pause();
      if (state.phaseTimer !== null) window.clearTimeout(state.phaseTimer);
      if (state.seekTimer !== null) window.clearTimeout(state.seekTimer);
      state.phaseTimer = state.seekTimer = null; state.afterSeek = null; state.phase = 'idle';
      state.awaitingIndex = null; media.style.transition = 'none'; media.style.opacity = '1';
      if (restoreResult && !state.dead && state.manifest) {
        // Keep the displayed step and its already requested Manim result when a
        // transition seek is cancelled. No delayed seek may switch that step.
        seek(state.manifest.steps[state.index].result_frame);
        state.snapshotResult = state.index; showSnapshot();
      }
      if (wasPlaying && state.manifest && !state.failed) status.textContent = '已暂停。可继续播放，或观察当前画面。';
      update();
    }
    function fail(message) {
      if (state.dead) return;
      pause(); state.failed = true; status.textContent = message; retry.hidden = false; update();
    }
    function seek(frame, done) {
      snapshot.hidden = true; state.snapshotResult = null;
      progress.value = String(frame);
      if (state.seekTimer !== null) window.clearTimeout(state.seekTimer);
      state.seekTimer = null; state.pendingFrame = frame; state.afterSeek = done || null;
      var target = frame / state.manifest.fps;
      try {
        // An already decoded target needs no seek event (notably the initial frame).
        if (!video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.00001) { completeSeek(); return; }
        video.currentTime = target;
        if (done) {
          var epoch = state.epoch;
          var seekTimer = window.setTimeout(function () {
            if (state.dead || epoch !== state.epoch || state.pendingFrame !== frame || state.seekTimer !== seekTimer) return;
            state.seekTimer = null; fail('动画无法定位。请重新加载。');
          }, 10000);
          state.seekTimer = seekTimer;
        }
      } catch (error) { fail('动画无法定位。请重新加载。'); }
    }
    function completeSeek() {
      if (state.dead || !state.manifest || state.pendingFrame === null || video.seeking || Math.abs(video.currentTime * state.manifest.fps - state.pendingFrame) > 0.5) return;
      if (state.seekTimer !== null) window.clearTimeout(state.seekTimer);
      state.seekTimer = null; state.pendingFrame = null;
      var done = state.afterSeek; state.afterSeek = null;
      if (!state.playing) media.style.opacity = '1';
      showSnapshot(); if (done) done();
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
      if (!state.dead && (!state.playing || state.phase === 'hold' || state.phase === 'fadeout' || state.phase === 'gap') && !state.failed && state.snapshotResult === state.index && snapshot.complete && snapshot.naturalWidth > 0) snapshot.hidden = false;
    }
    function delay(ms, epoch, done) {
      var timer = window.setTimeout(function () {
        if (state.dead || !state.playing || epoch !== state.epoch || state.phaseTimer !== timer) return;
        state.phaseTimer = null; done();
      }, ms);
      state.phaseTimer = timer;
    }
    function resumeMedia(epoch) {
      if (state.dead || !state.playing || epoch !== state.epoch) return;
      video.playbackRate = playbackRate;
      state.phase = 'playback'; status.textContent = state.runAutomatic ? '正在自动播放…' : '正在播放本步…'; update();
      var result;
      try { result = video.play(); } catch (error) { fail('浏览器未能播放动画。请重新加载后重试。'); return; }
      Promise.resolve(result).then(function () {
        if (state.dead || epoch !== state.epoch) { if (!state.playing) video.pause(); return; }
        schedule();
      }).catch(function () { if (!state.dead && epoch === state.epoch) fail('浏览器未能播放动画。请重新加载后重试。'); });
    }
    function advance(frame) {
      var step = state.manifest.steps[state.index], epoch = state.epoch;
      cancelTick(); video.pause(); state.phase = 'hold'; update();
      seek(step.result_frame);
      state.snapshotResult = state.index; snapshot.src = mediaURL(mediaBase(ref.asset_id), 'step-' + state.index + '.png'); showSnapshot();
      status.textContent = '观察本步结果…';
      // Freeze the authored result before the next frame can appear. Preserve the
      // remainder of its authored hold instead of playing across a step boundary.
      var hold = Math.max(1, step.end_frame - Math.max(step.hold_start_frame, Math.min(step.result_frame, frame))) / state.manifest.fps / playbackRate * 1000;
      delay(hold, epoch, function () {
        if (state.index === state.manifest.steps.length - 1) { finish(); status.textContent = '全部步骤完成。可重播本步，或选择其他步骤。'; return; }
        var fade = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 150;
        state.phase = 'fadeout'; media.style.transition = fade ? 'opacity 150ms ease-out' : 'none'; media.style.opacity = fade ? '0' : '1'; update();
        delay(fade, epoch, function () {
          state.phase = 'gap'; update();
          delay(250, epoch, function () {
            var nextIndex = state.index + 1;
            state.awaitingIndex = nextIndex; state.phase = 'seeking'; update();
            seek(state.manifest.steps[nextIndex].start_frame, function () {
              if (state.dead || !state.playing || epoch !== state.epoch) return;
              state.index = nextIndex; state.awaitingIndex = null;
              state.phase = 'fadein'; media.style.opacity = '1'; update();
              delay(fade, epoch, function () { resumeMedia(epoch); });
            });
          });
        });
      });
    }
    function observe(time) {
      if (state.dead || !state.playing || state.phase !== 'playback' || state.pendingFrame !== null || video.seeking) return;
      var step = state.manifest.steps[state.index], frame = Math.floor(time * state.manifest.fps + 0.0001);
      progress.value = String(Math.min(step.result_frame, Math.max(step.start_frame, frame)));
      if (frame >= step.hold_start_frame) { if (state.runAutomatic) advance(frame); else finish(); }
    }
    function schedule() {
      if (!state.playing || state.dead || state.phase !== 'playback' || state.tick !== null) return;
      var epoch = state.epoch;
      state.frameCallback = typeof video.requestVideoFrameCallback === 'function';
      if (state.frameCallback) state.tick = video.requestVideoFrameCallback(function (now, metadata) { if (epoch !== state.epoch || state.dead) return; state.tick = null; observe(metadata.mediaTime); schedule(); });
      else state.tick = window.requestAnimationFrame(function () { if (epoch !== state.epoch || state.dead) return; state.tick = null; observe(video.currentTime); schedule(); });
    }
    function start(restart) {
      if (!state.manifest || state.failed || state.dead) return;
      var step = state.manifest.steps[state.index];
      video.playbackRate = playbackRate;
      var needsSeek = restart || video.currentTime * state.manifest.fps >= step.hold_start_frame;
      snapshot.hidden = true;
      var epoch = ++state.epoch;
      state.playing = true; state.runAutomatic = state.automatic && !restart;
      state.phase = 'seeking'; status.textContent = '正在准备播放…'; update();
      // The first play remains inside the click handler. Muted ManimGL video can
      // then resume after asynchronous seeks on browsers including WebKit.
      var initialPlay;
      try { initialPlay = video.play(); } catch (error) { fail('浏览器未能播放动画。请重新加载后重试。'); return; }
      var waiting = needsSeek || state.pendingFrame !== null;
      if (waiting) video.pause();
      var primed = false, positioned = !waiting;
      function ready() { if (primed && positioned) resume(); }
      function resume() {
        if (state.dead || !state.playing || epoch !== state.epoch) return;
        if (waiting) { resumeMedia(epoch); return; }
        state.phase = 'playback'; status.textContent = state.runAutomatic ? '正在自动播放…' : '正在播放本步…'; update(); schedule();
      }
      if (waiting) seek(needsSeek ? step.start_frame : state.pendingFrame, function () { positioned = true; ready(); });
      Promise.resolve(initialPlay).then(function () {
        if (state.dead || epoch !== state.epoch) { if (!state.playing) video.pause(); return; }
        primed = true; ready();
      }).catch(function (error) {
        if (state.dead || epoch !== state.epoch) return;
        // Pausing a pending play while waiting for a seek rejects that priming
        // promise with AbortError. The actual resume still checks play failures.
        if (waiting && error && error.name === 'AbortError') { primed = true; ready(); }
        else fail('浏览器未能播放动画。请重新加载后重试。');
      });
    }
    function load() {
      pause(); state.failed = false; state.manifest = null; state.index = 0;
      state.pendingFrame = state.snapshotResult = state.snapshotFileIndex = null; snapshot.hidden = true;
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
        video.src = mediaURL(mediaBase(ref.asset_id), 'video.mp4'); video.preload = 'metadata'; video.playbackRate = playbackRate;
        steps.replaceChildren(); state.stepButtons = [];
        state.manifest.steps.forEach(function (step, i) {
          var b = element('button', 'btn', String(i + 1)); b.type = 'button'; b.setAttribute('aria-label', '第 ' + (i + 1) + ' 步：' + step.caption);
          // These buttons live for the player lifetime and are removed on retry.
          b.onclick = function () { select(i); }; steps.appendChild(b); state.stepButtons.push(b);
        });
        status.textContent = state.automatic ? '点击“播放”后，按顺序自动演示。可关闭“自动播放”，逐步观察。' : '按步骤观察。点击“播放本步”开始。'; progress.value = '0'; update();
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
    on(automatic, 'click', function () { pause(); state.automatic = !state.automatic; status.textContent = state.automatic ? '自动播放已开启。点击“播放”开始。' : '自动播放已关闭。点击“播放本步”，逐步观察。'; update(); });
    on(retry, 'click', load);
    on(progress, 'input', function () { if (state.manifest && !state.failed) { pause(); var step = state.manifest.steps[state.index]; seek(Math.min(step.result_frame, Math.max(step.start_frame, Number(progress.value)))); } });
    on(video, 'loadedmetadata', function () { if (state.manifest && state.pendingFrame !== null) seek(state.pendingFrame, state.afterSeek); });
    on(video, 'seeked', completeSeek);
    on(video, 'error', function () { fail('视频网络或解码失败。文字说明仍可阅读，请重新加载。'); });
    on(video, 'ended', function () { if (state.playing && state.phase === 'playback') { if (state.index === state.manifest.steps.length - 1) finish(); else fail('视频提前结束。请重新加载。'); } });
    on(video, 'waiting', function () { if (state.playing) status.textContent = '视频正在缓冲…'; });
    on(video, 'playing', function () { if (state.playing && state.phase === 'playback') status.textContent = state.runAutomatic ? '正在自动播放…' : '正在播放本步…'; });
    on(snapshot, 'load', showSnapshot);
    on(snapshot, 'error', function () { snapshot.hidden = true; });
    on(doc, 'visibilitychange', function () { if (doc.hidden) pause(); });
    on(window, 'pagehide', function () { state.dispose(); });
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
