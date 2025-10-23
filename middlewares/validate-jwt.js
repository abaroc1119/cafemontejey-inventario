// /middlewares/validate-jwt.js
const jwt = require('jsonwebtoken');

const validateJWT = (req, res, next) => {
    const token = req.header('x-token');
    if (!token) {
        return res.status(401).json({ msg: 'No hay token en la petición' });
    }

    try {
        const { uid, name, role } = jwt.verify(token, process.env.JWT_SECRET);
        req.uid = uid;
        req.name = name;
        req.role = role;
        next();
    } catch (error) {
        return res.status(401).json({ msg: 'Token no válido' });
    }
};

module.exports = { validateJWT };