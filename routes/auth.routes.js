const { Router } = require('express');
const { check } = require('express-validator');
const { login, renewToken, forgotPassword, resetPassword } = require('../controllers/auth.controller');
const { validateFields } = require('../middlewares/validate-fields');
const { validateJWT } = require('../middlewares/validate-jwt');

const router = Router();
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`])[A-Za-z\d!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]{8,}$/;

router.post('/login', [ /* ... */ ], login);
router.get('/renew', validateJWT, renewToken);

// --- NUEVAS RUTAS ---
router.post('/forgot-password', [
    check('email', 'Por favor, ingresa un correo válido.').isEmail(),
    validateFields
], forgotPassword);

router.post('/reset-password/:token', [
    check('password').matches(passwordRegex).withMessage('La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula, un número y un caracter especial.'),
    validateFields
], resetPassword);

module.exports = router;