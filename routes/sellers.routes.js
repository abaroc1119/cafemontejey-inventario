const { Router } = require('express');
const { check } = require('express-validator');

const {
    getSellers,
    getSellerById,
    createSeller,
    updateSeller,
    deleteSeller,
    listActiveSellers,
} = require('../controllers/sellers.controller');

const { validateJWT } = require('../middlewares/validate-jwt');
const { isAdminRole } = require('../middlewares/validate-roles');
const { validateFields } = require('../middlewares/validate-fields');

const router = Router();

router.use(validateJWT);

// Listado ligero para selects (todo usuario autenticado puede consumirlo)
router.get('/active', listActiveSellers);

// Resto de acciones solo admin
router.use(isAdminRole);

router.get('/', getSellers);

router.get('/:id', [
    check('id', 'ID no válido').isNumeric(),
    validateFields,
], getSellerById);

router.post('/', [
    check('full_name', 'El nombre es obligatorio').not().isEmpty(),
    check('commission_rate_default', 'La tasa debe ser un número entre 0 y 100')
        .optional().isFloat({ min: 0, max: 100 }),
    validateFields,
], createSeller);

router.put('/:id', [
    check('id', 'ID no válido').isNumeric(),
    check('commission_rate_default', 'La tasa debe ser un número entre 0 y 100')
        .optional().isFloat({ min: 0, max: 100 }),
    validateFields,
], updateSeller);

router.delete('/:id', [
    check('id', 'ID no válido').isNumeric(),
    validateFields,
], deleteSeller);

module.exports = router;
