// server.js — агент управления Minecraft-серверами (Velocity + Lobby + AoC + Test)
// Запускать ЛОКАЛЬНО, на той же машине, где лежат папки серверов.
// Node.js 18+

const express = require('express');
const cookieParser = require('cookie-parser');
const { spawn, exec } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

// ====================== НАСТРОЙКИ ======================
// Поменяй под себя. ADMIN_PASSWORD лучше задавать через переменную окружения,
// а не хранить в файле, если будешь коммитить проект куда-либо.
const ADMIN_PASSWORD = process.env.PANEL_PASSWORD || 'LpC?vzY<4ldNH';
const PORT = process.env.PANEL_PORT || 3000;

// Порядок в этом объекте = порядок запуска в "Запустить всё"
const SERVERS = {
  playit: {
    title: 'Playit.gg',
    cwd: 'C:\\Program Files\\playit_gg\\bin',
    cmd: 'Playit.exe',
    args: [],
    stopCommand: null, // GUI-процесс, мягко не остановить — только kill
    tab: false // не показываем как отдельную вкладку-консоль в UI (нет удобного вывода)
  },
  velocity: {
    title: 'Velocity',
    cwd: '../Velocity-Proxy',
    cmd: 'start.bat',
    args: [],
    stopCommand: 'end',
    tab: false
  },
  lobby: {
    title: 'Лобби',
    cwd: '../Lobby-server',
    cmd: 'run.bat',
    args: [],
    stopCommand: 'stop',
    tab: true
  },
  aoc: {
    title: 'AoC',
    cwd: '../AoC-server',
    cmd: 'run.bat',
    args: [],
    stopCommand: 'stop',
    tab: true
  },
  test: {
    title: 'Тест',
    cwd: '../Test-server',
    cmd: 'run.bat',
    args: [],
    stopCommand: 'stop',
    tab: true
  }
};

const START_DELAY_MS = { playit: 3000, velocity: 10000, lobby: 5000, aoc: 5000, test: 0 };

// ====================== ПРОЦЕСС-МЕНЕДЖЕР ======================
const procs = {}; // id -> { child, buffer: [], sockets: Set, starting: bool }

function ensureState(id) {
  if (!procs[id]) procs[id] = { child: null, buffer: [], sockets: new Set(), starting: false };
  return procs[id];
}

function pushLine(id, line) {
  const st = ensureState(id);
  st.buffer.push(line);
  if (st.buffer.length > 1000) st.buffer.shift();
  for (const ws of st.sockets) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'line', line }));
  }
}

function broadcastStatus(id) {
  const st = ensureState(id);
  const running = !!st.child;
  for (const ws of st.sockets) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'status', running }));
  }
}

function startServer(id) {
  const cfg = SERVERS[id];
  if (!cfg) throw new Error('unknown server: ' + id);
  const st = ensureState(id);
  if (st.child) {
    pushLine(id, '[panel] уже запущен');
    return;
  }
  const resolvedCwd = path.resolve(cfg.cwd);
  pushLine(id, `[panel] запуск: ${cfg.cmd} (в ${resolvedCwd})`);

  if (!fs.existsSync(resolvedCwd)) {
    pushLine(id, `[panel] ошибка запуска: папка не найдена: ${resolvedCwd}`);
    return;
  }
  if (!fs.existsSync(path.join(resolvedCwd, cfg.cmd))) {
    pushLine(id, `[panel] ошибка запуска: файл не найден: ${path.join(resolvedCwd, cfg.cmd)}`);
    return;
  }

  const child = spawn(cfg.cmd, cfg.args, {
    cwd: resolvedCwd,
    shell: true,        // выполняем .bat напрямую, БЕЗ "start", чтобы не открывалось новое окно
    windowsHide: true    // прячем побочное консольное окно на Windows
  });
  st.child = child;
  broadcastStatus(id);

  child.stdout.on('data', (d) => d.toString('utf8').split(/\r?\n/).forEach(l => l && pushLine(id, l)));
  child.stderr.on('data', (d) => d.toString('utf8').split(/\r?\n/).forEach(l => l && pushLine(id, '[stderr] ' + l)));

  child.on('exit', (code) => {
    pushLine(id, `[panel] процесс завершён (код ${code})`);
    st.child = null;
    broadcastStatus(id);
  });

  child.on('error', (err) => {
    pushLine(id, `[panel] ошибка запуска: ${err.message}`);
    st.child = null;
    broadcastStatus(id);
  });
}

function killTree(id, pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec(`taskkill /pid ${pid} /T /F`, (err) => {
        if (err) pushLine(id, `[panel] taskkill: ${err.message}`);
        resolve();
      });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch (_) {}
      resolve();
    }
  });
}

function stopServer(id) {
  const cfg = SERVERS[id];
  const st = ensureState(id);
  if (!st.child) {
    pushLine(id, '[panel] уже остановлен');
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const child = st.child;
    const pid = child.pid;
    const timeout = setTimeout(() => {
      pushLine(id, '[panel] не ответил на команду остановки, kill дерева процессов');
      killTree(id, pid);
    }, 20000);

    child.once('exit', () => { clearTimeout(timeout); resolve(); });

    if (cfg.stopCommand && child.stdin.writable) {
      pushLine(id, `[panel] отправляю "${cfg.stopCommand}" в консоль`);
      child.stdin.write(cfg.stopCommand + '\n');
    } else {
      pushLine(id, '[panel] мягкой остановки нет — kill дерева процессов');
      killTree(id, pid);
    }
  });
}

async function restartServer(id) {
  await stopServer(id);
  await new Promise(r => setTimeout(r, 1500));
  startServer(id);
}

async function startAll() {
  for (const id of Object.keys(SERVERS)) {
    startServer(id);
    await new Promise(r => setTimeout(r, START_DELAY_MS[id] || 0));
  }
}

async function stopAll() {
  // гасим в обратном порядке
  const ids = Object.keys(SERVERS).reverse();
  for (const id of ids) await stopServer(id);
}

function sendInput(id, line) {
  const st = ensureState(id);
  if (st.child && st.child.stdin.writable) {
    st.child.stdin.write(line + '\n');
    pushLine(id, '> ' + line);
  }
}

// ====================== АВТОРИЗАЦИЯ (простая, по паролю) ======================
const sessions = new Set(); // токены активных сессий, в памяти

function requireAuth(req, res, next) {
  const token = req.cookies.session;
  if (token && sessions.has(token)) return next();
  res.status(401).json({ error: 'auth required' });
}

// ====================== HTTP / API ======================
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'wrong password' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.add(token);
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
  res.json({ ok: true });
});

app.post('/api/logout', requireAuth, (req, res) => {
  sessions.delete(req.cookies.session);
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/status', requireAuth, (req, res) => {
  const out = {};
  for (const id of Object.keys(SERVERS)) {
    out[id] = { title: SERVERS[id].title, tab: SERVERS[id].tab, running: !!ensureState(id).child };
  }
  res.json(out);
});

app.get('/api/server/:id/history', requireAuth, (req, res) => {
  const st = ensureState(req.params.id);
  res.json({ lines: st.buffer });
});

app.post('/api/server/:id/start', requireAuth, (req, res) => {
  try { startServer(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/server/:id/stop', requireAuth, async (req, res) => {
  try { await stopServer(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/server/:id/restart', requireAuth, async (req, res) => {
  try { await restartServer(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/all/start', requireAuth, async (req, res) => { startAll(); res.json({ ok: true }); });
app.post('/api/all/stop', requireAuth, async (req, res) => { await stopAll(); res.json({ ok: true }); });
app.post('/api/all/restart', requireAuth, async (req, res) => { await stopAll(); startAll(); res.json({ ok: true }); });

// ====================== WEBSOCKET (консоль в реальном времени) ======================
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return match ? decodeURIComponent(match.split('=')[1]) : null;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const id = url.searchParams.get('server');
  const token = readCookie(req, 'session');
  if (!token || !sessions.has(token) || !SERVERS[id]) {
    ws.close(1008, 'unauthorized');
    return;
  }
  const st = ensureState(id);
  st.sockets.add(ws);
  ws.send(JSON.stringify({ type: 'history', lines: st.buffer }));
  ws.send(JSON.stringify({ type: 'status', running: !!st.child }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'input' && typeof msg.line === 'string') sendInput(id, msg.line);
    } catch (_) {}
  });

  ws.on('close', () => st.sockets.delete(ws));
});

server.listen(PORT, () => {
  console.log(`Панель запущена: http://localhost:${PORT}`);
  console.log(`Пароль: ${ADMIN_PASSWORD === 'change-me-please' ? '⚠️ ДЕФОЛТНЫЙ, СМЕНИ через переменную окружения PANEL_PASSWORD!' : '(задан через env)'}`);
});
