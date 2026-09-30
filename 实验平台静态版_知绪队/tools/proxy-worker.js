/* 大模型请求中转（Cloudflare Worker 示例，免费额度足够本研究使用）
   作用：让静态页面不必直连大模型 API —— 既解决 CORS 拦截，也避免密钥暴露在浏览器。
   部署：Cloudflare Dashboard → Workers → 创建 → 粘贴本文件 → 设置环境变量
         LLM_BASE_URL = https://api.deepseek.com/v1
         LLM_MODEL    = deepseek-chat
         LLM_KEY      = sk-xxxxxx   （在 Settings → Variables 中加密保存）
   部署后把 Worker 地址填入 assets/config.js 的 proxyUrl。
*/
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors() });
    }
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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, cors()),
  });
}
