const { Router } = require('express');
const { check } = require('express-validator');

const { 
    createLayawayPlan, 
    getLayawayPlans, 
    updateLayawayPlan, 
    deleteLayawayPlan,
    getLayawayPlanById
} = require('../controllers/layaway.controller');

const { validateJWT } = require('../middlewares/validate-jwt');
const { validateFields } = require('../middlewares/validate-fields');

const router = Router();

router.use(validateJWT);

router.get('/', getLayawayPlans);
router.get('/:id', getLayawayPlanById);

router.post('/', [
    check('customer_name', 'El nombre del cliente es obligatorio').not().isEmpty(),
    check('total_value', 'El valor total es obligatorio').isNumeric(),
    check('down_payment', 'El abono inicial es obligatorio').isNumeric(),
    
    // --- INICIO DE LA CORRECCIÓN ---
    // Se valida que sea una fecha en formato ISO (YYYY-MM-DD), pero se elimina .toDate()
    // para evitar la conversión a un objeto Date con zona horaria UTC.
    check('deadline', 'La fecha límite es obligatoria y debe tener un formato válido.').isISO8601(),
    
    // Se añade una validación para asegurar que la fecha límite no sea en el pasado.
    check('deadline').custom((value) => {
        // `value` es ahora una cadena 'YYYY-MM-DD'. new Date() la interpreta correctamente
        // como la medianoche en la zona horaria local del servidor.
        const deadlineDate = new Date(value);
        const today = new Date();
        
        // Se ajusta la hora de 'today' a cero para comparar solo las fechas.
        today.setHours(0, 0, 0, 0);

        if (deadlineDate < today) {
            throw new Error('La fecha límite no puede ser en el pasado.');
        }
        return true;
    }),
    // --- FIN DE LA CORRECCIÓN ---

    check('products', 'La lista de productos no puede estar vacía').isArray({ min: 1 }),
    validateFields
], createLayawayPlan);

router.put('/:id', updateLayawayPlan);
router.delete('/:id', deleteLayawayPlan);

module.exports = router;
