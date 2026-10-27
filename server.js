/*
 * ZiemnioMine – serwer licznika aktywnych graczy
 * ------------------------------------------------
 * Czysty Node.js, ZERO zależności (nie trzeba npm install).
 *
 * Jak to działa:
 *   - Mod co ~60 sekund wysyła anonimowy "ping" (POST /beat) z losowym ID sesji.
 *   - Serwer zapamiętuje tylko: to ID -> kiedy ostatnio pingowało.
 *   - "Online teraz" = liczba ID, które pingowały w ostatnich ACTIVE_WINDOW ms.
 *   - Zero danych osobowych. Zero IP w pamięci. Zero kontroli nad komputerem gracza.
 *     To nie RAT – to zwykły licznik obecności.
 */

'use strict';

const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

// Gracz liczony jako "online" jeśli pingował w ciągu ostatnich 2.5 minuty.
// Mod pinguje co 60s, więc jest zapas na jeden zgubiony ping.
const ACTIVE_WINDOW = 150 * 1000;

// Po tym czasie sesja znika z pamięci całkowicie.
const FORGET_AFTER = 10 * 60 * 1000;

// Zabezpieczenie: max sesji w pamięci (gdyby ktoś chciał zaspamować).
const MAX_SESSIONS = 200000;

// id (string) -> { last: ms }
const sessions = new Map();

// Proste statystyki
let peakOnline = 0;
let peakAt = 0;
const seenToday = new Set();
let seenTodayDay = currentDay();

function currentDay() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function prune(now) {
  for (const [id, s] of sessions) {
    if (now - s.last > FORGET_AFTER) sessions.delete(id);
  }
}

function countOnline(now) {
  let n = 0;
  for (const s of sessions.values()) {
    if (now - s.last <= ACTIVE_WINDOW) n++;
  }
  return n;
}

function rollDayIfNeeded() {
  const d = currentDay();
  if (d !== seenTodayDay) {
    seenToday.clear();
    seenTodayDay = d;
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, cb) {
  let data = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    data += chunk;
    if (data.length > 4096) { // nikt nie potrzebuje większego pinga
      tooBig = true;
      req.destroy();
    }
  });
  req.on('end', () => cb(tooBig ? null : data));
  req.on('error', () => cb(null));
}

const server = http.createServer((req, res) => {
  const now = Date.now();
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // --- HEARTBEAT: mod zgłasza "jestem online" ---
  if (path === '/beat' && (req.method === 'POST' || req.method === 'GET')) {
    const handle = (id) => {
      rollDayIfNeeded();
      // ID walidujemy: tylko krótki, bezpieczny ciąg. Jak brak/zły -> generujemy
      // efemeryczny (policzy się jako online, ale nie da się nim spamować).
      if (!id || typeof id !== 'string' || id.length < 6 || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
        id = 'anon-' + crypto.randomBytes(8).toString('hex');
      }
      if (!sessions.has(id) && sessions.size >= MAX_SESSIONS) {
        return sendJson(res, 503, { ok: false, reason: 'busy' });
      }
      sessions.set(id, { last: now });
      seenToday.add(id);
      const online = countOnline(now);
      if (online > peakOnline) { peakOnline = online; peakAt = now; }
      sendJson(res, 200, { ok: true, online });
    };

    if (req.method === 'GET') {
      handle(url.searchParams.get('id'));
    } else {
      readBody(req, (raw) => {
        let id = null;
        if (raw) {
          try { id = JSON.parse(raw).id; }
          catch (e) { id = new URLSearchParams(raw).get('id'); }
        }
        handle(id);
      });
    }
    return;
  }

  // --- COUNT: ile osób teraz gra (dla dashboardu / do wklejenia gdziekolwiek) ---
  if (path === '/count') {
    prune(now);
    rollDayIfNeeded();
    return sendJson(res, 200, {
      online: countOnline(now),
      peak_online: peakOnline,
      peak_at: peakAt ? new Date(peakAt).toISOString() : null,
      seen_today: seenToday.size,
      window_seconds: Math.round(ACTIVE_WINDOW / 1000),
      server_time: new Date(now).toISOString(),
    });
  }

  // --- HEALTH: dla Render / uptime ---
  if (path === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  // --- DASHBOARD ---
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(DASHBOARD_HTML);
  }

  sendJson(res, 404, { ok: false, reason: 'not_found' });
});

// Okresowe czyszczenie pamięci
setInterval(() => prune(Date.now()), 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`[ZiemnioMine] Licznik wystartował na porcie ${PORT}`);
  console.log(`[ZiemnioMine] Dashboard:  http://localhost:${PORT}/`);
  console.log(`[ZiemnioMine] Endpoint pinga:  POST /beat  { "id": "<losowe-id>" }`);
});

/* ======================= DASHBOARD (strona www) ======================= */
const DASHBOARD_HTML = `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ZiemnioMine — gracze online</title>
<style>
  :root{
    --bg0:#140a24; --bg1:#1d0f33; --card:#241043cc; --line:#6b2fd655;
    --accent:#b36bff; --accent2:#7c3aed; --text:#f3eaff; --muted:#b9a8d9; --live:#51f0a3;
  }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{
    font-family:"Segoe UI",system-ui,-apple-system,sans-serif;
    color:var(--text);
    background:
      radial-gradient(1100px 600px at 50% -10%, #3a1a6e 0%, transparent 60%),
      linear-gradient(160deg,var(--bg1),var(--bg0));
    min-height:100%;
    display:flex;align-items:center;justify-content:center;
    padding:24px;
  }
  .wrap{width:100%;max-width:560px}
  .brand{display:flex;align-items:center;gap:12px;justify-content:center;margin-bottom:22px}
  .brand .logo{font-size:34px;filter:drop-shadow(0 0 10px #b36bffaa)}
  .brand h1{font-size:20px;letter-spacing:.14em;text-transform:uppercase;margin:0;font-weight:700;
    background:linear-gradient(90deg,#d9b8ff,#9b5cff);-webkit-background-clip:text;background-clip:text;color:transparent}
  .card{
    background:var(--card);
    border:1px solid var(--line);
    border-radius:22px;
    padding:36px 28px;
    text-align:center;
    backdrop-filter:blur(8px);
    box-shadow:0 24px 60px -20px #0009, inset 0 1px 0 #ffffff14;
  }
  .live{display:inline-flex;align-items:center;gap:8px;font-size:12px;letter-spacing:.18em;
    text-transform:uppercase;color:var(--muted);margin-bottom:10px}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--live);box-shadow:0 0 0 0 #51f0a3aa;
    animation:pulse 1.8s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 #51f0a380}70%{box-shadow:0 0 0 10px #51f0a300}100%{box-shadow:0 0 0 0 #51f0a300}}
  .big{font-size:88px;line-height:1;font-weight:800;margin:6px 0 2px;
    background:linear-gradient(180deg,#ffffff,#c39bff);-webkit-background-clip:text;background-clip:text;color:transparent;
    text-shadow:0 0 40px #b36bff33}
  .big.flash{animation:flash .5s}
  @keyframes flash{0%{transform:scale(1)}40%{transform:scale(1.08)}100%{transform:scale(1)}}
  .sub{color:var(--muted);font-size:15px;margin-bottom:26px}
  .stats{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
  .stat{flex:1;min-width:120px;background:#ffffff0a;border:1px solid #ffffff12;border-radius:14px;padding:14px 10px}
  .stat .v{font-size:26px;font-weight:700}
  .stat .l{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-top:4px}
  .foot{margin-top:22px;text-align:center;color:#8f7db8;font-size:12px}
  .err{color:#ff8a8a}
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand"><span class="logo">🥔</span><h1>ZiemnioMine</h1></div>
    <div class="card">
      <div class="live"><span class="dot"></span> na żywo</div>
      <div id="big" class="big">—</div>
      <div class="sub" id="sub">graczy teraz gra z modem</div>
      <div class="stats">
        <div class="stat"><div class="v" id="peak">—</div><div class="l">rekord online</div></div>
        <div class="stat"><div class="v" id="today">—</div><div class="l">dziś łącznie</div></div>
      </div>
    </div>
    <div class="foot" id="foot">Aktualizacja co 5 s · anonimowy licznik obecności</div>
  </div>
<script>
  var prev = null;
  function fmt(n){ return (n==null?'—':String(n)); }
  async function tick(){
    try{
      var r = await fetch('/count', {cache:'no-store'});
      var d = await r.json();
      var big = document.getElementById('big');
      big.textContent = fmt(d.online);
      if(prev!==null && d.online!==prev){ big.classList.remove('flash'); void big.offsetWidth; big.classList.add('flash'); }
      prev = d.online;
      document.getElementById('sub').textContent =
        d.online===1 ? 'gracz teraz gra z modem' : 'graczy teraz gra z modem';
      document.getElementById('peak').textContent = fmt(d.peak_online);
      document.getElementById('today').textContent = fmt(d.seen_today);
      document.getElementById('foot').textContent =
        'Online = pingi z ostatnich ' + Math.round((d.window_seconds||150)/60) + ' min · aktualizacja co 5 s';
    }catch(e){
      document.getElementById('sub').innerHTML = '<span class="err">brak połączenia z serwerem…</span>';
    }
  }
  tick();
  setInterval(tick, 5000);
</script>
</body>
</html>`;
