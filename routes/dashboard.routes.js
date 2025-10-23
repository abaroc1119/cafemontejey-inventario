// routes/dashboard.routes.js
const { Router } = require('express');
const { getDashboardStats } = require('../controllers/dashboard.controller');
const { validateJWT } = require('../middlewares/validate-jwt');

const router = Router();

// Todas las rutas del dashboard requieren un token válido
router.use(validateJWT);

router.get('/', getDashboardStats);

module.exports = router;