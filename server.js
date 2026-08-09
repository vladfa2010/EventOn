/* Планета ON — сервер: статика + /api/around (поиск событий рядом через Kimi/Moonshot API) */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

/* --- .env (без внешних зависимостей) --- */
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  env.split('\n').forEach(l => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) {}

const KEY = process.env.MOONSHOT_API_KEY || '';
const BASE = (process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1').replace(/\/$/, '');
const MODELS = ['kimi-k2.6', 'moonshot-v1-32k']; /* k2.6: web_search стабилен; k3 — баг echo (tokenization failed), k2-0711-preview недоступен */
const CACHE_TTL = 12 * 3600 * 1000;
const cache = new Map(); // city:date -> {t, data}

async function chat(body) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.error && (j.error.message || j.error.type)) || ('HTTP ' + r.status);
    const err = new Error(msg);
    err.modelIssue = /model|permission|not exist|not found/i.test(String(msg));
    throw err;
  }
  return j;
}

async function askKimi(city) {
  const today = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const REQ = { max_tokens: 8192, reasoning_effort: 'low' }; /* temperature НЕ слать: k2.6/k3 требуют temperature=1 */
  const sys = [
    'Ты — городская арт-афиша. Используй веб-поиск ($web_search), чтобы найти РЕАЛЬНЫЕ художественные события:',
    'выставки, вернисажи, перформансы, арт-фестивали, — которые проходят СЕГОДНЯ или ЗАВТРА',
    `в городе ${city} и его ближайших окрестностях.`,
    'Верни СТРОГО JSON-массив без markdown и пояснений, до 8 элементов:',
    '[{"title":"...","venue":"...","date":"сегодня|завтра|точные даты","url":"https://...","kind":"exhibition|performance|festival|other"}]',
    'Правила: только события, подтверждённые найденными источниками; url — прямая ссылка на источник;',
    'ничего не выдумывай; если уверенных находок нет — верни [].'
  ].join(' ');
  const tools = [{ type: 'builtin_function', function: { name: '$web_search' } }];
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: `Город: ${city}. Сегодня: ${today}. Найди события через веб-поиск и верни только JSON.` }
  ];

  let lastErr = null;
  for (const model of MODELS) {
    try {
      /* до 3 раундов: модель может попросить поиск несколько раз;
         эхо tool_call: content = arguments ДОСЛОВНО (поиск исполняется на стороне Moonshot) */
      let msg = null;
      for (let round = 0; round < 3; round++) {
        const j = await chat(Object.assign({ model, messages, tools }, REQ));
        msg = j.choices && j.choices[0] && j.choices[0].message;
        if (!msg) throw new Error('empty response');
        const fr = j.choices[0].finish_reason;
        if (fr !== 'tool_calls' || !(msg.tool_calls && msg.tool_calls.length)) break;
        messages.push(msg);
        for (const tc of msg.tool_calls) {
          messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: tc.function.arguments });
        }
      }
      const text = (msg && msg.content) || '';
      const m = text.match(/\[[\s\S]*\]/);
      if (!m) return [];
      let arr;
      try { arr = JSON.parse(m[0]); } catch (e) { return []; }
      const seen = new Set();
      return arr
        .filter(x => x && x.title && /^https?:\/\//.test(x.url || ''))
        .filter(x => !seen.has(x.url) && seen.add(x.url))
        .slice(0, 8)
        .map(x => ({
          title: String(x.title).slice(0, 90),
          venue: String(x.venue || '').slice(0, 80),
          date: String(x.date || '').slice(0, 40),
          url: x.url,
          kind: ['exhibition', 'performance', 'festival', 'other'].includes(x.kind) ? x.kind : 'other'
        }));
    } catch (e) {
      lastErr = e;
      if (!e.modelIssue) throw e; /* ошибки сети/авторизации — нет смысла пробовать другую модель */
    }
  }
  throw lastErr || new Error('all models failed');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2'
};

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/api/around') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const city = (u.searchParams.get('city') || '').slice(0, 60).trim();
    if (!city) { res.end(JSON.stringify({ ok: false, error: 'no city' })); return; }
    if (!KEY) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: 'MOONSHOT_API_KEY is not set' })); return; }
    const ck = city.toLowerCase() + ':' + new Date().toDateString();
    const hit = cache.get(ck);
    if (hit && Date.now() - hit.t < CACHE_TTL) {
      res.end(JSON.stringify({ ok: true, city, events: hit.data, cached: true })); return;
    }
    try {
      const events = await askKimi(city);
      cache.set(ck, { t: Date.now(), data: events });
      res.end(JSON.stringify({ ok: true, city, events }));
    } catch (e) {
      res.statusCode = 502;
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  /* статика */
  if (u.pathname === '/.env' || u.pathname.startsWith('/.')) { res.statusCode = 404; res.end('not found'); return; }
  const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).replace(/^\/+/, '');
  const fp = path.join(__dirname, rel);
  if (!fp.startsWith(__dirname)) { res.statusCode = 403; res.end(); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream');
    res.end(data);
  });
}).listen(PORT, () => console.log('Планета ON server on :' + PORT));
