/* 大模型请求中转 + 每日完成情况实时上报（Cloudflare Worker 示例，免费额度足够本研究使用）

   一、大模型中转（原有功能）
     作用：让静态页面不必直连大模型 API —— 既解决 CORS 拦截，也避免密钥暴露在浏览器。
     部署：Cloudflare Dashboard → Workers → 创建 → 粘贴本文件 → 设置环境变量
           LLM_BASE_URL = https://api.deepseek.com/v1
           LLM_MODEL    = deepseek-chat
           LLM_KEY      = sk-xxxxxx   （在 Settings → Variables 中加密保存）
     部署后把 Worker 地址填入 assets/config.js 的 proxyUrl。

   二、每日完成情况实时上报（可选，七日实验用）
     作用：被试每天完成对话时，页面自动向本 Worker 上报一条轻量记录
           （手机号/组别/天数/日期/轮次/危机词，不含对话与问卷内容），
           研究者在 admin.html 点「从服务器刷新实时数据」即可实时看到每人每天是否完成。
     开启步骤：
       1. Cloudflare Dashboard → Storage & Databases → KV → 创建命名空间（如 zhixu_reports）；
       2. Worker → Settings → Bindings → 添加 KV 绑定，变量名必须填：REPORTS；
       3. （可选）Worker → Settings → Variables → 添加 ADMIN_KEY = 自定义密钥（加密保存），
          并把相同值填到 assets/config.js 的 reportAdminKey（防止无关人员拉取上报数据）；
       4. 把本 Worker 地址填到 assets/config.js 的 reportUrl。
     不绑定 KV 时，/report 与 /reports 会返回错误，但不影响大模型中转功能；
     也可以把 reportUrl 留空，完全不用此功能。

   接口：
     POST /report    被试端上报（无需鉴权，仅接受合法手机号）
     GET  /reports   管理端分页拉取（需 X-Admin-Key，若设置了 ADMIN_KEY）；?offset=0&limit=40
     POST /chat/completions 透传到大模型（原有） */
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors() });
    }
    const url = new URL(request.url);

    /* ---- 每日完成情况上报（可选） ---- */
    if (url.pathname === '/report' && request.method === 'POST') {
      if (!env.REPORTS) return json({ error: 'KV REPORTS not bound' }, 500);
      let b;
      try { b = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
      const pid = String(b.pid || '');
      if (!/^\d{5,20}$/.test(pid)) return json({ error: 'bad pid' }, 400);
      const key = 'rpt:' + pid;
      let rec = {};
      try { rec = JSON.parse((await env.REPORTS.get(key)) || '{}') || {}; } catch (e) { rec = {}; }
      rec.pid = pid;
      if (b.group) rec.group = b.group;
      if (b.cond) rec.cond = b.cond;
      rec.days = rec.days || {};
      if (b.date && /^\d{4}-\d{2}-\d{2}$/.test(String(b.date))) {
        rec.days[String(b.date)] = {
          day: b.day || null, turns: b.turns || 0, crisis: b.crisis || 0,
          att_pass: (b.att_pass === null || b.att_pass === undefined) ? null : b.att_pass, ts: b.ts || ''
        };
      }
      rec.updated = new Date().toISOString();
      await env.REPORTS.put(key, JSON.stringify(rec)); /* 每名被试一个键，同日重复完成会覆盖 */
      return json({ ok: true });
    }

    if (url.pathname === '/reports' && request.method === 'GET') {
      if (!env.REPORTS) return json({ error: 'KV REPORTS not bound' }, 500);
      if (env.ADMIN_KEY && request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
        return json({ error: 'unauthorized' }, 401);
      }
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const limit = Math.min(40, Math.max(1, parseInt(url.searchParams.get('limit') || '40', 10) || 40));
      const list = await env.REPORTS.list({ prefix: 'rpt:' });
      const names = list.keys.map((k) => k.name).slice(offset, offset + limit);
      const records = (await Promise.all(names.map(async (k) => {
        try { return JSON.parse((await env.REPORTS.get(k)) || '{}'); } catch (e) { return {}; }
      }))).filter((r) => r && r.pid);
      return json({ records, total: list.keys.length, offset, limit });
    }

    /* ---- 大模型请求中转（原有） ---- */
    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405);
    }
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }

    const upstream = await fetch(env.LLM_BASE_URL.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + env.LLM_KEY,
      },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        messages: body.messages,
        temperature: body.temperature ?? 0.7,
        max_tokens: body.max_tokens ?? 500,
      }),
    });

    const data = await upstream.json();
    return json(data, upstream.status);
  },
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  };
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, cors()),
  });
}
