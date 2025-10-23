const { Router } = require('express');
const { check } = require('express-validator');

const { 
    getCustomers, 
    createCustomer, 
    updateCustomer, 
    deleteCustomer, 
    bulkImportCustomers,
    searchCustomers // Se importa la nueva función
} = require('../controllers/customers.controller');

const { validateJWT } = require('../middlewares/validate-jwt');
const { isAdminRole } = require('../middlewares/validate-roles');
const { validateFields } = require('../middlewares/validate-fields');

const router = Router();

router.use(validateJWT);

router.get('/', getCustomers);

// --- NUEVA RUTA DE BÚSQUEDA ---
// Accesible por todos los usuarios logueados para el punto de venta
router.get('/search/:term', [
    check('term', 'El término de búsqueda es requerido.').not().isEmpty(),
    validateFields
], searchCustomers);


// --- RUTAS RESTRINGIDAS A ADMINS ---
router.post('/', [
    isAdminRole,
    check('full_name', 'El nombre completo es obligatorio').not().isEmpty(),
    check('contact', 'El contacto es obligatorio').not().isEmpty(),
    check('email', 'El correo no es válido').optional().isEmail(),
    validateFields
], createCustomer);

router.put('/:id', [
    isAdminRole,
    check('id', 'ID de cliente no válido').isNumeric(),
    check('full_name', 'El nombre completo es obligatorio').not().isEmpty(),
    validateFields
], updateCustomer);

router.delete('/:id', [
    isAdminRole,
    check('id', 'ID de cliente no válido').isNumeric(),
    validateFields
], deleteCustomer);

router.post('/bulk-import', [
    isAdminRole,
    check('customers', 'Se requiere una lista de clientes').isArray({ min: 1 }),
    validateFields
], bulkImportCustomers);

module.exports = router;