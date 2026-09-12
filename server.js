/**
 * GraphiteDLC Auth Server — регистрация / вход + группы
 * Группы: Игрок (по умолчанию), Создатель (через CREATOR_LOGINS или вручную в users.json)
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORT = Number(process.env.PORT) || 8787;
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_GRAPHITEDLC_SECRET_KEY_2026';
const CREATOR_LOGINS = String(process.env.CREATOR_LOGINS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
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
  if (CREATOR_LOGINS.includes(String(login).toLowerCase())) return 'Создатель';
  if (existingGroup === 'Создатель') return 'Создатель';
  return existingGroup || 'Игрок';
}

function publicUser(u) {
  return {
    id: u.id,
    login: u.login,
    group: resolveGroup(u.login, u.group),
    createdAt: u.createdAt
  };
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'GraphiteDLC Auth', version: '1.1.0' });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

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
    const group = resolveGroup(login, 'Игрок');
    const user = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      login,
      passwordHash,
      group,
      createdAt: new Date().toISOString()
    };
    users.push(user);
    saveUsers(users);

    const token = jwt.sign({ sub: user.id, login: user.login }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ ok: true, token, user: publicUser(user) });
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

    // обновить группу, если логин в CREATOR_LOGINS
    const group = resolveGroup(user.login, user.group);
    if (user.group !== group) {
      user.group = group;
      saveUsers(users);
    }

    const token = jwt.sign({ sub: user.id, login: user.login }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ ok: true, token, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Ошибка сервера' });
  }
});

app.get('/api/me', (req, res) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ ok: false, error: 'Нет токена' });

    const payload = jwt.verify(token, JWT_SECRET);
    const users = loadUsers();
    const user = users.find(u => u.id === payload.sub);
    if (!user) return res.status(401).json({ ok: false, error: 'Пользователь не найден' });

    return res.json({ ok: true, user: publicUser(user) });
  } catch {
    return res.status(401).json({ ok: false, error: 'Сессия истекла, войдите снова' });
  }
});

app.listen(PORT, () => {
  console.log(`GraphiteDLC Auth listening on http://localhost:${PORT}`);
  if (CREATOR_LOGINS.length) {
    console.log('Creator logins:', CREATOR_LOGINS.join(', '));
  } else {
    console.log('Creator logins: (none via env) — set group manually in data/users.json or use CREATOR_LOGINS');
  }
});
