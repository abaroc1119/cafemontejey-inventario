const { Router } = require('express');
const { check } = require('express-validator');

const { validateFields } = require('../middlewares/validate-fields');
const { validateJWT } = require('../middlewares/validate-jwt');

const { getCategories, getSubcategories } = require('../controllers/categories.controller');

const router = Router();

// Ruta para obtener todas las categorías principales
router.get('/', [
    validateJWT,
], getCategories);

// Ruta para obtener las subcategorías de una categoría específica
router.get('/:categoryId/subcategories', [
    validateJWT,
    check('categoryId', 'El ID de la categoría debe ser un número').isNumeric(),
    validateFields
], getSubcategories);


module.exports = router;
