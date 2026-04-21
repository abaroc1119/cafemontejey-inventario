const pool = require('../db/database');
const { logAction } = require('../helpers/audit.helper');

/**
 * Listado paginado de vendedores con totales agregados de comisiones.
 */
const getSellers = async (req, res) => {
    const { page = 1, limit = 15, search = '', includeInactive = 'false' } = req.query;
    const offset = (page - 1) * limit;

    try {
        const searchTerm = `%${search}%`;
        const conditions = [];
        const params = [];

        if (search) {
            conditions.push('(s.full_name LIKE ? OR s.document LIKE ? OR s.contact LIKE ?)');
            params.push(searchTerm, searchTerm, searchTerm);
        }
        if (includeInactive !== 'true') {
            conditions.push('s.is_active = TRUE');
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const [sellers] = await pool.query(
            `SELECT
                s.id, s.full_name, s.document, s.contact, s.email,
                s.commission_rate_default, s.notes, s.is_active, s.created_at,
                COALESCE(SUM(CASE WHEN c.status = 'pending'   THEN c.amount ELSE 0 END), 0) AS pending_amount,
                COALESCE(SUM(CASE WHEN c.status = 'paid'      THEN c.amount ELSE 0 END), 0) AS paid_amount,
                COALESCE(SUM(CASE WHEN c.status = 'cancelled' THEN c.amount ELSE 0 END), 0) AS cancelled_amount,
                COUNT(DISTINCT c.id) AS commissions_count
             FROM sellers s
             LEFT JOIN commissions c ON c.seller_id = s.id
             ${whereClause}
             GROUP BY s.id
             ORDER BY s.full_name ASC
             LIMIT ? OFFSET ?`,
            [...params, parseInt(limit, 10), parseInt(offset, 10)]
        );

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM sellers s ${whereClause}`, params
        );

        res.json({
            sellers,
            totalPages: Math.ceil(total / limit),
            currentPage: parseInt(page, 10),
        });
    } catch (error) {
        console.error('Error al obtener vendedores:', error);
        res.status(500).json({ msg: 'Error al obtener los vendedores' });
    }
};

const getSellerById = async (req, res) => {
    const { id } = req.params;
    try {
        const [[seller]] = await pool.query('SELECT * FROM sellers WHERE id = ?', [id]);
        if (!seller) return res.status(404).json({ msg: 'Vendedor no encontrado' });
        res.json(seller);
    } catch (error) {
        console.error('Error al obtener vendedor:', error);
        res.status(500).json({ msg: 'Error al obtener el vendedor' });
    }
};

const createSeller = async (req, res) => {
    const { full_name, document, contact, email, commission_rate_default = 0, notes } = req.body;
    const userId = req.uid;

    try {
        if (document) {
            const [[existing]] = await pool.query('SELECT id FROM sellers WHERE document = ?', [document]);
            if (existing) {
                return res.status(400).json({ msg: 'Ya existe un vendedor con ese documento.' });
            }
        }

        const [result] = await pool.query(
            `INSERT INTO sellers (full_name, document, contact, email, commission_rate_default, notes)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [full_name, document || null, contact || null, email || null,
             parseFloat(commission_rate_default) || 0, notes || null]
        );

        const [[newSeller]] = await pool.query('SELECT * FROM sellers WHERE id = ?', [result.insertId]);
        await logAction(userId, `Creó vendedor '${full_name}' (ID: ${result.insertId})`);
        res.status(201).json(newSeller);
    } catch (error) {
        console.error('Error al crear vendedor:', error);
        res.status(500).json({ msg: 'Error al crear el vendedor' });
    }
};

const updateSeller = async (req, res) => {
    const { id } = req.params;
    const { full_name, document, contact, email, commission_rate_default, notes, is_active } = req.body;
    const userId = req.uid;

    try {
        const [[seller]] = await pool.query('SELECT * FROM sellers WHERE id = ?', [id]);
        if (!seller) return res.status(404).json({ msg: 'Vendedor no encontrado' });

        // Validar documento único si cambia
        if (document && document !== seller.document) {
            const [[existing]] = await pool.query(
                'SELECT id FROM sellers WHERE document = ? AND id <> ?', [document, id]
            );
            if (existing) {
                return res.status(400).json({ msg: 'Ya existe otro vendedor con ese documento.' });
            }
        }

        await pool.query(
            `UPDATE sellers SET
                full_name = COALESCE(?, full_name),
                document = ?,
                contact = ?,
                email = ?,
                commission_rate_default = COALESCE(?, commission_rate_default),
                notes = ?,
                is_active = COALESCE(?, is_active)
             WHERE id = ?`,
            [
                full_name,
                document !== undefined ? (document || null) : seller.document,
                contact !== undefined ? (contact || null) : seller.contact,
                email !== undefined ? (email || null) : seller.email,
                commission_rate_default !== undefined ? parseFloat(commission_rate_default) : null,
                notes !== undefined ? (notes || null) : seller.notes,
                is_active !== undefined ? !!is_active : null,
                id,
            ]
        );

        const [[updated]] = await pool.query('SELECT * FROM sellers WHERE id = ?', [id]);
        await logAction(userId, `Actualizó vendedor '${updated.full_name}' (ID: ${id})`);
        res.json(updated);
    } catch (error) {
        console.error('Error al actualizar vendedor:', error);
        res.status(500).json({ msg: 'Error al actualizar el vendedor' });
    }
};

/**
 * Desactivación lógica. Si tiene comisiones, nunca se borra físicamente.
 */
const deleteSeller = async (req, res) => {
    const { id } = req.params;
    const userId = req.uid;
    try {
        const [[seller]] = await pool.query('SELECT * FROM sellers WHERE id = ?', [id]);
        if (!seller) return res.status(404).json({ msg: 'Vendedor no encontrado' });

        await pool.query('UPDATE sellers SET is_active = FALSE WHERE id = ?', [id]);
        await logAction(userId, `Desactivó vendedor '${seller.full_name}' (ID: ${id})`);
        res.json({ msg: 'Vendedor desactivado correctamente.' });
    } catch (error) {
        console.error('Error al desactivar vendedor:', error);
        res.status(500).json({ msg: 'Error al desactivar el vendedor' });
    }
};

/** Listado ligero para selects. */
const listActiveSellers = async (_req, res) => {
    try {
        const [sellers] = await pool.query(
            `SELECT id, full_name, document, commission_rate_default
             FROM sellers WHERE is_active = TRUE ORDER BY full_name ASC`
        );
        res.json(sellers);
    } catch (error) {
        console.error('Error al listar vendedores activos:', error);
        res.status(500).json({ msg: 'Error al listar vendedores' });
    }
};

module.exports = {
    getSellers,
    getSellerById,
    createSeller,
    updateSeller,
    deleteSeller,
    listActiveSellers,
};
