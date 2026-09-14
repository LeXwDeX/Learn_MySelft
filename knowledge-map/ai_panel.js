(function(){
  var HOST = 'http://' + location.hostname + ':8101';
  var ASK = HOST + '/ask', SUGGEST = HOST + '/suggest', COMPRESS = HOST + '/compress';
  var MAX_IMG_BYTES = 10 * 1024 * 1024;   // 上传上限 10MB
  var MAX_SIDE = 3840;                    // 最长边压到 4K 以内
  var JPEG_Q = 0.9;                       // 保底 JPG 90%
  var CTX_LIMIT = 500000;                 // 每个对话的上下文上限（token），超了就压缩
  var KEEP_RECENT = 8;                    // 压缩时保留最近 N 条不压
  var SYS_OVERHEAD = 900;                 // 后端 system prompt 的固定开销估算

  var drawer = document.getElementById('ai-drawer');
  var msgsEl = document.getElementById('ai-msgs');
  var textEl = document.getElementById('ai-text');
  var sendBtn = document.getElementById('ai-send');
  var attachBtn = document.getElementById('ai-attach');
  var fileEl = document.getElementById('ai-file');
  var thumbEl = document.getElementById('ai-thumb');
  var chipsEl = document.getElementById('ai-chips');
  var chipsLabel = document.getElementById('ai-chips-label');
  var meterTxt = document.getElementById('ai-meter-txt');
  var meterFill = document.getElementById('ai-meter-fill');
  var meterEl = document.getElementById('ai-meter');
  var cur = null;          // 当前话题（单元）
  var history = [];        // 当前话题的完整对话
  var pending = null;      // 待发送的图片 {dataUrl, thumb, bytes, w, h, origBytes, name}
  var busy = false;

  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmt(s){
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }
  function fmtSize(b){ return b >= 1048576 ? (b/1048576).toFixed(2)+' MB' : Math.round(b/1024)+' KB'; }
  function fmtK(n){ return n >= 1000 ? (n/1000).toFixed(1) + 'K' : String(n); }
  function hkey(id){ return 'math-map-ai-' + id; }
  function loadHist(id){ try { return JSON.parse(localStorage.getItem(hkey(id)) || '[]'); } catch(e){ return []; } }

  // 存历史：图片只留小缩略图，否则 localStorage 很快爆
  function saveHist(id, h){
    try {
      var slim = h.map(function(m){
        var o = { role: m.role, content: (m.content || '').slice(0, 4000) };
        if (m.role === 'summary') o.content = m.content || '';
        if (m.image) o.image = m.thumb || m.image;
        return o;
      });
      localStorage.setItem(hkey(id), JSON.stringify(slim));
    } catch(e){
      console.warn('history save failed', e);
    }
  }

  // ---------- 上下文预算：≈ token（中文约 0.75/字，西文约 4 字符/token）----------
  function estTokens(s){
    if (!s) return 0;
    var cjk = (s.match(/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
    return Math.round(cjk * 0.75 + (s.length - cjk) / 4);
  }
  function ctxTokens(){
    var n = SYS_OVERHEAD + estTokens(cur ? JSON.stringify(cur) : '');
    history.forEach(function(m){ n += estTokens(m.content || '') + 6; });
    return n;
  }
  function updateMeter(extra){
    if (!meterEl) return;
    var n = ctxTokens(), pct = Math.min(100, Math.round(n / CTX_LIMIT * 100));
    meterTxt.textContent = '上下文 ≈' + fmtK(n) + ' / ' + fmtK(CTX_LIMIT) + '（' + pct + '%）' + (extra || '');
    meterFill.style.width = Math.max(0.5, pct) + '%';
    meterEl.classList.toggle('warn', pct >= 60);
    meterEl.classList.toggle('full', pct >= 90);
  }

  // ---------- 话题状态 ----------
  function setTopicOff(){
    cur = null; history = []; pending = null;
    drawer.classList.add('no-topic');
    document.getElementById('ai-unit-id').textContent = '未选择话题';
    document.getElementById('ai-unit-title').textContent = 'AI 辅助';
    document.getElementById('ai-unit-domain').textContent = '在左侧 Knowledge Map 里点任意单元卡片右侧的「AI 辅助」，它就拿到那个单元的全部上下文。';
    textEl.value = ''; textEl.disabled = true;
    textEl.placeholder = '请在单元内选择话题…';
    sendBtn.disabled = true; attachBtn.disabled = true;
    renderThumb(); chipsEl.innerHTML = '';
    msgsEl.innerHTML = '<div class="ai-empty"><p><strong>还没有话题，所以不能提问。</strong></p>' +
      '<p>去左边 Knowledge Map 里点任意单元卡片右侧的「AI 辅助」——比如 <code>L3 四种命题与逆否等价</code>，' +
      '面板就会拿到那个单元的本质、必会点、陷阱和自测题，然后这里就能问它了。</p></div>';
  }

  function collectUnit(node){
    var panel = node.closest('.tabpanel');
    var label = panel ? (panel.getAttribute('data-label') || '') : '';
    var parts = label.split(' ');
    var qs = [];
    [].forEach.call(node.querySelectorAll('.quiz'), function(q){
      var qq = q.querySelector('.qq'), ans = q.querySelector('.answerline'), why = q.querySelector('.whyline');
      if (!qq || !ans) return;
      qs.push({ q: qq.textContent.trim(), a: ans.textContent.replace(/^答案：/, '').trim(), why: why ? why.textContent.trim() : '' });
    });
    return {
      unit_id: node.getAttribute('data-id'),
      unit_title: (node.querySelector('.node-title h3') || {}).textContent || '',
      domain: parts.slice(1).join(' ') || label,
      essence: (node.querySelector('.essence') || {}).textContent || '',
      musts: [].map.call(node.querySelectorAll('.musts li'), function(li){ return li.textContent.trim(); }),
      traps: [].map.call(node.querySelectorAll('.traps li'), function(li){ return li.textContent.trim(); }),
      quizzes: qs
    };
  }

  function openTopic(node){
    cur = collectUnit(node);
    drawer.classList.remove('no-topic');
    document.getElementById('ai-unit-id').textContent = cur.unit_id + ' · ' + cur.domain;
    document.getElementById('ai-unit-title').textContent = cur.unit_title;
    document.getElementById('ai-unit-domain').textContent = cur.essence;
    document.getElementById('ai-ctx-body').innerHTML =
      '<p><strong>必会</strong><br>' + cur.musts.map(esc).join('<br>') + '</p>' +
      '<p><strong>陷阱</strong><br>' + (cur.traps.length ? cur.traps.map(esc).join('<br>') : '—') + '</p>' +
      '<p><strong>自测题</strong><br>' + (cur.quizzes.length ? cur.quizzes.map(function(z){return esc(z.q);}).join('<br>') : '—') + '</p>';
    document.getElementById('ai-ctx-summary').textContent = '已附带该单元上下文（' + cur.unit_id + '）';
    history = loadHist(cur.unit_id);
    pending = null; renderThumb();
    textEl.disabled = false; sendBtn.disabled = false; attachBtn.disabled = false;
    textEl.placeholder = '就「' + cur.unit_title + '」直接提问…（Enter 发送 / Shift+Enter 换行）';
    renderHist();
    updateMeter();
    refreshSuggestions();
    textEl.focus();
  }

  function renderHist(){
    msgsEl.innerHTML = '';
    if (!history.length){
      msgsEl.innerHTML = '<div class="ai-empty"><p><strong>这个话题你还没问过。</strong></p>' +
        '<p>它已经拿到本单元的本质、必会点、陷阱和自测题（含答案），直接问就行；下面的建议问题也是按这个话题现生成的。</p></div>';
      return;
    }
    history.forEach(function(m){
      if (m.role === 'summary'){ summaryBlock(m.content); return; }
      bubble(m.role, m.content, m.image);
    });
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function summaryBlock(text){
    var d = document.createElement('details');
    d.className = 'ai-summary';
    d.innerHTML = '<summary>已压缩的更早对话（前情摘要 · ' + (text || '').length + ' 字）</summary><div>' + fmt(text || '') + '</div>';
    msgsEl.appendChild(d);
  }

  function bubble(role, text, image){
    var d = document.createElement('div');
    d.className = 'ai-msg ' + role;
    d.innerHTML = '<p class="ai-who">' + (role === 'user' ? '我' : 'AI 老师') + '</p><div class="ai-bubble">' + fmt(text || '') +
                  (image ? '<img src="' + image + '" alt="附图">' : '') + '</div>';
    msgsEl.appendChild(d);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return d.querySelector('.ai-bubble');
  }

  // ---------- 建议问题：由 AI 按话题生成，随对话变化 ----------
  function renderChips(qs){
    chipsEl.innerHTML = '';
    (qs || []).forEach(function(q){
      var b = document.createElement('button');
      b.className = 'chip'; b.type = 'button'; b.textContent = q;
      b.addEventListener('click', function(){ if (!busy) ask(q); });
      chipsEl.appendChild(b);
    });
    chipsLabel.hidden = !(qs && qs.length);
  }
  function refreshSuggestions(){
    if (!cur) return;
    var unitId = cur.unit_id, hist = history.slice(-6);
    fetch(SUGGEST, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unit: cur, history: hist })
    }).then(function(r){ return r.json(); })
      .then(function(d){ if (cur && cur.unit_id === unitId) renderChips(d.questions || []); })
      .catch(function(){ if (cur && cur.unit_id === unitId) renderChips([]); });
  }

  // ---------- 超过 500K：把更早的对话压成摘要 ----------
  async function ensureBudget(){
    if (!cur) return;
    if (ctxTokens() <= CTX_LIMIT) return;
    if (history.length <= KEEP_RECENT + 1) return;
    var older = history.slice(0, history.length - KEEP_RECENT)
                       .filter(function(m){ return m.role === 'user' || m.role === 'assistant'; });
    if (!older.length) return;

    busy = true; sendBtn.disabled = true; attachBtn.disabled = true;
    updateMeter(' · 正在压缩更早的对话…');
    var note = document.createElement('div');
    note.className = 'ai-compressing';
    note.textContent = '上下文超过 ' + fmtK(CTX_LIMIT) + '，正在把更早的 ' + older.length + ' 条对话压成摘要（可能 1-2 分钟）…';
    msgsEl.appendChild(note); msgsEl.scrollTop = msgsEl.scrollHeight;

    try {
      var r = await fetch(COMPRESS, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unit: cur, messages: older })
      });
      var d = await r.json();
      if (d && d.summary){
        history = [{ role: 'summary', content: d.summary }].concat(history.slice(-KEEP_RECENT));
        saveHist(cur.unit_id, history);
        renderHist();
        updateMeter(' · 已压缩 ' + older.length + ' 条');
      } else {
        updateMeter(' · 压缩未成功');
      }
    } catch(e){
      updateMeter(' · 压缩失败：' + e.message);
    }
    note.remove();
    busy = false;
    if (cur){ sendBtn.disabled = false; attachBtn.disabled = false; }
  }

  // ---------- 图片：先压缩再上传 ----------
  function renderThumb(){
    thumbEl.innerHTML = '';
    if (!pending) return;
    var d = document.createElement('div');
    d.className = 'thumb-wrap';
    d.innerHTML = '<img src="' + pending.dataUrl + '" alt="待发送图片"><span class="thumb-meta">' +
      fmtSize(pending.origBytes) + ' → ' + fmtSize(pending.bytes) + '<br>' + pending.w + '×' + pending.h + ' · JPG 90%</span>';
    var x = document.createElement('button');
    x.className = 'thumb-x'; x.type = 'button'; x.textContent = '✕';
    x.addEventListener('click', function(){ pending = null; renderThumb(); });
    d.appendChild(x);
    thumbEl.appendChild(d);
  }

  function drawScaled(img, maxSide, q){
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    var scale = Math.min(1, maxSide / Math.max(w, h));
    var tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
    var c = document.createElement('canvas'); c.width = tw; c.height = th;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, tw, th);   // 透明底转白，避免 PNG 变黑
    ctx.drawImage(img, 0, 0, tw, th);
    return { url: c.toDataURL('image/jpeg', q), w: tw, h: th };
  }

  function compressImage(file){
    return new Promise(function(resolve, reject){
      if (!/^image\//.test(file.type || '')) { reject(new Error('只能传图片文件')); return; }
      if (file.size > MAX_IMG_BYTES) { reject(new Error('图片 ' + fmtSize(file.size) + ' 超过 10MB 上限')); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function(){
        var big = drawScaled(img, MAX_SIDE, JPEG_Q);      // 发给模型：JPG 90% / ≤4K
        var small = drawScaled(img, 240, 0.62);           // 存历史：小缩略图
        URL.revokeObjectURL(url);
        resolve({
          dataUrl: big.url, thumb: small.url, w: big.w, h: big.h, name: file.name || 'paste.jpg',
          origBytes: file.size,
          bytes: Math.round((big.url.length - big.url.indexOf(',') - 1) * 3 / 4)
        });
      };
      img.onerror = function(){ URL.revokeObjectURL(url); reject(new Error('无法读取这张图片')); };
      img.src = url;
    });
  }

  function attachFile(file){
    if (!cur) return;
    compressImage(file).then(function(info){
      pending = info; renderThumb();
    }).catch(function(e){
      alert('图片处理失败：' + e.message);
    });
  }

  // ---------- 提问 ----------
  async function ask(question){
    if (busy || !cur) return;
    var q = (question || '').trim();
    if (!q && !pending) return;
    if (!q && pending) q = '请看这张图片，它和本单元有什么关系？';

    await ensureBudget();          // 先看上下文是否超 500K，超了先压缩
    if (!cur) return;

    var img = pending ? pending.dataUrl : null;
    var thumb = pending ? pending.thumb : null;

    busy = true; sendBtn.disabled = true; attachBtn.disabled = true;
    [].forEach.call(chipsEl.querySelectorAll('.chip'), function(c){ c.disabled = true; });
    if (!history.length) msgsEl.innerHTML = '';

    history.push({ role: 'user', content: q, image: img, thumb: thumb });
    saveHist(cur.unit_id, history);
    bubble('user', q, img);
    textEl.value = ''; pending = null; renderThumb();
    updateMeter();

    var target = bubble('assistant', '');
    target.innerHTML = '<span class="ai-typing">思考中…</span>';
    var acc = '';
    try {
      var res = await fetch(ASK, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unit: cur, question: q, image: img, history: history.slice(0, -1) })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
      while (true){
        var r = await reader.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        var lines = buf.split('\n'); buf = lines.pop();
        for (var i = 0; i < lines.length; i++){
          var line = lines[i].trim();
          if (line.indexOf('data:') !== 0) continue;
          var payload = line.slice(5).trim();
          if (!payload) continue;
          var obj; try { obj = JSON.parse(payload); } catch(e){ continue; }
          if (obj.error) acc += '\n[出错] ' + obj.error;
          if (obj.delta){ acc += obj.delta; target.innerHTML = fmt(acc); msgsEl.scrollTop = msgsEl.scrollHeight; }
        }
      }
      if (!acc) acc = '（没有返回内容，可能是上游超时，再试一次。）';
    } catch (e){
      acc = acc || ('请求失败：' + e.message + '\n（可检查服务：' + HOST + '/health）');
    }
    target.innerHTML = fmt(acc);
    history.push({ role: 'assistant', content: acc });
    saveHist(cur.unit_id, history);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    busy = false;
    if (cur){ sendBtn.disabled = false; attachBtn.disabled = false; }
    updateMeter();
    refreshSuggestions();     // 建议问题随对话变化
  }

  // ---------- 绑定 ----------
  [].forEach.call(document.querySelectorAll('.node'), function(node){
    var b = node.querySelector('.ai-open');
    if (b) b.addEventListener('click', function(){ openTopic(node); });
  });
  document.getElementById('ai-close').addEventListener('click', setTopicOff);

  attachBtn.addEventListener('click', function(){ fileEl.click(); });
  fileEl.addEventListener('change', function(){
    if (fileEl.files && fileEl.files[0]) attachFile(fileEl.files[0]);
    fileEl.value = '';
  });
  textEl.addEventListener('paste', function(e){
    var items = (e.clipboardData || {}).items || [];
    for (var i = 0; i < items.length; i++){
      if (items[i].type && items[i].type.indexOf('image') === 0){
        e.preventDefault();
        var f = items[i].getAsFile();
        if (f) attachFile(f);
        return;
      }
    }
  });
  drawer.addEventListener('dragover', function(e){ e.preventDefault(); });
  drawer.addEventListener('drop', function(e){
    var files = (e.dataTransfer || {}).files || [];
    for (var i = 0; i < files.length; i++){
      if (/^image\//.test(files[i].type)){ e.preventDefault(); attachFile(files[i]); return; }
    }
  });

  document.getElementById('ai-form').addEventListener('submit', function(e){
    e.preventDefault(); ask(textEl.value);
  });
  textEl.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); ask(textEl.value); }
  });

  setTopicOff();
})();
