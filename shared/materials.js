/* Shared personal-reference upload control. Only extracted text is persisted. */
(function () {
  'use strict';
  var ACCEPT = '.pdf,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff,.zip,.7z';
  function mount(root, options) {
    var uploading = false, locked = false;
    root.classList.add('materials');
    root.innerHTML = '<label class="materials-label">上传参考资料（可选）<input type="file" multiple accept="' + ACCEPT + '"></label>' +
      '<p class="hint">可补充文档、图片或压缩包，单文件不超过 10 MB。</p>' +
      '<details class="materials-help"><summary>支持格式与上传限制</summary><p class="hint">支持 PDF、TXT、Word、Excel、PowerPoint、图片、ZIP 和 7Z。每份地图最多 100 份、合计 20 万字；PDF 最多 200 页，其中扫描页最多 40 页。图片识别文字。压缩包会跳过办公临时文件和系统附属文件，不接受程序、脚本、宏、加密文件或嵌套压缩包。</p></details>' +
      '<p class="materials-status" role="status" aria-live="polite"></p><ul class="materials-list"></ul>';
    var input = root.querySelector('input'), status = root.querySelector('.materials-status'), list = root.querySelector('ul');
    function render() {
      input.disabled = uploading || locked || window.LearnUser.readOnly;
      list.replaceChildren();
      (options.get() || []).forEach(function (item, index) {
        var row = document.createElement('li'), name = document.createElement('span');
        name.textContent = item.name + ' · ' + item.text.length + ' 字';
        row.appendChild(name);
        var remove = document.createElement('button');
        remove.type = 'button'; remove.className = 'btn'; remove.textContent = '移除';
        remove.setAttribute('aria-label', '移除 ' + item.name);
        remove.disabled = input.disabled;
        remove.onclick = async function () {
          if (uploading || locked || window.LearnUser.readOnly) return;
          var next = options.get().slice(); next.splice(index, 1);
          uploading = true; render(); if (options.busy) options.busy(true);
          try { await options.set(next); status.textContent = '已移除并保存'; }
          catch (error) { status.textContent = '保存失败：' + error.message; }
          finally { uploading = false; render(); if (options.busy) options.busy(false); }
        };
        row.appendChild(remove); list.appendChild(row);
      });
    }
    input.onchange = async function () {
      if (uploading || locked || window.LearnUser.readOnly) return;
      var files = Array.from(input.files || []);
      if (!files.length) return;
      uploading = true; render();
      if (options.busy) options.busy(true);
      var saved = 0, skipped = [];
      try {
        for (var file of files) {
          if (!file.size || file.size > 10 * 1024 * 1024) throw new Error(file.name + '：文件为空或超过 10 MB');
          if (ACCEPT.split(',').indexOf('.' + file.name.split('.').pop().toLowerCase()) < 0) throw new Error('不支持的文件格式：' + file.name);
          status.textContent = '正在解析 ' + file.name + '，扫描件可能需要约 1 分钟…';
          var encoded = await new Promise(function (resolve, reject) {
            var reader = new FileReader(); reader.onload = function () { resolve(reader.result.split(',')[1]); };
            reader.onerror = function () { reject(new Error('无法读取文件')); }; reader.readAsDataURL(file);
          });
          var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 110000);
          var result;
          try {
            var response = await window.LearnUser.fetch(window.LearnUser.apiBase + '/materials/parse', {
              method: 'POST', headers: {'Content-Type': 'application/json'}, signal: controller.signal,
              body: JSON.stringify({name: file.name, data: encoded})
            });
            result = await response.json();
            if (!response.ok) throw new Error(result.error || '上传失败');
          } finally { clearTimeout(timer); }
          var next = (options.get() || []).concat(result.materials);
          if (next.length > 100 || next.reduce(function (n, m) { return n + m.text.length; }, 0) > 200000) {
            throw new Error('资料总量超限，请移除部分资料后重试（最多 100 份、20 万字）');
          }
          await options.set(next);
          saved += result.materials.length;
          skipped = skipped.concat(result.skipped || []);
          render();
        }
        status.textContent = '已保存 ' + saved + ' 份资料，将用于生成地图和测验。' +
          (skipped.length ? '已跳过 ' + skipped.length + ' 个办公临时或系统附属文件：' + skipped.join('、') : '');
      } catch (error) {
        status.textContent = '上传未完成：' + (error.name === 'AbortError' ? '解析超时，请拆分后重试' : error.message) +
          '。本次已保存 ' + saved + ' 份资料；失败的文件或压缩包未保存，原有资料仍保留。';
      } finally {
        uploading = false; input.value = ''; render(); if (options.busy) options.busy(false);
      }
    };
    render();
    return {render: render, lock: function (value) { locked = value; render(); }, busy: function () { return uploading; }};
  }
  // Upload additions are persisted on the source map as a separate quiz draft.
  function quiz(key, generate) {
    if (document.querySelector('.materials-dialog')) return;
    var dialog = document.createElement('dialog'); dialog.className = 'materials-dialog';
    dialog.innerHTML = '<h2>生成综合测验</h2><p>沿用学习路径中的资料，也可以补充本次测验的参考资料。</p><div class="quiz-materials"></div>' +
      '<p class="materials-error" role="alert"></p><div class="materials-actions"><button type="button" class="btn cancel">取消</button><button type="button" class="btn primary generate" disabled>生成测验</button></div>';
    document.body.appendChild(dialog); dialog.showModal();
    var button = dialog.querySelector('.generate'), cancel = dialog.querySelector('.cancel'), panel, additions = [], source;
    function close() { dialog.close(); dialog.remove(); }
    cancel.onclick = close;
    dialog.addEventListener('cancel', function (event) { if (panel && panel.busy()) event.preventDefault(); else close(); });
    window.LearnUser.fetch(window.LearnUser.apiBase + '/state/all', {cache: 'no-store'}).then(function (r) {
      if (!r.ok) throw new Error('无法读取资料'); return r.json();
    }).then(function (data) {
      source = JSON.parse(data.entries[key]); additions = source.quizMaterials || [];
      panel = mount(dialog.querySelector('.quiz-materials'), {
        get: function () { return additions; },
        set: async function (next) {
          var combined = (source.materials || []).concat(next);
          if (combined.length > 100 || combined.reduce(function (n, m) { return n + m.text.length; }, 0) > 200000) throw new Error('连同原学习资料已超过 100 份或 20 万字');
          var r = await window.LearnUser.fetch(window.LearnUser.apiBase + '/materials/quiz-draft', {
            method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({key: key, materials: next})
          });
          var result = await r.json(); if (!r.ok) throw new Error(result.error || '保存失败'); additions = next;
        },
        busy: function (value) { button.disabled = value || window.LearnUser.readOnly; cancel.disabled = value; }
      });
      button.disabled = window.LearnUser.readOnly;
      button.onclick = function () { if (button.disabled || window.LearnUser.readOnly || panel.busy()) return; close(); generate(); };
    }).catch(function (error) { dialog.querySelector('.materials-error').textContent = error.message; });
  }
  window.LearnMaterials = {mount: mount, quiz: quiz};
})();
