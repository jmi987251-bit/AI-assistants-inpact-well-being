/* 研究者数据中心（admin.html）— 五日实验版
   数据来源：
     1) 被试粘贴回问卷的结果码 / 被试页面「下载完整记录」的 json
        （按 sid 去重；v3 结果码含天数与日期，旧格式按时间戳推导日期）；
     2) 可选：worker 实时上报（config.reportUrl，需在 worker 绑定 KV REPORTS）——
        仅含每日完成标记与轮次/危机词，不含问卷与对话内容。
   本地存储：会话记录 zhixu_records_v1；实时上报 zhixu_remote_v1（均在本浏览器）。
   登录密码为 config.js 中 admin.passwordHash 的 SHA-256 原文，仅防误入。 */
(function () {
  var C = window.APP_CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var KEY = 'zhixu_records_v1';
  var RKEY = 'zhixu_remote_v1';
  var records = {};
  var remote = {};
  try { records = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { records = {}; }
  try { remote = JSON.parse(localStorage.getItem(RKEY) || '{}') || {}; } catch (e) { remote = {}; }

  function save() { localStorage.setItem(KEY, JSON.stringify(records)); }
  function saveRemote() { localStorage.setItem(RKEY, JSON.stringify(remote)); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function dateStr() { return new Date().toISOString().slice(0, 10); }
  function condLabel(cond) { return (C.conditions && C.conditions[cond] && C.conditions[cond].label) || cond || '?'; }

  /* ---------- 日期工具（本机自然日） ---------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayStr() { return fmtDate(new Date()); }
  function dayDiff(a, b) { return Math.round((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 86400000); }
  function addDays(s, n) { var d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return fmtDate(d); }
  function totalDays() { return (C.study && C.study.totalDays) || 5; }
  /* 记录的会话日期：优先 v3 的 date 字段，旧格式按结束/开始时间戳推导 */
  function recDate(res) { return res.date || String(res.ended || res.started || '').slice(0, 10) || ''; }

  /* ---------------- 登录 ---------------- */
  async function sha256(s) {
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  async function tryLogin() {
    var err = $('loginErr');
    err.classList.add('hidden');
    var want = (C.admin && C.admin.passwordHash) || '';
    if (!want) { err.textContent = 'config.js 中未配置 admin.passwordHash'; err.classList.remove('hidden'); return; }
    var h = null;
    try { h = await sha256($('pwd').value); }
    catch (e) { err.textContent = '当前环境不支持加密接口，请通过 https 地址或本机直接打开页面'; err.classList.remove('hidden'); return; }
    if (h !== want) { err.textContent = '密码不正确'; err.classList.remove('hidden'); return; }
    sessionStorage.setItem('zhixu_admin', '1');
    enterPanel();
  }

  function enterPanel() {
    $('sec-login').classList.add('hidden');
    $('sec-panel').classList.remove('hidden');
    if (C.reportUrl) $('btnRefreshRemote').classList.remove('hidden');
    render();
  }

  /* ---------------- 导入 ---------------- */
  function decodeCode(line) {
    var s = String(line).trim().replace(/^["']+|["']+$/g, '').trim();
    if (!s) return null;
    var m = s.match(/[A-Za-z0-9+/=]{40,}/); /* 容错：从整行里截出 base64 主体 */
    if (m) s = m[0];
    return JSON.parse(decodeURIComponent(escape(atob(s))));
  }

  function addRecord(obj) {
    if (!obj || typeof obj !== 'object') return false;
    var result = (obj.result && typeof obj.result === 'object') ? obj.result : obj;
    if (!result.pid && !result.sid) return false;
    var sid = result.sid || ('noid_' + result.pid + '_' + Date.now());
    var old = records[sid];
    records[sid] = {
      result: result,
      messages: (obj.messages && obj.messages.length) ? obj.messages : (old && old.messages) || null,
      importedAt: new Date().toISOString()
    };
    return true;
  }

  function importLines(text) {
    var ok = 0, fail = 0;
    String(text).split(/\r?\n/).forEach(function (l) {
      if (!l.trim()) return;
      try { if (addRecord(decodeCode(l))) ok++; else fail++; } catch (e) { fail++; }
    });
    return { ok: ok, fail: fail };
  }

  function importFiles(files) {
    var list = Array.prototype.slice.call(files);
    var pending = list.length, okAll = 0, failAll = 0;
    if (!pending) return;
    list.forEach(function (f) {
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result);
        if (/\.json$/i.test(f.name)) {
          try {
            var data = JSON.parse(text);
            (Array.isArray(data) ? data : [data]).forEach(function (o) {
              try { if (addRecord(o)) okAll++; else failAll++; } catch (e) { failAll++; }
            });
          } catch (e) { failAll++; }
        } else {
          var r = importLines(text);
          okAll += r.ok; failAll += r.fail;
        }
        if (--pending === 0) {
          save(); render();
          $('importMsg').textContent = '文件导入完成：成功 ' + okAll + ' 条' + (failAll ? '，失败/跳过 ' + failAll + ' 条' : '');
        }
      };
      reader.onerror = function () { if (--pending === 0) { save(); render(); $('importMsg').textContent = '部分文件读取失败'; } };
      reader.readAsText(f, 'utf-8');
    });
  }

  /* ---------------- 被试汇总（矩阵数据源） ---------------- */
  function listOfRecords() {
    return Object.keys(records).map(function (k) { return records[k]; })
      .sort(function (a, b) { return String(a.result.started || '').localeCompare(String(b.result.started || '')); });
  }

  /* 按手机号汇总：本地记录 + 实时上报，输出 firstDate / byDate / remoteDays */
  function buildParticipants() {
    var map = {};
    listOfRecords().forEach(function (r) {
      var res = r.result, pid = String(res.pid || '?');
      var p = map[pid] || (map[pid] = { group: '', cond: '', firstDate: '', byDate: {}, remoteDays: null });
      var date = recDate(res);
      if (date) {
        var d = p.byDate[date] || (p.byDate[date] = { crisis: 0, attFail: 0, turns: 0, n: 0 });
        d.n++; d.turns += res.turns || 0; d.crisis += res.crisis || 0;
        if (res.att_pass === 0) d.attFail++;
        if (!p.firstDate || date < p.firstDate) p.firstDate = date;
      }
      if (res.first_date && (!p.firstDate || res.first_date < p.firstDate)) p.firstDate = res.first_date;
      if (!p.group && res.group) p.group = res.group;
      if (!p.cond && res.cond) p.cond = res.cond;
    });
    Object.keys(remote).forEach(function (pid) {
      var p = map[pid] || (map[pid] = { group: '', cond: '', firstDate: '', byDate: {}, remoteDays: {} });
      var rr = remote[pid];
      if (!p.group && rr.group) p.group = rr.group;
      if (!p.cond && rr.cond) p.cond = rr.cond;
      p.remoteDays = rr.days || {};
      Object.keys(p.remoteDays).forEach(function (d) {
        if (!p.firstDate || d < p.firstDate) p.firstDate = d;
      });
    });
    return map;
  }

  /* ---------------- 渲染 ---------------- */
  function stat(v, label, warn) {
    return '<div class="stat' + (warn ? ' warn' : '') + '"><b>' + v + '</b><span>' + label + '</span></div>';
  }

  function render() {
    var list = listOfRecords();
    var parts = buildParticipants();
    var today = todayStr();
    var pids = Object.keys(parts);
    var g = { '1': 0, '2': 0 }, other = 0, todayDone = 0, attFail = 0, crisisPids = {};
    pids.forEach(function (pid) {
      var p = parts[pid];
      if (p.group === '1') g['1']++; else if (p.group === '2') g['2']++; else other++;
      if (p.byDate[today] || (p.remoteDays && p.remoteDays[today])) todayDone++;
    });
    list.forEach(function (r) {
      var res = r.result;
      if (res.att_pass === 0) attFail++;
      if (res.crisis > 0) crisisPids[res.pid] = 1;
    });
    $('nRec').textContent = list.length;
    $('stats').innerHTML =
      stat(pids.length, '总被试数') +
      stat(list.length, '会话记录数') +
      stat(todayDone, '今日已完成') +
      stat(g['1'], '第1组（对照组）') +
      stat(g['2'], '第2组（实验组）') +
      stat(attFail, '注意力未通过（人次）', attFail > 0) +
      stat(Object.keys(crisisPids).length, '危机词触发被试', Object.keys(crisisPids).length > 0);
    renderMatrix(parts);
    renderTable(list);
  }

  function matrixHead(total) {
    var h = '<tr><th>手机号</th><th>组</th><th>条件</th><th>首次对话</th>';
    for (var i = 1; i <= total; i++) h += '<th>D' + i + '</th>';
    h += '<th>已完成</th><th>今日</th><th>危机</th><th>注意力</th></tr>';
    return h;
  }

  function renderMatrix(parts) {
    var total = totalDays();
    var today = todayStr();
    var pids = Object.keys(parts).sort();
    $('mtxHead').innerHTML = matrixHead(total);
    if (!pids.length) {
      $('mtxBody').innerHTML = '<tr><td colspan="' + (8 + total) + '" class="empty">暂无被试数据：导入结果码或从服务器刷新实时数据后，这里会显示每名被试每天的完成情况</td></tr>';
      return;
    }
    $('mtxBody').innerHTML = pids.map(function (pid) {
      var p = parts[pid];
      var cells = '', done = 0, crisisAll = 0, attAll = 0;
      for (var i = 1; i <= total; i++) {
        var d = p.firstDate ? addDays(p.firstDate, i - 1) : '';
        var rec = d && p.byDate[d];
        var rem = d && p.remoteDays && p.remoteDays[d];
        var cls = [], txt = '';
        if (rec) {
          txt = '✓'; done++;
          if (rec.crisis > 0) { txt += '!'; cls.push('warn'); }
          if (rec.attFail > 0) cls.push('att');
          crisisAll += rec.crisis; attAll += rec.attFail;
        } else if (rem) {
          txt = '✓'; done++; cls.push('rmt');
        } else if (d && d < today) {
          txt = '·'; cls.push('miss');
        }
        if (d === today) cls.push('today');
        cells += '<td class="' + cls.join(' ') + '" title="第' + i + '天 ' + (d || '日期未知') + '">' + txt + '</td>';
      }
      var todayCell;
      if (!p.firstDate) todayCell = '<td>—</td>';
      else {
        var curDay = dayDiff(today, p.firstDate) + 1;
        if (curDay < 1) todayCell = '<td>未开始</td>';
        else if (curDay > total) todayCell = '<td>已结束</td>';
        else todayCell = (p.byDate[today] || (p.remoteDays && p.remoteDays[today]))
          ? '<td class="okcell">已完成</td>' : '<td class="misscell">未完成</td>';
      }
      return '<tr><td>' + esc(pid) + '</td>' +
        '<td>' + (p.group ? '第' + esc(p.group) + '组' : '—') + '</td>' +
        '<td>' + esc(condLabel(p.cond)) + '</td>' +
        '<td>' + esc(p.firstDate || '—') + '</td>' +
        cells +
        '<td>' + done + '/' + total + '</td>' + todayCell +
        '<td>' + (crisisAll || '') + '</td>' +
        '<td>' + (attAll || '') + '</td></tr>';
    }).join('');
  }

  function renderTable(list) {
    if (!list.length) {
      $('recBody').innerHTML = '<tr><td colspan="11" class="empty">暂无记录，请先在上方导入结果码或完整记录文件</td></tr>';
      return;
    }
    $('recBody').innerHTML = list.map(function (r, i) {
      var res = r.result;
      var sid = esc(res.sid || '');
      var att = res.att_pass === null || res.att_pass === undefined ? '—' : (res.att_pass ? '通过' : '<span class="err">未通过</span>');
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td>' + esc(res.pid || '') + '</td>' +
        '<td>' + (res.group ? '第' + esc(res.group) + '组' : '—') + '</td>' +
        '<td>' + esc(condLabel(res.cond)) + '</td>' +
        '<td>' + (res.day ? '第' + esc(res.day) + '天' : '—') + '</td>' +
        '<td>' + esc(recDate(res) || '—') + '</td>' +
        '<td>' + (res.turns || 0) + '</td>' +
        '<td>' + att + '</td>' +
        '<td>' + (res.crisis || 0) + '</td>' +
        '<td>' + (r.messages && r.messages.length ? '<a href="#" data-chat="' + sid + '">查看</a>' : '—') + '</td>' +
        '<td><a href="#" data-del="' + sid + '" class="err">删除</a></td>' +
        '</tr>';
    }).join('');
  }

  /* ---------------- 实时上报刷新（可选） ---------------- */
  async function refreshRemote() {
    var base = String(C.reportUrl || '').replace(/\/+$/, '');
    if (!base) return;
    $('remoteMsg').textContent = '正在从服务器拉取…';
    var all = [], offset = 0, total = 1;
    try {
      do {
        var headers = { 'Content-Type': 'application/json' };
        if (C.reportAdminKey) headers['X-Admin-Key'] = C.reportAdminKey;
        var r = await fetch(base + '/reports?offset=' + offset + '&limit=40', { headers: headers });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var d = await r.json();
        all = all.concat(d.records || []);
        total = d.total || all.length;
        offset += 40;
      } while (offset < total);
      remote = {};
      all.forEach(function (rec) {
        if (!rec || !rec.pid) return;
        remote[rec.pid] = { group: rec.group || '', cond: rec.cond || '', days: rec.days || {}, updated: rec.updated || '' };
      });
      saveRemote();
      $('remoteMsg').textContent = '已刷新 ' + Object.keys(remote).length + ' 名被试的实时上报（' + new Date().toLocaleTimeString() + '）';
      render();
    } catch (e) {
      $('remoteMsg').textContent = '刷新失败：' + e.message + '（请确认 worker 已部署并绑定 KV REPORTS）';
    }
  }

  /* ---------------- 对话查看 ---------------- */
  function showChat(sid) {
    var r = records[sid];
    if (!r || !r.messages) return;
    var res = r.result;
    $('modalTitle').textContent = '手机号 ' + (res.pid || '?') + ' · 第' + (res.group || '?') + '组 · ' + condLabel(res.cond) +
      ' · 第' + (res.day || '?') + '天(' + (recDate(res) || '?') + ') · ' + (res.turns || 0) + '轮';
    $('modalBody').innerHTML = r.messages.map(function (m) {
      return '<div class="bubble ' + (m.role === 'user' ? 'user' : 'ai') + '"></div>';
    }).join('');
    var bubbles = $('modalBody').querySelectorAll('.bubble');
    r.messages.forEach(function (m, i) { bubbles[i].textContent = m.content || ''; });
    $('chatModal').classList.remove('hidden');
  }

  /* ---------------- 导出 ---------------- */
  function download(name, text, mime) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: (mime || 'application/octet-stream') + ';charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function escv(v) {
    if (v === null || v === undefined) return '';
    var s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? '"' + s + '"' : s;
  }

  function toCSV() {
    var rows = listOfRecords().map(function (r) { return r.result; });
    if (!rows.length) return alert('暂无记录可导出');
    var pref = ['pid', 'sid', 'group', 'cond', 'stratum', 'day', 'date', 'first_date', 'turns', 'user_chars', 'ai_chars', 'crisis', 'att_pass',
      'gender', 'age', 'edu', 'ai_exp', 'started', 'ended'];
    var headers = [];
    rows.forEach(function (r) { Object.keys(r).forEach(function (h) { if (headers.indexOf(h) < 0) headers.push(h); }); });
    var cols = pref.concat(headers.filter(function (h) { return pref.indexOf(h) < 0; }));
    var lines = [cols.join(',')].concat(rows.map(function (r) {
      return cols.map(function (c) { return escv(r[c]); }).join(',');
    }));
    download('results_' + dateStr() + '.csv', '\ufeff' + lines.join('\n'), 'text/csv');
  }

  /* 被试总览：每名被试一行，第1..N天完成情况 */
  function exportMatrix() {
    var parts = buildParticipants();
    var pids = Object.keys(parts).sort();
    if (!pids.length) return alert('暂无被试数据可导出');
    var total = totalDays();
    var today = todayStr();
    var head = ['手机号', '组别', 'AI条件', '首次对话日期', '已完成天数', '今日状态'];
    for (var i = 1; i <= total; i++) head.push('第' + i + '天');
    head.push('危机词总次数', '注意力未通过天数');
    var lines = [head.join(',')];
    pids.forEach(function (pid) {
      var p = parts[pid];
      var row = [pid, p.group ? '第' + p.group + '组' : '', condLabel(p.cond), p.firstDate || ''];
      var done = 0, crisisAll = 0, attAll = 0;
      var cells = [];
      for (var i = 1; i <= total; i++) {
        var d = p.firstDate ? addDays(p.firstDate, i - 1) : '';
        var rec = d && p.byDate[d];
        var rem = d && p.remoteDays && p.remoteDays[d];
        if (rec) { cells.push('✓'); done++; crisisAll += rec.crisis; attAll += rec.attFail; }
        else if (rem) { cells.push('✓(实时上报)'); done++; }
        else cells.push('');
      }
      var st;
      if (!p.firstDate) st = '未知';
      else {
        var curDay = dayDiff(today, p.firstDate) + 1;
        if (curDay < 1) st = '未开始';
        else if (curDay > total) st = '已结束';
        else st = (p.byDate[today] || (p.remoteDays && p.remoteDays[today])) ? '已完成' : '未完成';
      }
      row.push(done + '/' + total, st);
      lines.push(row.concat(cells, [crisisAll || '', attAll || '']).map(escv).join(','));
    });
    download('participants_' + dateStr() + '.csv', '\ufeff' + lines.join('\n'), 'text/csv');
  }

  function exportJSON() {
    var data = listOfRecords();
    if (!data.length) return alert('暂无记录可导出');
    download('fullrecords_' + dateStr() + '.json', JSON.stringify(data, null, 2), 'application/json');
  }

  function exportTXT() {
    var out = [];
    listOfRecords().forEach(function (r) {
      if (!r.messages || !r.messages.length) return;
      var res = r.result;
      out.push('════════════════════════════════════════════');
      out.push('手机号: ' + (res.pid || '?') + '  |  第' + (res.group || '?') + '组  |  ' + condLabel(res.cond) +
        '  |  第' + (res.day || '?') + '天 ' + (recDate(res) || '?') + '  |  ' + (res.turns || 0) + '轮  |  sid: ' + (res.sid || '?'));
      out.push('开始: ' + (res.started || '?') + '  结束: ' + (res.ended || '?'));
      out.push('────────────────────────────────────────────');
      r.messages.forEach(function (m) {
        out.push((m.role === 'user' ? '[被试] ' : '[AI] ') + (m.content || ''));
        out.push('');
      });
    });
    if (!out.length) out.push('（暂无含对话原文的记录。对话原文来自被试页面「下载完整记录」的 json 文件，在上方导入后即可在此导出。）');
    download('transcripts_' + dateStr() + '.txt', out.join('\n'), 'text/plain');
  }

  /* ---------------- 事件 ---------------- */
  $('btnLogin').onclick = tryLogin;
  $('pwd').addEventListener('keydown', function (e) { if (e.key === 'Enter') tryLogin(); });

  $('btnImportText').onclick = function () {
    var t = $('codes').value;
    if (!t.trim()) return alert('请先在上方文本框粘贴结果码');
    var r = importLines(t);
    save(); render();
    $('importMsg').textContent = '成功导入 ' + r.ok + ' 条' + (r.fail ? '，失败/跳过 ' + r.fail + ' 条（结果码可能被截断或格式有误）' : '');
    if (r.ok) $('codes').value = '';
  };

  $('files').addEventListener('change', function () {
    importFiles(this.files);
    this.value = '';
  });

  $('recBody').addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute('data-chat')) {
      e.preventDefault();
      showChat(t.getAttribute('data-chat'));
    } else if (t && t.getAttribute && t.getAttribute('data-del')) {
      e.preventDefault();
      var sid = t.getAttribute('data-del');
      if (confirm('确定删除该条记录（手机号 ' + (records[sid].result.pid || '?') + '）？此操作不可恢复。')) {
        delete records[sid];
        save(); render();
      }
    }
  });

  $('btnCloseModal').onclick = function () { $('chatModal').classList.add('hidden'); };
  $('chatModal').addEventListener('click', function (e) { if (e.target === this) this.classList.add('hidden'); });

  $('btnCsv').onclick = toCSV;
  $('btnMatrix').onclick = exportMatrix;
  $('btnJson').onclick = exportJSON;
  $('btnTxt').onclick = exportTXT;
  $('btnRefreshRemote').onclick = refreshRemote;

  $('btnClear').onclick = function () {
    if (!Object.keys(records).length) return alert('当前没有数据');
    if (confirm('确定清空本地全部 ' + Object.keys(records).length + ' 条记录吗？请确保已导出备份！')) {
      if (confirm('再次确认：清空后无法恢复。确定继续？')) {
        records = {};
        save(); render();
      }
    }
  };

  /* 已在本会话登录过则直接进入面板 */
  if (sessionStorage.getItem('zhixu_admin') === '1') enterPanel();
})();
