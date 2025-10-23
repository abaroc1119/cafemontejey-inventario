const { Router } = require('express');
const { getLogs } = require('../controllers/logs.controller');
const { validateJWT } = require('../middlewares/validate-jwt');
const { isAdminRole } = require('../middlewares/validate-roles');

const router = Router();

// Esta ruta solo debe ser accesible para administradores autenticados
router.use(validateJWT, isAdminRole);

router.get('/', getLogs);

module.exports = router;