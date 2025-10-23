const { Router } = require('express');
const { check } = require('express-validator');
const { getSuppliers, createSupplier, updateSupplier, deleteSupplier } = require('../controllers/suppliers.controller');
const { validateJWT } = require('../middlewares/validate-jwt');
const { isAdminRole } = require('../middlewares/validate-roles');
const { validateFields } = require('../middlewares/validate-fields');

const router = Router();

router.use(validateJWT);
router.use(isAdminRole);

// --- VALIDACIONES MEJORADAS ---
const supplierValidations = [
    check('company_name', 'El nombre de la empresa es obligatorio').not().isEmpty(),
    // Valida que el NIT sea numérico y sin espacios
    check('nit', 'El NIT es obligatorio y solo debe contener números').isNumeric().not().contains(' '),
    // Valida que el email tenga un formato correcto, incluyendo el dominio
    check('email', 'El correo electrónico no es válido').isEmail().matches(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/)
];

router.get('/', getSuppliers);

router.post('/', supplierValidations, validateFields, createSupplier);

router.put('/:id', supplierValidations, validateFields, updateSupplier);

router.delete('/:id', deleteSupplier);

module.exports = router;