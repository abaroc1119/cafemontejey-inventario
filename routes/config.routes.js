const { Router } = require('express');
const { getIvaRate } = require('../controllers/config.controller');
const { validateJWT } = require('../middlewares/validate-jwt');

const router = Router();

// Todas las rutas de configuración requieren que el usuario esté autenticado.
router.use(validateJWT);

// Endpoint para obtener la tasa de IVA actual.
// GET /api/config/iva
router.get('/iva', getIvaRate);

module.exports = router;