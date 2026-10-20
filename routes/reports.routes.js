const { Router } = require('express');
const { getFinancialLedger, createFinancialEntry, exportLedgerToExcel } = require('../controllers/reports.controller');
const { validateJWT } = require('../middlewares/validate-jwt');
const { isAdminRole } = require('../middlewares/validate-roles');
const { check } = require('express-validator');
const { validateFields } = require('../middlewares/validate-fields');

const router = Router();

router.use(validateJWT, isAdminRole);

router.get('/financial-ledger', getFinancialLedger);

router.post('/financial-ledger', [
    // --- INICIO DE LA CORRECCIÓN ---
    // Se valida que sea una fecha en formato ISO (YYYY-MM-DD), pero se elimina .toDate()
    // para evitar la conversión a un objeto Date con zona horaria UTC.
    // La fecha se mantendrá como una cadena de texto simple hasta el controlador.
    check('entry_date', 'La fecha de entrada es obligatoria y debe tener un formato válido.').isISO8601(),
    // --- FIN DE LA CORRECCIÓN ---

    check('entry_date').custom((value) => {
        // Esta validación ahora recibe la cadena de texto 'YYYY-MM-DD'.
        // new Date() la interpretará correctamente en la zona horaria del servidor.
        const entryDate = new Date(value);
        const today = new Date();

        // Ponemos la hora a cero para comparar solo las fechas
        // NOTA: Es importante añadir un ajuste de zona horaria aquí para una comparación precisa.
        const userTimezoneOffset = entryDate.getTimezoneOffset() * 60000;
        const entryDateLocal = new Date(entryDate.getTime() + userTimezoneOffset);

        today.setHours(0,0,0,0);
        
        if (entryDateLocal > today) {
            throw new Error('La fecha del movimiento no puede ser en el futuro.');
        }
        return true;
    }),
    check('concept', 'El concepto es obligatorio.').not().isEmpty(),
    validateFields
], createFinancialEntry);

router.get('/export/excel', exportLedgerToExcel);

module.exports = router;