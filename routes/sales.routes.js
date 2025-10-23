const { Router } = require('express');
const { check } = require('express-validator');
// Se importa la nueva función 'bulkImportSales'
const { createSale, getSales, getSaleById, bulkImportSales } = require('../controllers/sales.controller');
const { validateJWT } = require('../middlewares/validate-jwt');
const { isAdminRole } = require('../middlewares/validate-roles'); // Se importa el validador de rol
const { validateFields } = require('../middlewares/validate-fields');

const router = Router();

router.use(validateJWT);

router.get('/', getSales);
router.get('/:id', getSaleById);

router.post('/', [
    check('total_amount', 'El monto total es obligatorio').isNumeric(),
    check('products', 'La lista de productos no puede estar vacía').isArray({ min: 1 }),
    check('products.*.product_id', 'El ID del producto es obligatorio').isInt(),
    check('products.*.quantity', 'La cantidad del producto debe ser un entero positivo').isInt({ gt: 0 }),
    check('products.*.unit_price', 'El precio unitario es obligatorio').isNumeric(),
    validateFields
], createSale);

// --- NUEVA RUTA PARA IMPORTACIÓN MASIVA ---
router.post('/bulk-import', [
    isAdminRole, // Solo los administradores pueden importar ventas masivamente
    check('sales', 'Se requiere un array de ventas.').isArray({ min: 1 }),
    validateFields
], bulkImportSales);


module.exports = router;