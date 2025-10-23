const jwt = require('jsonwebtoken');
require('dotenv').config();

const generateJWT = (uid, name, role) => {
    return new Promise((resolve, reject) => {
        const payload = { uid, name, role };
        jwt.sign(payload, process.env.JWT_SECRET, {
            expiresIn: '8h'
        }, (err, token) => {
            if (err) {
                console.log(err);
                reject('No se pudo generar el token');
            } else {
                resolve(token);
            }
        });
    });
};

module.exports = {
    generateJWT
};