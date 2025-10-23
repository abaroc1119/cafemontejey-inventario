const pool = require('../db/database');

const logAction = async (userId, action) => {
    try {
        if (!userId) {
            console.error('Intento de registrar acción sin userId.');
            return;
        }
        await pool.query('INSERT INTO audit_logs (user_id, action) VALUES (?, ?)', [userId, action]);
    } catch (error) {
        console.error('Error al registrar la acción de auditoría:', error);
    }
};

module.exports = { 
    logAction 
};