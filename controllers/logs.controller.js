const pool = require('../db/database');

const getLogs = async (req, res) => {
    // 1. Obtenemos los nuevos parámetros de mes y año
    const { page = 1, limit = 15, search = '', month, year } = req.query;
    const offset = (page - 1) * limit;

    try {
        const searchTerm = `%${search}%`;
        
        // 2. Construimos la consulta y los parámetros dinámicamente
        let conditions = ['(u.full_name LIKE ? OR l.action LIKE ?)'];
        let params = [searchTerm, searchTerm];

        if (month) {
            conditions.push('MONTH(l.created_at) = ?');
            params.push(parseInt(month));
        }
        if (year) {
            conditions.push('YEAR(l.created_at) = ?');
            params.push(parseInt(year));
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;

        // 3. Ejecutamos la consulta principal con los nuevos filtros
        const [logs] = await pool.query(`
            SELECT 
                l.id, l.action, l.created_at, u.full_name as user_name
            FROM audit_logs l
            JOIN users u ON l.user_id = u.id
            ${whereClause}
            ORDER BY l.created_at DESC
            LIMIT ? OFFSET ?
        `, [...params, parseInt(limit), parseInt(offset)]);

        // 4. Ejecutamos la consulta de conteo con los mismos filtros
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) as total 
             FROM audit_logs l
             JOIN users u ON l.user_id = u.id
             ${whereClause}`,
            params
        );
        
        res.json({
            logs,
            totalPages: Math.ceil(total / limit),
            currentPage: parseInt(page),
        });

    } catch (error) {
        console.error("Error al obtener los logs de auditoría:", error);
        res.status(500).json({ msg: 'Error al obtener los registros de auditoría' });
    }
};

module.exports = {
    getLogs
};