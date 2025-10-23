const { Router } = require('express');
const { check } = require('express-validator');

// 1. Se importa la nueva función 'searchProducts'
const { 
    getProducts, 
    getProductById, 
    createProduct, 
    updateProduct, 
    deleteProduct, 
    bulkImportProducts, 
    getProductBySku,
    searchProducts 
} = require('../controllers/products.controller');

const { validateJWT } = require('../middlewares/validate-jwt');
const { isAdminRole } = require('../middlewares/validate-roles');
const { validateFields } = require('../middlewares/validate-fields');

const router = Router();

router.use(validateJWT);

router.get('/', getProducts);

// 2. NUEVA RUTA PARA BÚSQUEDA RÁPIDA EN VENTAS
// Esta ruta no necesita ser de admin, ya que la usan los vendedores.
router.get('/search/:term', [
    check('term', 'El término de búsqueda es obligatorio').not().isEmpty(),
    validateFields
], searchProducts);

router.get('/:id', [
    check('id', 'El ID debe ser un número válido').isNumeric(),
    validateFields
], getProductById);

router.get('/sku/:sku', [
    check('sku', 'El SKU es obligatorio').not().isEmpty(),
    validateFields
], getProductBySku);

const productValidations = [
    check('name', 'El nombre del producto es obligatorio').not().isEmpty(),
    check('sku', 'El SKU es obligatorio').not().isEmpty(),
    check('category_id', 'La categoría es obligatoria').isNumeric(),
    check('quantity', 'La cantidad debe ser un número entero igual o mayor a 0').isInt({ min: 0 }),
    check('price', 'El precio debe ser un número igual o mayor a 0').isFloat({ min: 0 }),
    check('cost', 'El costo debe ser un número igual o mayor a 0').isFloat({ min: 0 })
];

router.post('/', [ isAdminRole, ...productValidations, validateFields ], createProduct);

router.put('/:id', [ 
    isAdminRole, 
    check('id', 'El ID debe ser un número válido').isNumeric(),
    ...productValidations, 
    validateFields 
], updateProduct);

router.delete('/:id', [
    isAdminRole,
    check('id', 'El ID debe ser un número válido').isNumeric(),
    validateFields
], deleteProduct);

router.post('/bulk-import', [ isAdminRole, validateFields ], bulkImportProducts);

module.exports = router;