const { Router } = require('express');
const { check } = require('express-validator');

const {
    getGreenLots,
    getGreenLotById,
    createGreenLot,
    deleteGreenLot,
} = require('../controllers/greenLots.controller');

const { validateJWT } = require('../middlewares/validate-jwt');
const { isAdminRole } = require('../middlewares/validate-roles');
const { validateFields } = require('../middlewares/validate-fields');

const router = Router();

router.use(validateJWT);

// Consultar lotes verdes
router.get('/', getGreenLots);

router.get('/:id', [
    check('id', 'ID no válido').isNumeric(),
    validateFields,
], getGreenLotById);

// Solo admins pueden crear y eliminar
router.post('/', [
    isAdminRole,
    check('green_quantity_kg', 'Los kilogramos de café verde son obligatorios').isFloat({ gt: 0 }),
    check('green_total_cost', 'El costo total es obligatorio').isFloat({ gt: 0 }),
    check('entry_date', 'La fecha de ingreso es obligatoria').isISO8601(),
    check('distributions', 'Debes incluir al menos una línea de distribución').isArray({ min: 1 }),
    validateFields,
], createGreenLot);

router.delete('/:id', [
    isAdminRole,
    check('id', 'ID no válido').isNumeric(),
    validateFields,
], deleteGreenLot);

module.exports = router;
