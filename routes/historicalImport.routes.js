const { Router } = require('express');
const { check } = require('express-validator');

const {
    previewImport,
    executeHistoricalImport,
} = require('../controllers/historicalImport.controller');

const { validateJWT } = require('../middlewares/validate-jwt');
const { isAdminRole } = require('../middlewares/validate-roles');
const { validateFields } = require('../middlewares/validate-fields');

const router = Router();

router.use(validateJWT, isAdminRole);

router.post('/preview', [
    check('rows', 'Se requiere un array de filas').isArray({ min: 1 }),
    validateFields,
], previewImport);

router.post('/execute', [
    check('rows', 'Se requiere un array de filas').isArray({ min: 1 }),
    check('seller_id', 'seller_id es obligatorio').isInt({ gt: 0 }),
    check('confirmText', 'confirmText es obligatorio').not().isEmpty(),
    validateFields,
], executeHistoricalImport);

module.exports = router;
