/**
 * Назначить группу «Создатель»
 * Использование: node set-creator.js turkeni
 */
const fs = require('fs');
const path = require('path');

const login = String(process.argv[2] || '').trim();
if (!login) {
  console.error('Укажи логин: node set-creator.js turkeni');
  process.exit(1);
}

const file = path.join(__dirname, 'data', 'users.json');
if (!fs.existsSync(file)) {
  console.error('Файл не найден:', file);
  console.error('Сначала зарегистрируйся в лаунчере и останови сервер.');
  process.exit(1);
}

const users = JSON.parse(fs.readFileSync(file, 'utf8'));
const user = users.find(u => u.login.toLowerCase() === login.toLowerCase());
if (!user) {
  console.error('Пользователь не найден:', login);
  console.error('Есть логины:', users.map(u => u.login).join(', ') || '(пусто)');
  process.exit(1);
}

user.group = 'Создатель';
fs.writeFileSync(file, JSON.stringify(users, null, 2), 'utf8');
console.log('OK:', user.login, '→ группа Создатель');
console.log('Перезапусти сервер (npm start) и перезайди в лаунчер.');
