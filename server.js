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
const cache = new Map(); // city:date -> {t, data, ttl}
const jobs = new Map();  // city:date -> {t, status, events?, err?}

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

async function askKimi(city, budgetMs) {
  const today = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const budget = budgetMs || 300000;
  const REQ = { max_tokens: 8192, reasoning_effort: 'low' }; /* temperature НЕ слать: k2.6/k3 требуют temperature=1 */
  const sys = [
    'Ты — городская арт-афиша. Используй веб-поиск ($web_search), чтобы найти РЕАЛЬНЫЕ художественные события:',
    'выставки, вернисажи, перформансы, арт-фестивали, — которые можно посетить СЕГОДНЯ или ЗАВТРА',
    `в городе ${city} и его ближайших окрестностях. Подходят и выставки, которые идут сейчас (открыты в эти дни), даже если начались раньше.`,
    'Сделай минимум 2–3 поисковых запроса разными словами — на языке страны города и по-английски',
    '(например: «афиша», «выставки», «что посмотреть», «музей экспозиция» + название города). Не сдавайся после первого пустого поиска.',
    'Затем верни СТРОГО JSON-массив без markdown, рассуждений, планов и html-тегов, до 8 элементов:',
    '[{"title":"...","venue":"...","date":"сегодня|завтра|точные даты","url":"https://...","kind":"exhibition|performance|festival|other"}]',
    'Правила: только события, подтверждённые найденными источниками; url — прямая ссылка на источник;',
    'ничего не выдумывай; если уверенных находок нет — верни до 8 событий ближайших 7 дней с точными датами; если и их нет — верни [].'
  ].join(' ');
  const tools = [{ type: 'builtin_function', function: { name: '$web_search' } }];
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: `Город: ${city}. Сегодня: ${today}. Найди события через веб-поиск и верни только JSON.` }
  ];

  let lastErr = null;
  for (const model of MODELS) {
    try {
      /* извлекаем JSON устойчиво: модель может обернуть ответ рассуждениями/тегами —
         пробуем весь текст, затем все [...]-кандидаты от самых длинных */
      const parseArr = (text) => {
        const t = (text || '').trim();
        const cands = [t];
        const re = /\[[\s\S]*?\]/g; let mm;
        while ((mm = re.exec(t))) cands.push(mm[0]);
        cands.sort((a, b) => b.length - a.length);
        for (const c of cands) {
          try { const a = JSON.parse(c); if (Array.isArray(a)) return a; } catch (e) {}
        }
        return null;
      };
      /* один раунд диалога: либо эхо поиска (вернёт null), либо финальный текст → массив */
      const runRound = async () => {
        const j = await chat(Object.assign({ model, messages, tools }, REQ));
        const m = j.choices && j.choices[0] && j.choices[0].message;
        if (!m) throw new Error('empty response');
        const fr = j.choices[0].finish_reason;
        if (fr === 'tool_calls' && m.tool_calls && m.tool_calls.length) {
          messages.push(m);
          for (const tc of m.tool_calls) {
            messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: tc.function.arguments });
          }
          return null;
        }
        messages.push(m);
        return parseArr(m.content);
      };
      /* до 3 раундов поиска; temperature=1 → ответы вариативны,
         поэтому при мусоре/пустоте — до 2 переспросов с правом искать снова */
      const deadline = Date.now() + budget; /* жёсткий потолок на один заход */
      let arr = null;
      for (let round = 0; round < 4 && !arr && Date.now() < deadline; round++) arr = await runRound();
      const NUDGES = [
        'События точно есть. Сделай ещё 1–2 поиска другими словами (афиша, выставки, вернисаж, музеи, что посетить, kudamoscow, afisha, timeout) и верни СТРОГО JSON-массив без рассуждений.',
        'Попробуй ещё раз: другие запросы и источники, можно по-английски. Только JSON-массив; если совсем ничего — [].'
      ];
      for (let retry = 0; retry < NUDGES.length && (!arr || !arr.length) && Date.now() < deadline; retry++) {
        messages.push({ role: 'user', content: NUDGES[retry] });
        arr = null;
        for (let round = 0; round < 2 && !arr && Date.now() < deadline; round++) arr = await runRound();
      }
      if (!arr) return [];
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

/* --- геокодинг без ключа: Nominatim (русские названия) основной, Photon — резерв --- */
const geoCache = new Map();
let lastNom = 0, nomDownUntil = 0;
async function nomFetch(url) {
  if (Date.now() < nomDownUntil) throw new Error('nominatim down (breaker)');
  try {
    const wait = 1100 - (Date.now() - lastNom); /* политика: не чаще 1 запроса/сек */
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastNom = Date.now();
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 6000);
    const r = await fetch(url, { headers: { 'User-Agent': 'planeta-on/1.0 (world events afisha)' }, signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error('nominatim HTTP ' + r.status);
    return await r.json();
  } catch (e) { nomDownUntil = Date.now() + 10 * 60 * 1000; throw e; }
}
async function photonFetch(url) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) { /* 503 у photon — транзиент, пробуем с паузой */
    try {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);
      const r = await fetch(url, { signal: ac.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error('photon HTTP ' + r.status);
      return await r.json();
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 2500)); }
  }
  throw lastErr;
}
async function reverseCity(lat, lng) {
  const key = lat.toFixed(1) + ',' + lng.toFixed(1);
  if (geoCache.has(key)) return geoCache.get(key);
  let city = '';
  try {
    const j = await nomFetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=10&accept-language=ru`);
    const a = (j && j.address) || {};
    city = a.city || a.town || a.village || a.municipality || a.county || a.state || '';
  } catch (e) {
    const j = await photonFetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}`);
    const feats = (j && j.features) || [];
    /* сканируем все фичи по приоритету: city лучше, чем county/state */
    for (const k of ['city', 'town', 'village', 'municipality', 'district', 'county', 'state']) {
      for (const f of feats) { const v = (f.properties || {})[k]; if (v) { city = v; break; } }
      if (city) break;
    }
  }
  city = String(city || '').replace(/^городской округ\s+/i, '').trim();
  geoCache.set(key, city);
  return city;
}
async function forwardCity(q) {
  try {
    const j = await nomFetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=ru&q=${encodeURIComponent(q)}`);
    const x = Array.isArray(j) && j[0];
    if (x) return { lat: +x.lat, lng: +x.lon, name: String(x.display_name || q).split(',')[0].trim() };
  } catch (e) {}
  const j = await photonFetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1`);
  const x = j && j.features && j.features[0];
  if (!x) return null;
  const p = x.properties || {};
  return { lat: x.geometry.coordinates[1], lng: x.geometry.coordinates[0], name: p.name || q };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2'
};

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  /* геокодинг: ?lat&lng → город; ?city= → координаты */
  if (u.pathname === '/api/geocode') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const q = (u.searchParams.get('city') || '').slice(0, 80).trim();
    const la = parseFloat(u.searchParams.get('lat')), lo = parseFloat(u.searchParams.get('lng'));
    try {
      if (q) {
        const g = await forwardCity(q);
        res.end(JSON.stringify(g ? { ok: true, city: g.name, lat: g.lat, lng: g.lng } : { ok: false, error: 'not found' }));
      } else if (isFinite(la) && isFinite(lo)) {
        const city = await reverseCity(la, lo);
        res.end(JSON.stringify(city ? { ok: true, city } : { ok: false, error: 'not found' }));
      } else {
        res.end(JSON.stringify({ ok: false, error: 'no params' }));
      }
    } catch (e) {
      console.warn('[/api/geocode]', String(e.message || e));
      res.statusCode = 502; res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  if (u.pathname === '/api/around') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    let city = (u.searchParams.get('city') || '').slice(0, 60).trim();
    const la = parseFloat(u.searchParams.get('lat')), lo = parseFloat(u.searchParams.get('lng'));
    /* авторитетный город — из координат через геокодер, а не из хардкод-списка */
    if (isFinite(la) && isFinite(lo)) {
      try { const g = await reverseCity(la, lo); if (g) city = g; } catch (e) { console.warn('[geocode]', String(e.message || e)); }
    }
    if (!city) { res.end(JSON.stringify({ ok: false, error: 'no city' })); return; }
    if (!KEY) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: 'MOONSHOT_API_KEY is not set' })); return; }
    const ck = city.toLowerCase() + ':' + new Date().toDateString();
    const hit = cache.get(ck);
    if (hit && Date.now() - hit.t < (hit.ttl || CACHE_TTL)) {
      res.end(JSON.stringify({ ok: true, city, events: hit.data, cached: true })); return;
    }
    /* поиск идёт в фоне (2–6 мин), клиент опрашивает — длинных соединений нет,
       прокси/браузер не рвут запрос: каждый отклик мгновенный */
    const job = jobs.get(ck);
    if (job && job.status === 'running') {
      res.end(JSON.stringify({ ok: true, pending: true, city })); return;
    }
    if (job && job.status === 'error' && Date.now() - job.t < 5 * 60 * 1000) {
      res.end(JSON.stringify({ ok: false, error: job.err })); return;
    }
    jobs.set(ck, { t: Date.now(), status: 'running' });
    console.log('[/api/around] ищем:', city);
    (async () => {
      const t0 = Date.now();
      try {
        /* temperature=1 у k2.6 даёт серии пустых ответов: крутим заходы (по 2 параллельных
           поиска), пока не найдём или не выйдет общий дедлайн задачи 8 минут */
        const jobDeadline = Date.now() + 8 * 60 * 1000;
        const seen = new Set();
        let events = [], lastErr = null, attempt = 0;
        while (!events.length && Date.now() < jobDeadline - 60000) {
          attempt++;
          const left = Math.min(300000, jobDeadline - Date.now());
          const [r1, r2] = await Promise.allSettled([askKimi(city, left), askKimi(city, left)]);
          if (r1.status === 'rejected') lastErr = r1.reason;
          if (r2.status === 'rejected') lastErr = r2.reason;
          events = []
            .concat(r1.status === 'fulfilled' ? r1.value : [])
            .concat(r2.status === 'fulfilled' ? r2.value : [])
            .filter(x => !seen.has(x.url) && seen.add(x.url))
            .slice(0, 8);
          if (!events.length) console.log('[/api/around]', city, '— попытка', attempt, 'пустая, осталось', Math.round((jobDeadline - Date.now()) / 1000) + 'с');
        }
        if (!events.length && lastErr && attempt <= 1) throw lastErr;
        /* пустой ответ кэшируем ненадолго — иначе один неудачный поиск глушит город на 12ч */
        cache.set(ck, { t: Date.now(), data: events, ttl: events.length ? CACHE_TTL : 5 * 60 * 1000 });
        jobs.set(ck, { t: Date.now(), status: 'done' });
        console.log('[/api/around]', city, '— найдено:', events.length, '(заходов: ' + attempt + ', ' + Math.round((Date.now() - t0) / 1000) + 'с)');
      } catch (e) {
        console.warn('[/api/around]', city, '—', String(e.message || e)); /* видно в логах Render */
        jobs.set(ck, { t: Date.now(), status: 'error', err: String(e.message || e) });
      }
    })();
    res.end(JSON.stringify({ ok: true, pending: true, city }));
    return;
  }

  /* сбор email для будущей рассылки (пока просто копим в subscribers.csv) */
  if (u.pathname === '/api/subscribe' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(body || '{}'); } catch (e) {}
      const email = String(j.email || '').trim().slice(0, 120);
      const city = String(j.city || '').trim().slice(0, 60);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'bad email' })); return;
      }
      const line = `${new Date().toISOString()};${email};${city}\n`;
      fs.appendFile(path.join(__dirname, 'subscribers.csv'), line, (err) => {
        if (err) console.warn('[/api/subscribe]', String(err));
      });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  /* статика */
  if (u.pathname === '/.env' || u.pathname === '/subscribers.csv' || u.pathname.startsWith('/.')) { res.statusCode = 404; res.end('not found'); return; }
  const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).replace(/^\/+/, '');
  const fp = path.join(__dirname, rel);
  if (!fp.startsWith(__dirname)) { res.statusCode = 403; res.end(); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream');
    res.end(data);
  });
}).listen(PORT, () => console.log('Планета ON server on :' + PORT));
