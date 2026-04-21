const pool = require('../db/database');
const { logAction } = require('../helpers/audit.helper');

const toNumber = (v, fb = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
};
const roundCurrency = (v) => Number(toNumber(v).toFixed(2));

/**
 * Lista comisiones con filtros y totales. Usado por la página /commissions.
 */
const getCommissions = async (req, res) => {
    const {
        page = 1,
        limit = 15,
        sellerId,
        status,
        source,
        startDate,
        endDate,
    } = req.query;
    const offset = (page - 1) * limit;

    try {
        const conditions = [];
        const params = [];

        if (sellerId) { conditions.push('c.seller_id = ?'); params.push(sellerId); }
        if (status)   { conditions.push('c.status = ?');    params.push(status); }
        if (source)   { conditions.push('c.source = ?');    params.push(source); }
        if (startDate && endDate) {
            conditions.push('c.entry_date BETWEEN ? AND ?');
            params.push(startDate, endDate);
        }
        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const [rows] = await pool.query(
            `SELECT
                c.id, c.seller_id, c.sale_id, c.batch_id, c.entry_date,
                c.base_amount, c.rate_percent, c.amount, c.status,
                c.payment_date, c.payment_method, c.source, c.notes, c.created_at,
                s.full_name AS seller_name,
                pb.batch_code,
                sale.total_amount AS sale_total
             FROM commissions c
             LEFT JOIN sellers s ON c.seller_id = s.id
             LEFT JOIN product_batches pb ON c.batch_id = pb.id
             LEFT JOIN sales sale ON c.sale_id = sale.id
             ${whereClause}
             ORDER BY c.entry_date DESC, c.id DESC
             LIMIT ? OFFSET ?`,
            [...params, parseInt(limit, 10), parseInt(offset, 10)]
        );

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total FROM commissions c ${whereClause}`, params
        );

        const [[totals]] = await pool.query(
            `SELECT
                COALESCE(SUM(CASE WHEN status = 'pending'   THEN amount ELSE 0 END), 0) AS pending_amount,
                COALESCE(SUM(CASE WHEN status = 'paid'      THEN amount ELSE 0 END), 0) AS paid_amount,
                COALESCE(SUM(CASE WHEN status = 'cancelled' THEN amount ELSE 0 END), 0) AS cancelled_amount,
                COALESCE(SUM(amount), 0) AS total_amount,
                COALESCE(SUM(base_amount), 0) AS total_base,
                COUNT(*) AS total_count
             FROM commissions c ${whereClause}`,
            params
        );

        res.json({
            commissions: rows,
            totalPages: Math.ceil(total / limit),
            currentPage: parseInt(page, 10),
            totals,
        });
    } catch (error) {
        console.error('Error al listar comisiones:', error);
        res.status(500).json({ msg: 'Error al listar las comisiones' });
    }
};

/**
 * Resumen agrupado por vendedor (para la vista de vendedores o dashboard).
 */
const getCommissionsSummaryBySeller = async (req, res) => {
    const { startDate, endDate } = req.query;
    const params = [];
    let whereClause = '';
    if (startDate && endDate) {
        whereClause = 'WHERE c.entry_date BETWEEN ? AND ?';
        params.push(startDate, endDate);
    }

    try {
        const [rows] = await pool.query(
            `SELECT
                s.id AS seller_id, s.full_name,
                COUNT(c.id) AS commissions_count,
                COALESCE(SUM(CASE WHEN c.status = 'pending' THEN c.amount ELSE 0 END), 0) AS pending_amount,
                COALESCE(SUM(CASE WHEN c.status = 'paid'    THEN c.amount ELSE 0 END), 0) AS paid_amount,
                COALESCE(SUM(c.amount), 0) AS total_amount,
                COALESCE(SUM(c.base_amount), 0) AS total_base
             FROM sellers s
             LEFT JOIN commissions c ON c.seller_id = s.id ${whereClause ? `AND ${whereClause.replace('WHERE ', '')}` : ''}
             WHERE s.is_active = TRUE
             GROUP BY s.id
             ORDER BY s.full_name ASC`,
            params
        );
        res.json(rows);
    } catch (error) {
        console.error('Error al obtener resumen de comisiones:', error);
        res.status(500).json({ msg: 'Error al obtener el resumen' });
    }
};

/**
 * Crea una comisión manual (ajuste, bono, etc.). No proviene de una venta.
 */
const createCommission = async (req, res) => {
    const {
        seller_id, entry_date, base_amount = 0, rate_percent = 0,
        amount, notes, status = 'pending',
    } = req.body;
    const userId = req.uid;

    try {
        const [[seller]] = await pool.query('SELECT id, full_name FROM sellers WHERE id = ?', [seller_id]);
        if (!seller) return res.status(404).json({ msg: 'Vendedor no encontrado' });

        const computedAmount = amount !== undefined && amount !== null
            ? roundCurrency(amount)
            : roundCurrency(toNumber(base_amount) * toNumber(rate_percent) / 100);

        const [result] = await pool.query(
            `INSERT INTO commissions
                (seller_id, entry_date, base_amount, rate_percent, amount,
                 status, source, notes)
             VALUES (?, ?, ?, ?, ?, ?, 'manual_adjustment', ?)`,
            [
                seller_id,
                entry_date,
                roundCurrency(base_amount),
                toNumber(rate_percent),
                computedAmount,
                status,
                notes || null,
            ]
        );

        const [[created]] = await pool.query(
            `SELECT c.*, s.full_name AS seller_name
             FROM commissions c LEFT JOIN sellers s ON c.seller_id = s.id
             WHERE c.id = ?`, [result.insertId]
        );

        await logAction(userId,
            `Registró comisión manual por ${computedAmount} para '${seller.full_name}' (ID comisión: ${result.insertId})`);
        res.status(201).json(created);
    } catch (error) {
        console.error('Error al crear comisión:', error);
        res.status(500).json({ msg: 'Error al crear la comisión' });
    }
};

/**
 * Edita campos "seguros" de una comisión (monto, notas, tasa, fecha).
 */
const updateCommission = async (req, res) => {
    const { id } = req.params;
    const { base_amount, rate_percent, amount, entry_date, notes } = req.body;
    const userId = req.uid;

    try {
        const [[commission]] = await pool.query('SELECT * FROM commissions WHERE id = ?', [id]);
        if (!commission) return res.status(404).json({ msg: 'Comisión no encontrada' });
        if (commission.status === 'paid') {
            return res.status(400).json({ msg: 'No se puede editar una comisión ya pagada. Anúlala primero.' });
        }

        const updates = [];
        const params = [];

        if (base_amount !== undefined)  { updates.push('base_amount = ?');  params.push(roundCurrency(base_amount)); }
        if (rate_percent !== undefined) { updates.push('rate_percent = ?'); params.push(toNumber(rate_percent)); }
        if (amount !== undefined)       { updates.push('amount = ?');       params.push(roundCurrency(amount)); }
        if (entry_date !== undefined)   { updates.push('entry_date = ?');   params.push(entry_date); }
        if (notes !== undefined)        { updates.push('notes = ?');        params.push(notes || null); }

        if (!updates.length) {
            return res.status(400).json({ msg: 'No hay campos para actualizar.' });
        }

        params.push(id);
        await pool.query(`UPDATE commissions SET ${updates.join(', ')} WHERE id = ?`, params);

        const [[updated]] = await pool.query('SELECT * FROM commissions WHERE id = ?', [id]);
        await logAction(userId, `Editó comisión #${id}`);
        res.json(updated);
    } catch (error) {
        console.error('Error al actualizar comisión:', error);
        res.status(500).json({ msg: 'Error al actualizar la comisión' });
    }
};

/**
 * Marca una (o varias) comisiones como pagadas y genera entrada contable
 * de gasto en el financial_ledger.
 */
const markCommissionsPaid = async (req, res) => {
    const { ids, payment_date, payment_method } = req.body;
    const userId = req.uid;

    if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ msg: 'Debes indicar las comisiones a pagar.' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const placeholders = ids.map(() => '?').join(',');
        const [rows] = await connection.query(
            `SELECT c.*, s.full_name AS seller_name
             FROM commissions c LEFT JOIN sellers s ON c.seller_id = s.id
             WHERE c.id IN (${placeholders})`,
            ids
        );

        let paidCount = 0;
        const today = payment_date || new Date().toISOString().split('T')[0];

        for (const row of rows) {
            if (row.status !== 'pending') continue;

            await connection.query(
                `UPDATE commissions SET status = 'paid', payment_date = ?, payment_method = ?
                 WHERE id = ?`,
                [today, payment_method || null, row.id]
            );

            // Sólo registrar gasto si la comisión es positiva (en caso de
            // ajustes negativos no tiene sentido crear un gasto negativo).
            if (row.amount > 0) {
                await connection.query(
                    `INSERT INTO financial_ledger (entry_date, concept, expense)
                     VALUES (?, ?, ?)`,
                    [today, `Pago comisión a ${row.seller_name} (ID comisión: ${row.id})`, row.amount]
                );
            }

            paidCount++;
        }

        await connection.commit();
        await logAction(userId, `Marcó como pagadas ${paidCount} comisiones.`);
        res.json({ msg: `${paidCount} comisiones marcadas como pagadas.` });
    } catch (error) {
        await connection.rollback();
        console.error('Error al pagar comisiones:', error);
        res.status(500).json({ msg: 'Error al marcar las comisiones como pagadas' });
    } finally {
        connection.release();
    }
};

/**
 * Anula (cancela) una comisión. Si ya estaba pagada, también revierte el
 * asiento contable asociado.
 */
const cancelCommission = async (req, res) => {
    const { id } = req.params;
    const userId = req.uid;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [[c]] = await connection.query(
            `SELECT c.*, s.full_name AS seller_name
             FROM commissions c LEFT JOIN sellers s ON c.seller_id = s.id
             WHERE c.id = ?`, [id]);
        if (!c) {
            await connection.rollback();
            return res.status(404).json({ msg: 'Comisión no encontrada' });
        }
        if (c.status === 'cancelled') {
            await connection.rollback();
            return res.status(400).json({ msg: 'La comisión ya está anulada.' });
        }

        // Si estaba pagada y fue gasto, registramos un ingreso compensatorio.
        if (c.status === 'paid' && c.amount > 0) {
            await connection.query(
                `INSERT INTO financial_ledger (entry_date, concept, income)
                 VALUES (CURDATE(), ?, ?)`,
                [`Reversa pago de comisión (ID: ${c.id}) a ${c.seller_name}`, c.amount]
            );
        }

        await connection.query(
            `UPDATE commissions SET status = 'cancelled' WHERE id = ?`, [id]
        );

        await connection.commit();
        await logAction(userId, `Anuló comisión #${id} (${c.seller_name}).`);
        res.json({ msg: 'Comisión anulada correctamente.' });
    } catch (error) {
        await connection.rollback();
        console.error('Error al anular comisión:', error);
        res.status(500).json({ msg: 'Error al anular la comisión' });
    } finally {
        connection.release();
    }
};

module.exports = {
    getCommissions,
    getCommissionsSummaryBySeller,
    createCommission,
    updateCommission,
    markCommissionsPaid,
    cancelCommission,
};
