'use strict';
/* 从 experiment-platform/config/*.json 生成静态版 assets/config.js
   用法: node tools/build.js   （改动量表或系统指令后重新执行一次即可同步） */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', 'experiment-platform');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, 'config', f), 'utf8'));

const cfg = read('config.json');
const prompts = read('prompts.json');
const scales = read('scales.json');

const out = {
  minTurns: cfg.min_turns || 5,
  peerLow: cfg.peer_low_cut,
  peerHigh: cfg.peer_high_cut,
  llm: cfg.llm,
  proxyUrl: '',          // 部署 tools/proxy-worker.js 后填入地址，可避免 CORS 与密钥暴露
  submitEndpoint: '',    // 可选：完成后自动 POST 结果的接口（如自建表单/云函数）
  opening: prompts.opening,
  crisisScript: prompts.crisis_script,
  crisisKeywords: prompts.crisis_keywords,
  conditions: prompts.conditions,
  mockReplies: prompts.mock_replies,
  scales: scales,
};

const target = path.join(__dirname, '..', 'assets', 'config.js');
fs.writeFileSync(target, 'window.APP_CONFIG = ' + JSON.stringify(out, null, 2) + ';\n', 'utf8');
console.log('已生成: ' + target);
