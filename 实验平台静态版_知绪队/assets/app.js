/* 静态版：无需自建服务器即可运行。
   说明：浏览器直连大模型 API 通常会被 CORS 拦截，且会暴露密钥。
   正式施测请在 config.js 中填写 proxyUrl（部署 tools/proxy-worker.js 即可）。 */
(function () {
  var C = window.APP_CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var state = { pid: '', sid: '', condition: '', stratum: '', t1: null, t2: null, turns: 0, msgs: [], crisis: 0, userChars: 0, aiChars: 0, startedAt: '' };

  var show = function (id) {
    ['step-consent', 'step-t1', 'step-chat', 'step-t2', 'step-done'].forEach(function (s) {
      $(s).classList.toggle('hidden', s !== id);
    });
    window.scrollTo(0, 0);
  };

  var mean = function (a) { var v = (a || []).filter(function (x) { return typeof x === 'number' && !isNaN(x); }); return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null; };
  var sum = function (a) { var v = (a || []).filter(function (x) { return typeof x === 'number' && !isNaN(x); }); return v.length ? v.reduce(function (a, b) { return a + b; }, 0) : null; };
  var round = function (x) { return x === null ? null : Math.round(x * 10000) / 10000; };

  function renderForm(container, blocks, prefix) {
    container.innerHTML = '';
    blocks.forEach(function (b, bi) {
      var box = document.createElement('div');
      box.className = 'qblock';
      var title = document.createElement('div');
      title.className = 'qtitle';
      title.textContent = (bi + 1) + '. ' + b.title;
      box.appendChild(title);

      if (b.type === 'single') {
        b.options.forEach(function (opt) {
          var l = document.createElement('label');
          l.className = 'opt';
          l.innerHTML = '<input type="radio" name="' + prefix + b.id + '" value="' + opt + '"> ' + opt;
          box.appendChild(l);
        });
      } else if (b.type === 'number') {
        var l2 = document.createElement('label');
        l2.className = 'opt';
        l2.innerHTML = '<input type="number" name="' + prefix + b.id + '" min="' + (b.min || 0) + '" max="' + (b.max || 100) + '" style="width:100px">';
        box.appendChild(l2);
      } else if (b.type === 'scale') {
        var labels = (C.scales.anchors && C.scales.anchors[b.anchor]) || [];
        var head = document.createElement('div');
        head.className = 'scalehead';
        head.innerHTML = '<span></span>' + labels.map(function (t, i) { return '<span>' + t + '</span>'; }).join('');
        box.appendChild(head);
        b.items.forEach(function (item, ii) {
          var row = document.createElement('div');
          row.className = 'scalerow';
          row.innerHTML = '<span class="itemtext">' + item + '</span>' +
            labels.map(function (t, i) { return '<label class="tick"><input type="radio" name="' + prefix + b.id + '_' + ii + '" value="' + (i + 1) + '"></label>'; }).join('');
          box.appendChild(row);
        });
      }
      container.appendChild(box);
    });
  }

  function collect(blocks, prefix) {
    var out = {}, missing = null;
    blocks.forEach(function (b) {
      if (b.type === 'scale') {
        var vals = [];
        b.items.forEach(function (_, ii) {
          var el = document.querySelector('input[name="' + prefix + b.id + '_' + ii + '"]:checked');
          if (!el && !missing) missing = prefix + b.id + '_' + ii;
          vals.push(el ? Number(el.value) : null);
        });
        out[b.id] = vals;
      } else if (b.type === 'single') {
        var c = document.querySelector('input[name="' + prefix + b.id + '"]:checked');
        if (!c && !missing) missing = prefix + b.id;
        out[b.id] = c ? c.value : '';
      } else {
        var n = document.querySelector('[name="' + prefix + b.id + '"]');
        if ((!n || n.value === '') && !missing) missing = prefix + b.id;
        out[b.id] = n && n.value !== '' ? Number(n.value) : null;
      }
    });
    return { data: out, missing: missing };
  }

  function bubble(role, text) {
    var d = document.createElement('div');
    d.className = 'bubble ' + role;
    d.textContent = text;
    $('chatLog').appendChild(d);
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
  }

  /* 随机分组：静态版无全局计数，采用简单随机；同伴支持分层仅作记录 */
  function assign(peer) {
    if (peer === null) state.stratum = 'U';
    else if (peer <= C.peerLow) state.stratum = 'L';
    else if (peer <= C.peerHigh) state.stratum = 'M';
    else state.stratum = 'H';
    state.condition = Math.random() < 0.5 ? 'high' : 'low';
  }

  function crisisHit(text) {
    return (C.crisisKeywords || []).some(function (k) { return String(text).indexOf(k) >= 0; });
  }

  function llmMessages(userText) {
    var sys = C.conditions[state.condition].system;
    if (crisisHit(userText)) sys += '\n【重要】请立即使用以下统一危机话术回复，不要使用其他表述：' + C.crisisScript;
    var msgs = [{ role: 'system', content: sys }];
    state.msgs.forEach(function (m) { msgs.push({ role: m.role, content: m.content }); });
    msgs.push({ role: 'user', content: userText });
    return msgs;
  }

  function mockReply() {
    var pool = C.mockReplies[state.condition] || [];
    return pool[state.turns % pool.length] + '（测试模式样例回复）';
  }

  function endpoint() {
    var l = C.llm || {};
    if (C.proxyUrl) return { url: C.proxyUrl, headers: { 'Content-Type': 'application/json' }, useProxy: true };
    if (l.mock || !l.api_key) return null;
    return { url: String(l.base_url).replace(/\/+$/, '') + '/chat/completions', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + l.api_key }, useProxy: false };
  }

  async function generate(userText) {
    var ep = endpoint();
    if (!ep) return mockReply();
    var l = C.llm || {};
    var body = { model: l.model, temperature: l.temperature, max_tokens: l.max_tokens, messages: llmMessages(userText) };
    var r = await fetch(ep.url, { method: 'POST', headers: ep.headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('HTTP ' + r.status + '（若为 CORS 错误请配置 proxyUrl 中转）');
    var d = await r.json();
    var c = d && d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : '';
    return String(c || '').trim();
  }

  async function send(text, auto) {
    $('btnSend').disabled = true;
    $('chatErr').classList.add('hidden');
    bubble('user', text);
    $('chatInput').value = '';
    state.msgs.push({ role: 'user', content: text, chars: text.length, auto: !!auto, ts: new Date().toISOString() });
    state.userChars += text.length;
    if (crisisHit(text)) state.crisis += 1;
    state.turns += 1;
    var reply;
    try {
      reply = await generate(text);
    } catch (e) {
      reply = '（回复获取失败：' + e.message + '）';
      $('chatErr').textContent = '提示：' + e.message;
      $('chatErr').classList.remove('hidden');
    }
    state.msgs.push({ role: 'assistant', content: reply, chars: reply.length, ts: new Date().toISOString() });
    state.aiChars += reply.length;
    bubble('ai', reply);
    $('turnInfo').textContent = '第 ' + state.turns + ' / ' + C.minTurns + ' 轮';
    $('btnEndChat').disabled = state.turns < C.minTurns;
    $('btnSend').disabled = false;
    $('chatInput').focus();
  }

  function scoreOf(id, blocks) {
    var b = blocks.filter(function (x) { return x.id === id; })[0];
    if (!b) return null;
    var arr = (state.t1 && state.t1[id]) || (state.t2 && state.t2[id]);
    if (!arr) return null;
    return b.score === 'sum' ? round(sum(arr)) : round(mean(arr));
  }

  function buildResult() {
    var all = (C.scales.t1 || []).concat(C.scales.t2 || []);
    var r = {
      v: 1, pid: state.pid, sid: state.sid, cond: state.condition, stratum: state.stratum,
      turns: state.turns, user_chars: state.userChars, ai_chars: state.aiChars, crisis: state.crisis,
      gender: state.t1.gender || '', age: state.t1.age || '', edu: state.t1.edu || '', ai_exp: state.t1.ai_exp || '',
      started: state.startedAt, ended: new Date().toISOString()
    };
    all.forEach(function (b) { if (b.type === 'scale') r[b.id] = scoreOf(b.id, all); });
    var att = (C.scales.t2 || []).filter(function (b) { return b.attention; });
    r.att_pass = att.every(function (b) { return state.t2[b.id] === b.attention; }) ? 1 : 0;
    return r;
  }

  function b64(obj) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
  }

  function download(name, text) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
    a.download = name;
    a.click();
  }

  async function submit(result) {
    if (!C.submitEndpoint) return;
    try {
      await fetch(C.submitEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
    } catch (e) { /* 提交失败仍保留结果码与下载 */ }
  }

  $('btnConsent').onclick = function () {
    var pid = $('pid').value.trim();
    if (pid.length < 4) return alert('请输入识别码（手机号后4位+出生月日4位）');
    if (!$('consent').checked) return alert('请先勾选同意');
    state.pid = pid;
    $('minTurns').textContent = C.minTurns;
    var l = C.llm || {};
    if (l.mock || !l.api_key) {
      $('modeBanner').textContent = '测试模式：当前未接入真实大模型，回复为样例文本，请勿用于正式施测。';
      $('modeBanner').classList.remove('hidden');
    }
    renderForm($('t1Form'), C.scales.t1, 't1_');
    show('step-t1');
  };

  $('btnT1').onclick = async function () {
    var r = collect(C.scales.t1, 't1_');
    if (r.missing) {
      var el = document.querySelector('[name="' + r.missing + '"]');
      if (el) el.scrollIntoView({ block: 'center' });
      return alert('还有题目未作答，请完成后再提交');
    }
    state.t1 = r.data;
    state.startedAt = new Date().toISOString();
    state.sid = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
    assign(mean(state.t1.peer));
    $('btnT1').disabled = true;
    show('step-chat');
    await send(C.opening, true);
  };

  $('btnSend').onclick = function () {
    var t = $('chatInput').value.trim();
    if (t) send(t, false);
  };
  $('chatInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('btnSend').click();
  });

  $('btnEndChat').onclick = function () {
    renderForm($('t2Form'), C.scales.t2, 't2_');
    show('step-t2');
  };

  $('btnT2').onclick = async function () {
    var r = collect(C.scales.t2, 't2_');
    if (r.missing) {
      var el = document.querySelector('[name="' + r.missing + '"]');
      if (el) el.scrollIntoView({ block: 'center' });
      return alert('还有题目未作答，请完成后再提交');
    }
    state.t2 = r.data;
    $('btnT2').disabled = true;
    var result = buildResult();
    $('condLabel').textContent = C.conditions[state.condition].label;
    $('resultCode').value = b64(result);
    show('step-done');
    await submit(result);
  };

  $('btnCopy').onclick = function () {
    $('resultCode').select();
    try { document.execCommand('copy'); $('btnCopy').textContent = '已复制'; } catch (e) { alert('请手动全选复制'); }
  };

  $('btnDownload').onclick = function () {
    var payload = { result: buildResult(), messages: state.msgs };
    download('result_' + state.pid + '_' + state.sid.slice(0, 8) + '.json', JSON.stringify(payload, null, 2));
  };
})();
