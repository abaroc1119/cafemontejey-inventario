const { Router } = require('express');
const { check } = require('express-validator');
const { login, renewToken, forgotPassword, resetPassword } = require('../controllers/auth.controller');
const { validateFields } = require('../middlewares/validate-fields');
const { validateJWT } = require('../middlewares/validate-jwt');
const rateLimit = require('express-rate-limit');

// 10 intentos por IP cada 15 minutos en login y recuperación de contraseña.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { msg: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' }
});

const router = Router();
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`])[A-Za-z\d!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]{8,}$/;

router.post('/login', [
    authLimiter,
    check('email', 'Por favor, ingresa un correo válido.').isEmail(),
    check('password', 'La contraseña es obligatoria.').isString().notEmpty(),
    validateFields
], login);
router.get('/renew', validateJWT, renewToken);

// --- NUEVAS RUTAS ---
router.post('/forgot-password', [
    authLimiter,
    check('email', 'Por favor, ingresa un correo válido.').isEmail(),
    validateFields
], forgotPassword);

router.post('/reset-password/:token', [
    authLimiter,
    check('password').matches(passwordRegex).withMessage('La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula, un número y un caracter especial.'),
    validateFields
], resetPassword);

module.exports = router;