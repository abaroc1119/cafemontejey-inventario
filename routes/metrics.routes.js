const { Router } = require('express');
const { getMetrics } = require('../controllers/metrics.controller');
const { validateJWT } = require('../middlewares/validate-jwt');
const { isAdminRole } = require('../middlewares/validate-roles');

const router = Router();

// Esta ruta solo debe ser accesible para administradores
router.use(validateJWT, isAdminRole);

router.get('/', getMetrics);

module.exports = router;