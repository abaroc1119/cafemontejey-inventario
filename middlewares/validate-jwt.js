// /middlewares/validate-jwt.js
const jwt = require('jsonwebtoken');
const pool = require('../db/database');

/**
 * Valida el JWT y, además, confirma contra la base de datos que el usuario
 * siga activo y toma su rol ACTUAL (no el que traía el token). Así, desactivar
 * a un usuario o cambiarle el rol surte efecto en la siguiente petición, sin
 * esperar a que el token expire.
 */
const validateJWT = async (req, res, next) => {
    const token = req.header('x-token');
    if (!token) {
        return res.status(401).json({ msg: 'No hay token en la petición' });
    }

    let payload;
    try {
        payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
        return res.status(401).json({ msg: 'Token no válido' });
    }

    try {
        const [rows] = await pool.query(
            `SELECT u.id, u.full_name, u.is_active, r.name AS role_name
             FROM users u JOIN roles r ON u.role_id = r.id
             WHERE u.id = ?`,
            [payload.uid]
        );
        const user = rows[0];
        if (!user || !user.is_active) {
            return res.status(401).json({ msg: 'Usuario inexistente o desactivado' });
        }

        req.uid = user.id;
        req.name = user.full_name;
        req.role = user.role_name;
        next();
    } catch (error) {
        console.error('Error validando sesión:', error);
        return res.status(500).json({ msg: 'Error interno del servidor' });
    }
};

module.exports = { validateJWT };
