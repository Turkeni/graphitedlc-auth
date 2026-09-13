/**
 * GraphiteDLC Auth Server
 * Роли + аватары на сервере
 *
 * Env: JWT_SECRET, CREATOR_LOGINS, STAZHER_LOGINS, BETA_LOGINS
 *      PUBLIC_URL — публичный URL сервера (для абсолютных ссылок на аватар), напр. https://xxx.up.railway.app
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

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');

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
});
