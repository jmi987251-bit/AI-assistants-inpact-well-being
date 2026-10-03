/* 静态版（七日实验）：无需自建服务器即可运行。
   说明：浏览器直连大模型 API 通常会被 CORS 拦截，且会暴露密钥。
   正式施测请在 config.js 中填写 proxyUrl（部署 tools/proxy-worker.js 即可）。
   本版核心变化：
   - 手机号登录（作为被试编号，无需验证码）；
   - 从被试第一次与AI对话当天起按自然日计算“第几天”，页面每天提示进度；
   - 每天完成一次对话，当日完成后锁定；第 totalDays+1 天起显示全部完成；
   - 被试档案（进度、组别、基线、每日结果码）保存在被试本机浏览器 localStorage，
     以手机号区分，换设备或清缓存会导致天数重新计算（研究者端按实际日期归组）。 */
(function () {
  var C = window.APP_CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var state = { pid: '', sid: '', group: '', condition: '', stratum: '', day: 1, t1: null, t2: null, turns: 0, msgs: [], crisis: 0, userChars: 0, aiChars: 0, startedAt: '' };
  var user = null; /* 当前手机号在本机的档案 */

  var show = function (id) {
    ['step-login', 'step-consent', 'step-t1', 'step-chat', 'step-t2', 'step-done'].forEach(function (s) {
      $(s).classList.toggle('hidden', s !== id);
    });
    window.scrollTo(0, 0);
  };

  var mean = function (a) { var v = (a || []).filter(function (x) { return typeof x === 'number' && !isNaN(x); }); return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null; };
  var sum = function (a) { var v = (a || []).filter(function (x) { return typeof x === 'number' && !isNaN(x); }); return v.length ? v.reduce(function (a, b) { return a + b; }, 0) : null; };
  var round = function (x) { return x === null ? null : Math.round(x * 10000) / 10000; };

  /* ---------- 日期工具（均按被试本机自然日） ---------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayStr() { return fmtDate(new Date()); }
  function dayDiff(a, b) { return Math.round((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 86400000); }
  function addDays(s, n) { var d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return fmtDate(d); }
  function totalDays() { return (C.study && C.study.totalDays) || 7; }
  function needT2(day) {
    var t = (C.study && C.study.t2Days) || 'all';
    if (t === 'all') return true;
    return Array.isArray(t) && t.indexOf(day) >= 0;
  }

  /* ---------- 被试档案（本机 localStorage，按手机号区分） ---------- */
  function loadUser(pid) {
    try { return JSON.parse(localStorage.getItem('gsx_user_' + pid) || 'null'); } catch (e) { return null; }
  }
  function saveUser() {
    if (!state.pid || !user) return;
    try { localStorage.setItem('gsx_user_' + state.pid, JSON.stringify(user)); } catch (e) { }
  }
  /* 该被试对应的 AI 条件（manual=按组别；random=延续首日随机结果） */
  function condOf(u) {
    if (C.assignment !== 'random' && u && u.group && C.groups && C.groups[u.group]) return C.groups[u.group].cond;
    return (u && u.cond) || '';
  }

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

  /* 组别选择（manual 模式）：由被试按研究人员告知的组号选择，决定接入哪一套 AI */
  function initGroupSel() {
    var box = $('groupSel');
    if (!box) return;
    if (C.assignment === 'random' || !C.groups) { box.classList.add('hidden'); return; }
    var html = '<div class="qtitle gs-title">实验分组（请选择研究人员告知您的组别）</div><div>';
    Object.keys(C.groups).forEach(function (g) {
      html += '<label class="opt"><input type="radio" name="grp" value="' + g + '"> ' + C.groups[g].label + '</label>';
    });
    box.innerHTML = html + '</div>';
  }

  /* 当前组生效的 LLM 配置：全局 llm + 组内覆盖（model / temperature / proxyUrl 等） */
  function groupCfg() {
    var g = (state.group && C.groups && C.groups[state.group]) || {};
    var l = {};
    for (var k in (C.llm || {})) l[k] = C.llm[k];
    if (g.llm) for (var k2 in g.llm) l[k2] = g.llm[k2];
    l.proxyUrl = g.proxyUrl || C.proxyUrl || '';
    return l;
  }

  /* 分组：manual = 被试所选组别映射到对应 AI 条件；random = 首日随机、之后延续。
     同伴支持分层仅作记录；第 2 天起沿用基线同伴支持得分，保证分层稳定。 */
  function assign(peer) {
    if (peer === null || peer === undefined || isNaN(peer)) state.stratum = 'U';
    else if (peer <= C.peerLow) state.stratum = 'L';
    else if (peer <= C.peerHigh) state.stratum = 'M';
    else state.stratum = 'H';
    var g = (C.assignment !== 'random' && state.group && C.groups) ? C.groups[state.group] : null;
    if (g) state.condition = g.cond;
    else if (user && user.cond) state.condition = user.cond;
    else state.condition = Math.random() < 0.5 ? 'high' : 'low';
    if (!g && user) { user.cond = state.condition; saveUser(); }
  }

  function crisisHit(text) {
    return (C.crisisKeywords || []).some(function (k) { return String(text).indexOf(k) >= 0; });
  }

  function llmMessages(userText) {
    var cond = C.conditions[state.condition] || {};
    var sys = cond.system;
    if (crisisHit(userText)) sys += '\n【重要】请立即使用以下统一危机话术回复，不要使用其他表述：' + C.crisisScript;
    /* 跨天记忆：memory=true 的条件（高EI组）在非第1天时，把此前各天对话记录
       注入系统提示词，使 AI 能主动跟进此前话题；memory 未开启的条件每天独立。
       记录只来自当前手机号的档案（user.history），与其他被试完全隔离。 */
    if (cond.memory && user && user.history && user.history.length) {
      var mem = '\n\n【跨天记忆】以下是用户在此前日子里与你（本AI）的对话记录。你真实记得这些事。要求：\n' +
        '- 如果用户本次没有主动提起之前的事，你必须在回复中自然地问起其中至少一件的后续进展（像老朋友惦记着那样）；\n' +
        '- 不要向用户提及"记录"或逐字复述原文，用你自己的话自然带出；\n' +
        '- 用户之前提过的关键事项如下：';
      user.history.forEach(function (h) {
        mem += '\n—— 第' + h.day + '天（' + h.date + '）——';
        (h.msgs || []).forEach(function (m) {
          var who = m.role === 'user' ? '用户' : 'AI';
          var txt = String(m.content || '');
          if (txt.length > 200) txt = txt.slice(0, 200) + '…';
          mem += '\n' + who + '：' + txt;
        });
      });
      sys += mem;
    }
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
    var l = groupCfg();
    if (l.proxyUrl) return { url: l.proxyUrl, headers: { 'Content-Type': 'application/json' }, useProxy: true };
    if (l.mock || !l.api_key) return null;
    return { url: String(l.base_url).replace(/\/+$/, '') + '/chat/completions', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + l.api_key }, useProxy: false };
  }

  async function generate(userText) {
    var ep = endpoint();
    if (!ep) return mockReply();
    var l = groupCfg();
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
      v: 3, pid: state.pid, sid: state.sid, group: state.group, cond: state.condition, stratum: state.stratum,
      day: state.day, date: todayStr(), first_date: (user && user.firstDay) || todayStr(),
      turns: state.turns, user_chars: state.userChars, ai_chars: state.aiChars, crisis: state.crisis,
      gender: state.t1 ? (state.t1.gender || '') : '',
      age: state.t1 ? (state.t1.age || '') : '',
      edu: state.t1 ? (state.t1.edu || '') : '',
      ai_exp: state.t1 ? (state.t1.ai_exp || '') : '',
      t2History: user.t2History || {},
      started: state.startedAt, ended: new Date().toISOString()
    };
    all.forEach(function (b) { if (b.type === 'scale') r[b.id] = scoreOf(b.id, all); });
    var att = (C.scales.t2 || []).filter(function (b) { return b.attention; });
    r.att_pass = state.t2 ? (att.every(function (b) { return state.t2[b.id] === b.attention; }) ? 1 : 0) : null;
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

  /* 完成当天对话后向 worker 上报一条轻量记录（可选；config.reportUrl 未配置则跳过） */
  function sendReport(result) {
    if (!C.reportUrl) return;
    try {
      fetch(String(C.reportUrl).replace(/\/+$/, '') + '/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid: result.pid, group: result.group, cond: result.cond, day: result.day, date: result.date,
          turns: result.turns, crisis: result.crisis, att_pass: result.att_pass, sid: result.sid, ts: result.ended
        })
      }).catch(function () { });
    } catch (e) { }
  }

  /* ---------- 天数进度条 ---------- */
  function renderDayBar() {
    var total = totalDays();
    var day = state.day;
    var dots = '';
    for (var i = 1; i <= total; i++) {
      var dstr = addDays(user.firstDay, i - 1);
      var cls = 'dot';
      if (user.days && user.days[dstr]) cls += ' done';
      else if (i < day) cls += ' miss';
      if (i === day) cls += ' cur';
      dots += '<span class="' + cls + '" title="第' + i + '天 ' + dstr + '"></span>';
    }
    var missedYest = (day >= 2 && user.days && !user.days[addDays(user.firstDay, day - 2)])
      ? '<div class="missnote">提示：昨天没有完成对话记录，今天继续加油。</div>' : '';
    $('dayBar').innerHTML = '<div class="dayline"><b>今天是您参与实验的第 ' + day + ' 天</b>' +
      '<span class="oftotal">共 ' + total + ' 天</span>' +
      '<span class="dots">' + dots + '</span>' +
      '<span class="dtdisp">' + todayStr() + '</span></div>' + missedYest;
  }

  /* ---------- 每日会话 ---------- */
  async function prepAndChat() {
    if (!user.firstDay) { user.firstDay = todayStr(); saveUser(); } /* 第1天 = 首次与AI对话当天 */
    state.day = dayDiff(todayStr(), user.firstDay) + 1;
    if (state.day > totalDays()) return showFinished();
    if (!state.t1 && user.t1) state.t1 = user.t1; /* 基线问卷随每日结果码一并带走 */
    state.sid = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
    state.startedAt = new Date().toISOString();
    state.turns = 0; state.msgs = []; state.crisis = 0; state.userChars = 0; state.aiChars = 0; state.t2 = null;
    assign(state.t1 ? mean(state.t1.peer) : (typeof user.peer === 'number' && !isNaN(user.peer) ? user.peer : null));
    $('minTurns').textContent = C.minTurns;
    $('turnInfo').textContent = '第 0 / ' + C.minTurns + ' 轮';
    $('btnEndChat').disabled = true;
    $('chatLog').innerHTML = '';
    var l = groupCfg();
    if (l.mock || !l.api_key) {
      $('modeBanner').textContent = '测试模式：当前未接入真实大模型，回复为样例文本，请勿用于正式施测。';
      $('modeBanner').classList.remove('hidden');
    }
    renderDayBar();
    show('step-chat');
    await send(C.opening, true);
  }

  /* 已同意的被试进入当天流程：基线问卷只做一次，之后每天直接对话 */
  async function beginSession() {
    if (!user.t1done) {
      state.t1 = null;
      renderForm($('t1Form'), C.scales.t1, 't1_');
      show('step-t1');
    } else {
      await prepAndChat();
    }
  }

  function finish() {
    var result = buildResult();
    var code = b64(result);
    var total = totalDays();
    user.days = user.days || {};
    user.days[todayStr()] = { day: result.day, sid: result.sid, code: code };
    /* 跨天记忆：累计保存每天完整对话，供 memory=true 的条件后续天数注入 */
    user.history = user.history || [];
    user.history.push({ day: result.day, date: result.date, msgs: state.msgs });
    user.lastPayload = { result: result, messages: state.msgs };
    saveUser();
    $('resultCode').value = code;
    var isLast = result.day >= total;
    $('doneTitle').textContent = isLast ? '全部 ' + total + ' 天实验完成，感谢您的参与！' : '第 ' + result.day + ' 天对话完成！';
    $('doneText').innerHTML = isLast
      ? '您已完成全部实验。请复制下方结果码粘贴回问卷，这是您完成实验的凭证。'
      : '请复制下方结果码粘贴回问卷。明天记得用同一手机号登录，继续第 ' + (result.day + 1) + ' 天的对话。';
    $('debriefText').classList.toggle('hidden', !isLast);
    if (isLast) $('condLabel').textContent = (C.conditions[state.condition] || {}).label || state.condition;
    show('step-done');
    sendReport(result);
    submit(result);
  }

  /* 当天再次登录：展示“今天已完成”与当天结果码 */
  function showDoneToday() {
    var rec = (user.days && user.days[todayStr()]) || {};
    var total = totalDays();
    $('resultCode').value = rec.code || '';
    $('doneTitle').textContent = '今天已完成（第 ' + (rec.day || '?') + ' 天）';
    $('doneText').innerHTML = '您今天已经完成了对话，无需重复进行。请复制下方结果码粘贴回问卷。' +
      ((rec.day || 0) < total ? '明天记得用同一手机号登录，继续第 ' + ((rec.day || 0) + 1) + ' 天。' : '您已完成全部实验，感谢参与！');
    var isLast = (rec.day || 0) >= total;
    $('debriefText').classList.toggle('hidden', !isLast);
    if (isLast) $('condLabel').textContent = (C.conditions[condOf(user)] || {}).label || condOf(user);
    show('step-done');
  }

  /* 第 totalDays+1 天起：实验全部完成 */
  function showFinished() {
    var total = totalDays();
    var last = null;
    Object.keys(user.days || {}).sort().forEach(function (d) { last = user.days[d]; });
    $('resultCode').value = (last && last.code) || '';
    $('doneTitle').textContent = '实验已全部完成';
    $('doneText').innerHTML = '您已完成全部 ' + total + ' 天的实验，感谢您的参与！如需补交结果码，可复制下方最近一天的记录。';
    $('debriefText').classList.remove('hidden');
    $('condLabel').textContent = (C.conditions[condOf(user)] || {}).label || condOf(user);
    show('step-done');
  }

  /* ---------- 事件 ---------- */
  $('btnLogin').onclick = function () {
    var phone = $('phone').value.trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) return alert('请输入正确的11位手机号');
    state.pid = phone;
    user = loadUser(phone) || null;
    state.group = (user && user.group) || '';
    if (user && user.consent) {
      if (user.firstDay) {
        var day = dayDiff(todayStr(), user.firstDay) + 1;
        if (day > totalDays()) return showFinished();
        if (user.days && user.days[todayStr()]) return showDoneToday();
      }
      return beginSession();
    }
    show('step-consent');
  };
  $('phone').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('btnLogin').click(); });

  $('btnConsent').onclick = async function () {
    var grp = document.querySelector('input[name="grp"]:checked');
    if (C.assignment !== 'random' && C.groups && !grp) return alert('请选择您的实验分组（由研究人员告知）');
    if (!$('consent').checked) return alert('请先勾选同意');
    state.group = grp ? grp.value : '';
    user = { consent: true, group: state.group, firstDay: null, t1done: false, t1: null, peer: null, cond: '', days: {}, lastPayload: null };
    saveUser();
    await beginSession();
  };

  $('btnT1').onclick = async function () {
    var r = collect(C.scales.t1, 't1_');
    if (r.missing) {
      var el = document.querySelector('[name="' + r.missing + '"]');
      if (el) el.scrollIntoView({ block: 'center' });
      return alert('还有题目未作答，请完成后再提交');
    }
    state.t1 = r.data;
    user.t1done = true;
    user.t1 = r.data;
    user.peer = mean(state.t1.peer);
    saveUser();
    $('btnT1').disabled = true;
    await prepAndChat();
  };

  $('btnSend').onclick = function () {
    var t = $('chatInput').value.trim();
    if (t) send(t, false);
  };
  $('chatInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('btnSend').click();
  });

  $('btnEndChat').onclick = function () {
    if (needT2(state.day)) {
      renderForm($('t2Form'), C.scales.t2, 't2_');
      show('step-t2');
    } else {
      finish();
    }
  };

  $('btnT2').onclick = async function () {
    var r = collect(C.scales.t2, 't2_');
    if (r.missing) {
      var el = document.querySelector('[name="' + r.missing + '"]');
      if (el) el.scrollIntoView({ block: 'center' });
      return alert('还有题目未作答，请完成后再提交');
    }
   state.t2 = r.data;
    //===== 新增开始 =====
    if (!user.t2History) user.t2History = {};
    user.t2History[state.day] = r.data;
    saveUser();
    //===== 新增结束 =====
    $('btnT2').disabled = true;
    finish();
  };

  $('btnCopy').onclick = function () {
    $('resultCode').select();
    try { document.execCommand('copy'); $('btnCopy').textContent = '已复制'; } catch (e) { alert('请手动全选复制'); }
  };

  $('btnDownload').onclick = function () {
    var payload = user.lastPayload || (state.msgs.length ? { result: buildResult(), messages: state.msgs } : null);
    if (!payload) return alert('暂无可下载的记录');
    download('result_' + state.pid + '_day' + (payload.result.day || 'x') + '_' + String(payload.result.sid || '').slice(0, 8) + '.json',
      JSON.stringify(payload, null, 2));
  };

  initGroupSel();
  show('step-login');
})();
