const { Router } = require('express');
const { getNotifications, getNotificationStatus, markNotificationsAsRead } = require('../controllers/notifications.controller');
const { validateJWT } = require('../middlewares/validate-jwt');

const router = Router();

router.use(validateJWT);

router.get('/', getNotifications);

// --- NUEVAS RUTAS ---
router.get('/status', getNotificationStatus); // Para verificar si hay nuevas
router.post('/mark-as-read', markNotificationsAsRead); // Para marcarlas como leídas

module.exports = router;