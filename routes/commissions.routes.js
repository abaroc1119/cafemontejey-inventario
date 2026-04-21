const { Router } = require('express');
const { check } = require('express-validator');

const {
    getCommissions,
    getCommissionsSummaryBySeller,
    createCommission,
    updateCommission,
    markCommissionsPaid,
    cancelCommission,
} = require('../controllers/commissions.controller');

const { validateJWT } = require('../middlewares/validate-jwt');
const { isAdminRole } = require('../middlewares/validate-roles');
const { validateFields } = require('../middlewares/validate-fields');

const router = Router();

router.use(validateJWT, isAdminRole);

router.get('/', getCommissions);

router.get('/summary/by-seller', getCommissionsSummaryBySeller);

router.post('/', [
    check('seller_id', 'El vendedor es obligatorio').isInt({ gt: 0 }),
    check('entry_date', 'Fecha de movimiento requerida').isISO8601(),
    validateFields,
], createCommission);

router.put('/:id', [
    check('id', 'ID no válido').isNumeric(),
    validateFields,
], updateCommission);

router.post('/mark-paid', [
    check('ids', 'Se requiere un arreglo de IDs').isArray({ min: 1 }),
    validateFields,
], markCommissionsPaid);

router.post('/:id/cancel', [
    check('id', 'ID no válido').isNumeric(),
    validateFields,
], cancelCommission);

module.exports = router;
