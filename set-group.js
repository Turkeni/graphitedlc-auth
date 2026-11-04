/**
 * node set-group.js <логин> <Игрок|Бета тестер|Стажер|Создатель|TikTok|YouTube>
 * Пример: node set-group.js nick TikTok
 */
const fs = require('fs');
const path = require('path');

const login = String(process.argv[2] || '').trim();
const group = String(process.argv[3] || '').trim();
const allowed = ['Игрок', 'Бета тестер', 'Стажер', 'Создатель', 'TikTok', 'YouTube'];

if (!login || !allowed.includes(group)) {
  console.error('Использование: node set-group.js <логин> <' + allowed.join('|') + '>');
  process.exit(1);
}

const file = path.join(__dirname, 'data', 'users.json');
if (!fs.existsSync(file)) {
  console.error('Файл не найден:', file);
  process.exit(1);
}

const users = JSON.parse(fs.readFileSync(file, 'utf8'));
const user = users.find(u => u.login.toLowerCase() === login.toLowerCase());
if (!user) {
  console.error('Пользователь не найден:', login);
  console.error('Есть:', users.map(u => u.login).join(', ') || '(пусто)');
  process.exit(1);
}

user.group = group;
fs.writeFileSync(file, JSON.stringify(users, null, 2), 'utf8');
console.log('OK:', user.login, '→', group);
