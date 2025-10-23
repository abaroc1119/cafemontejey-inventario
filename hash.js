// hash.js
const bcrypt = require('bcryptjs');

const password = 'user123';
const salt = bcrypt.genSaltSync(10);
const hash = bcrypt.hashSync(password, salt);

console.log('============================================================');
console.log('Tu nuevo hash para la contraseña "admin123" es:');
console.log(hash);
console.log('============================================================');