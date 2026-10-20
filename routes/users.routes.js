const { Router } = require('express');
const { check, body } = require('express-validator');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');

// --- 1. IMPORTACIONES ACTUALIZADAS ---
// Se importan las nuevas funciones y se eliminan las antiguas.
const { 
    getUsers, 
    createUser, 
    updateUser, 
    softDeleteUser,      // Nueva función
    toggleUserStatus,    // Nueva función
    updatePassword, 
    uploadProfilePhoto 
} = require('../controllers/users.controller');

const { validateJWT } = require('../middlewares/validate-jwt');
const { isAdminRole } = require('../middlewares/validate-roles');
const { validateFields } = require('../middlewares/validate-fields');

const router = Router();

// Solo se aceptan imágenes rasterizadas (no SVG ni HTML, que pueden llevar JavaScript).
const ALLOWED_IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const storage = multer.diskStorage({
    destination: path.join(__dirname, '../public/uploads/profiles'),
    filename: (req, file, cb) => {
        // Nombre aleatorio con la extensión que corresponde al tipo, sin usar originalname.
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ALLOWED_IMAGE_TYPES[file.mimetype]}`);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_IMAGE_TYPES[file.mimetype]) return cb(null, true);
        cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'profile_photo'));
    }
});

// Convierte los errores de multer en respuestas 400 en vez de un 500 genérico.
const handleUpload = (req, res, next) => {
    upload.single('profile_photo')(req, res, (err) => {
        if (!err) return next();
        const msg = err.code === 'LIMIT_FILE_SIZE'
            ? 'La imagen no puede superar 2 MB.'
            : 'Solo se permiten imágenes JPG, PNG o WEBP.';
        return res.status(400).json({ msg });
    });
};

router.use(validateJWT);

router.post('/upload-photo', handleUpload, uploadProfilePhoto);

const passwordValidationMsg = 'La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula, un número y un caracter especial.';
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`])[A-Za-z\d!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]{8,}$/;

router.put('/update-password', [
    check('oldPassword', 'La contraseña actual es obligatoria').not().isEmpty(),
    check('newPassword').matches(passwordRegex).withMessage(passwordValidationMsg),
    validateFields
], updatePassword);


// --- RUTAS DE GESTIÓN DE USUARIOS (ADMIN) ---

router.get('/', isAdminRole, getUsers);

router.post('/', [
    isAdminRole, 
    check('full_name').not().isEmpty(), 
    check('username').not().isEmpty(), 
    check('email').isEmail(), 
    check('role_id').isInt(), 
    check('password').matches(passwordRegex).withMessage(passwordValidationMsg), 
    validateFields
], createUser);

router.put('/:id', [
    isAdminRole, 
    body('password').if(body('password').exists({ checkFalsy: true })).matches(passwordRegex).withMessage(passwordValidationMsg), 
    validateFields
], updateUser);


// --- 2. RUTAS DE BORRADO MODIFICADAS ---

// Nueva ruta para activar/desactivar (borrado temporal)
// Usa PATCH porque es una actualización parcial.
router.patch('/status/:id', [
    isAdminRole,
    check('id', 'ID no válido').isNumeric(),
    check('activate', 'El estado de activación es requerido').isBoolean(),
    validateFields
], toggleUserStatus);


// La ruta DELETE ahora apunta a la eliminación lógica "permanente"
router.delete('/:id', [
    isAdminRole,
    check('id', 'ID no válido').isNumeric(),
    validateFields
], softDeleteUser);


module.exports = router;