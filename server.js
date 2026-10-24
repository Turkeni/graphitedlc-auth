/**
 * GraphiteDLC Auth Server
 * Роли + аватары на сервере
 *
 * Env: JWT_SECRET, CREATOR_LOGINS, STAZHER_LOGINS, BETA_LOGINS
 *      PUBLIC_URL — публичный URL сервера (для абсолютных ссылок на аватар)
 *      DONATEPAY_API_KEY — секретный ключ DonatePay, только на Railway
 *      DONATEPAY_URL — ссылка на вашу страницу оплаты DonatePay
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORT = Number(process.env.PORT) || 8787;
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_GRAPHITEDLC_SECRET_KEY_2026';
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/$/, '');
const DONATEPAY_API_KEY = String(process.env.DONATEPAY_API_KEY || '').trim();
const DONATEPAY_URL = String(process.env.DONATEPAY_URL || '').trim();
const BETA_PRICE = 99;
const ORDER_TTL_MS = 24 * 60 * 60 * 1000;
const DONATEPAY_API_BASE = 'https://donatepay.ru/api/v2';

function parseList(envVal) {
  return String(envVal || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

const CREATOR_LOGINS = parseList(process.env.CREATOR_LOGINS);
const STAZHER_LOGINS = parseList(process.env.STAZHER_LOGINS);
const BETA_LOGINS = parseList(process.env.BETA_LOGINS);

const DATA_DIR = path.join(__dirname, 'data');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]', 'utf8');

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function loadOrders() {
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch { return []; }
}

function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');
}

function makeOrderCode() {
  return 'GDLC-' + Math.random().toString(36).slice(2, 8).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function findValuesDeep(value, keys = [], out = {}) {
  if (!value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    const key = String(k).toLowerCase();
    if (['id', 'amount', 'sum', 'value', 'message', 'text', 'comment', 'donation', 'donate'].includes(key)) {
      if (out[key] === undefined) out[key] = v;
    }
    if (v && typeof v === 'object') findValuesDeep(v, keys.concat(k), out);
  }
  return out;
}

function transactionList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['data', 'transactions', 'items', 'results']) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload[key] && typeof payload[key] === 'object') {
      const nested = transactionList(payload[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function normalizeAmount(v) {
  if (typeof v === 'number') return v;
  const n = Number(String(v ?? '').replace(',', '.').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

function transactionInfo(tx) {
  const x = findValuesDeep(tx);
  const amountCandidates = [x.amount, x.sum, x.value];
  const messageCandidates = [x.message, x.text, x.comment];
  const amount = amountCandidates.map(normalizeAmount).find(Number.isFinite);
  const message = messageCandidates.find(v => typeof v === 'string') || '';
  const id = x.id != null ? String(x.id) : JSON.stringify(tx);
  return { id, amount, message, raw: tx };
}

async function donatePayTransactions() {
  if (!DONATEPAY_API_KEY) throw new Error('Не задан DONATEPAY_API_KEY');
  const url = new URL(DONATEPAY_API_BASE + '/transactions');
  url.searchParams.set('access_token', DONATEPAY_API_KEY);
  const response = await fetch(url, {
    headers: { Authorization: 'Bearer ' + DONATEPAY_API_KEY, Accept: 'application/json' }
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('DonatePay вернул не JSON: HTTP ' + response.status); }
  if (!response.ok) throw new Error('DonatePay HTTP ' + response.status + ': ' + JSON.stringify(payload).slice(0, 500));
  return transactionList(payload);
}

function publicOrder(order) {
  return { id: order.id, code: order.code, amount: order.amount, status: order.status, createdAt: order.createdAt, paidAt: order.paidAt || null, donatePayUrl: DONATEPAY_URL || null };
}

async function tryCompleteOrders() {
  const orders = loadOrders();
  const now = Date.now();
  let changed = false;
  for (const order of orders) {
    if (order.status !== 'pending') continue;
    if (now - new Date(order.createdAt).getTime() > ORDER_TTL_MS) { order.status = 'expired'; changed = true; continue; }
    try {
      const txs = await donatePayTransactions();
      for (const tx of txs.map(transactionInfo)) {
        if (tx.amount !== BETA_PRICE) continue;
        if (!tx.message.toUpperCase().includes(order.code.toUpperCase())) continue;
        if (order.transactionId && order.transactionId === tx.id) continue;
        const users = loadUsers();
        const user = users.find(u => u.id === order.userId);
        if (!user) { order.status = 'error'; changed = true; break; }
        user.group = resolveGroup(user.login, 'Бета тестер');
        if (user.group !== 'Бета тестер' && !BETA_LOGINS.includes(String(user.login).toLowerCase())) user.group = 'Бета тестер';
        order.status = 'paid';
        order.transactionId = tx.id;
        order.paidAt = new Date().toISOString();
        saveUsers(users);
        changed = true;
        break;
      }
    } catch (err) {
      console.error('DonatePay check failed:', err.message);
    }
  }
  if (changed) saveOrders(orders);
  return orders;
}

function isValidLogin(login) {
  return typeof login === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(login);
}

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 6 && password.length <= 64;
}

function resolveGroup(login, existingGroup) {
  const key = String(login).toLowerCase();
  if (CREATOR_LOGINS.includes(key)) return 'Создатель';
  if (STAZHER_LOGINS.includes(key)) return 'Стажер';
  if (BETA_LOGINS.includes(key)) return 'Бета тестер';
  if (['Создатель', 'Стажер', 'Бета тестер', 'Игрок'].includes(existingGroup)) {
    return existingGroup;
  }
  return 'Игрок';
}

function avatarUrlFor(user, req) {
  if (!user || !user.avatarFile) return null;
  const rel = '/avatars/' + user.avatarFile;
  if (PUBLIC_URL) return PUBLIC_URL + rel;
  if (req) {
    const host = req.get('x-forwarded-host') || req.get('host');
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
    if (host) return `${proto}://${host}${rel}`;
  }
  return rel;
}

function publicUser(u, req) {
  return {
    id: u.id,
    login: u.login,
    group: resolveGroup(u.login, u.group),
    avatarUrl: avatarUrlFor(u, req),
    createdAt: u.createdAt
  };
}

function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ ok: false, error: 'Нет токена' });
    const payload = jwt.verify(token, JWT_SECRET);
    const users = loadUsers();
    const user = users.find(u => u.id === payload.sub);
    if (!user) return res.status(401).json({ ok: false, error: 'Пользователь не найден' });
    req.user = user;
    req.users = users;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Сессия истекла, войдите снова' });
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/avatars', express.static(AVATAR_DIR, { maxAge: '7d' }));

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'GraphiteDLC Auth', version: '1.4.0' });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/register', async (req, res) => {
  try {
    const login = String(req.body?.login || '').trim();
    const password = String(req.body?.password || '');

    if (!isValidLogin(login)) {
      return res.status(400).json({ ok: false, error: 'Логин: 3–16 символов (латиница, цифры, _)' });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ ok: false, error: 'Пароль: минимум 6 символов' });
    }

    const users = loadUsers();
    if (users.some(u => u.login.toLowerCase() === login.toLowerCase())) {
      return res.status(409).json({ ok: false, error: 'Такой логин уже занят' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      login,
      passwordHash,
      group: resolveGroup(login, 'Игрок'),
      avatarFile: null,
      createdAt: new Date().toISOString()
    };
    users.push(user);
    saveUsers(users);

    const token = jwt.sign({ sub: user.id, login: user.login }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ ok: true, token, user: publicUser(user, req) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const login = String(req.body?.login || '').trim();
    const password = String(req.body?.password || '');

    if (!login || !password) {
      return res.status(400).json({ ok: false, error: 'Введите логин и пароль' });
    }

    const users = loadUsers();
    const user = users.find(u => u.login.toLowerCase() === login.toLowerCase());
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Неверный логин или пароль' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({ ok: false, error: 'Неверный логин или пароль' });
    }

    const group = resolveGroup(user.login, user.group);
    if (user.group !== group) {
      user.group = group;
      saveUsers(users);
    }

    const token = jwt.sign({ sub: user.id, login: user.login }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ ok: true, token, user: publicUser(user, req) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

app.get('/api/me', authMiddleware, (req, res) => {
  return res.json({ ok: true, user: publicUser(req.user, req) });
});

app.post('/api/orders', authMiddleware, (req, res) => {
  try {
    if (!DONATEPAY_URL) return res.status(503).json({ ok: false, error: 'На сервере не задан DONATEPAY_URL' });
    const orders = loadOrders();
    const existing = orders.find(o => o.userId === req.user.id && o.status === 'pending' && Date.now() - new Date(o.createdAt).getTime() < ORDER_TTL_MS);
    if (existing) return res.json({ ok: true, order: publicOrder(existing) });
    const order = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), userId: req.user.id, login: req.user.login, code: makeOrderCode(), amount: BETA_PRICE, status: 'pending', createdAt: new Date().toISOString(), transactionId: null, paidAt: null };
    orders.push(order);
    saveOrders(orders);
    return res.json({ ok: true, order: publicOrder(order) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Не удалось создать заказ' });
  }
});

app.get('/api/orders/:id', authMiddleware, async (req, res) => {
  try {
    await tryCompleteOrders();
    const orders = loadOrders();
    const order = orders.find(o => o.id === req.params.id && o.userId === req.user.id);
    if (!order) return res.status(404).json({ ok: false, error: 'Заказ не найден' });
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id) || req.user;
    return res.json({ ok: true, order: publicOrder(order), user: publicUser(user, req) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Не удалось проверить оплату' });
  }
});


/**
 * Загрузка аватара (base64 data URL)
 * POST /api/avatar  Authorization: Bearer <token>
 * body: { image: "data:image/png;base64,...." }
 */
app.post('/api/avatar', authMiddleware, (req, res) => {
  try {
    const image = String(req.body?.image || '');
    const match = image.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/i);
    if (!match) {
      return res.status(400).json({ ok: false, error: 'Нужна картинка в формате data URL (png/jpg/webp)' });
    }

    const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
    const buf = Buffer.from(match[2], 'base64');
    if (buf.length > 1.5 * 1024 * 1024) {
      return res.status(400).json({ ok: false, error: 'Максимум 1.5 МБ' });
    }
    if (buf.length < 100) {
      return res.status(400).json({ ok: false, error: 'Файл слишком маленький' });
    }

    // удалить старый файл
    if (req.user.avatarFile) {
      const oldPath = path.join(AVATAR_DIR, req.user.avatarFile);
      try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch (_) {}
    }

    const fileName = `${req.user.id}.${ext}`;
    fs.writeFileSync(path.join(AVATAR_DIR, fileName), buf);

    const users = req.users;
    const u = users.find(x => x.id === req.user.id);
    if (u) {
      u.avatarFile = fileName;
      saveUsers(users);
      req.user = u;
    }

    return res.json({ ok: true, user: publicUser(req.user, req) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Не удалось сохранить аватар' });
  }
});

/** Удалить аватар */
app.delete('/api/avatar', authMiddleware, (req, res) => {
  try {
    if (req.user.avatarFile) {
      const oldPath = path.join(AVATAR_DIR, req.user.avatarFile);
      try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch (_) {}
    }
    const users = req.users;
    const u = users.find(x => x.id === req.user.id);
    if (u) {
      u.avatarFile = null;
      saveUsers(users);
      req.user = u;
    }
    return res.json({ ok: true, user: publicUser(req.user, req) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

app.listen(PORT, () => {
  console.log(`GraphiteDLC Auth listening on port ${PORT}`);
  console.log('Creators:', CREATOR_LOGINS.join(', ') || '(none)');
  console.log('Stazhery:', STAZHER_LOGINS.join(', ') || '(none)');
  console.log('Beta:', BETA_LOGINS.join(', ') || '(none)');
  console.log('DonatePay:', DONATEPAY_API_KEY ? 'API key set' : 'API key NOT set', DONATEPAY_URL ? 'payment URL set' : 'payment URL NOT set');
});
