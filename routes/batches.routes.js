const { Router } = require('express');
const { check } = require('express-validator');

const {
    getBatchesByProduct,
    getAllBatches,
    createBatch,
    updateBatch,
    deleteBatch,
    bulkImportBatches
} = require('../controllers/batches.controller');

const { validateJWT } = require('../middlewares/validate-jwt');
const { isAdminRole } = require('../middlewares/validate-roles');
const { validateFields } = require('../middlewares/validate-fields');

const router = Router();

router.use(validateJWT);

// Cualquier usuario autenticado puede consultar lotes (necesario para ventas)
router.get('/', getAllBatches);

router.get('/product/:productId', [
    check('productId', 'El ID del producto debe ser un número').isNumeric(),
    validateFields
], getBatchesByProduct);

// Solo admins pueden crear, editar y eliminar lotes
router.post('/', [
    isAdminRole,
    check('product_id', 'El ID del producto es obligatorio').isInt(),
    check('cost_per_unit', 'El costo por unidad es obligatorio y debe ser un número >= 0').isFloat({ min: 0 }),
    check('quantity', 'La cantidad debe ser un entero mayor a 0').isInt({ gt: 0 }),
    check('entry_date', 'La fecha de ingreso es obligatoria').isISO8601(),
    validateFields
], createBatch);

router.put('/:id', [
    isAdminRole,
    check('id', 'ID de lote no válido').isNumeric(),
    validateFields
], updateBatch);

router.delete('/:id', [
    isAdminRole,
    check('id', 'ID de lote no válido').isNumeric(),
    validateFields
], deleteBatch);

router.post('/bulk-import', [
    isAdminRole,
    check('batches', 'Se requiere un array de lotes').isArray({ min: 1 }),
    validateFields
], bulkImportBatches);

module.exports = router;
