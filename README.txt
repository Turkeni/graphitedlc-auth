GraphiteDLC Auth Server
=======================

1) Установи Node.js 18+
2) В этой папке:
   npm install
   npm start

Сервер: http://localhost:8787

Для интернета (чтобы лаунчер у друзей работал):
- Залей на Railway / Render / Fly.io
- Укажи переменную JWT_SECRET (длинная случайная строка)
- Скопируй выданный URL (например https://xxx.up.railway.app)
- Вставь его в лаунчер: config.js → AUTH_API_URL

API:
  POST /api/register  { "login": "Nick", "password": "secret1" }
  POST /api/login     { "login": "Nick", "password": "secret1" }
  GET  /api/me        Header: Authorization: Bearer <token>
