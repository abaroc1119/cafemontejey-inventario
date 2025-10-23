// /middlewares/validate-roles.js
const isAdminRole = (req, res, next) => {
    if (!req.role) {
        return res.status(500).json({ msg: 'Se quiere verificar el rol sin validar el token primero' });
    }
    if (req.role !== 'admin') {
        return res.status(403).json({ msg: 'No tiene permisos de administrador para realizar esta acción' });
    }
    next();
};

module.exports = { isAdminRole };