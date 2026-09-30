'use strict';
/* 解码被试粘贴回来的结果码，输出 CSV
   用法:
     node decode.js <单个结果码>
     node decode.js -f codes.txt      （每行一个结果码，批量导出 results.csv）
*/
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

function decode(code) {
  const json = Buffer.from(code.trim(), 'base64').toString('utf8');
  return JSON.parse(json);
}

function toCSV(rows) {
  const headers = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? '"' + s + '"' : s;
  };
  return [headers.join(',')].concat(rows.map((r) => headers.map((h) => esc(r[h])).join(','))).join('\n');
}

let rows = [];
if (args[0] === '-f' && args[1]) {
  const lines = fs.readFileSync(args[1], 'utf8').split('\n').filter((l) => l.trim());
  rows = lines.map((l, i) => {
    try { return decode(l); } catch (e) { console.error('第 ' + (i + 1) + ' 行解码失败，已跳过'); return null; }
  }).filter(Boolean);
  const out = path.join(path.dirname(args[1]), 'results.csv');
  fs.writeFileSync(out, '\ufeff' + toCSV(rows), 'utf8');
  console.log('已解码 ' + rows.length + ' 条 → ' + out);
  const by = rows.reduce((a, r) => (a[r.cond] = (a[r.cond] || 0) + 1, a), {});
  console.log('分组: 高EI=' + (by.high || 0) + '  低EI=' + (by.low || 0));
  console.log('同伴支持分层: ' + JSON.stringify(rows.reduce((a, r) => (a[r.stratum] = (a[r.stratum] || 0) + 1, a), {})));
} else if (args[0]) {
  const r = decode(args[0]);
  console.log(JSON.stringify(r, null, 2));
} else {
  console.log('用法: node decode.js <结果码>   或   node decode.js -f codes.txt');
}
