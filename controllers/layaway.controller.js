const pool = require('../db/database');
const { logAction } = require('../helpers/audit.helper');
const { registerInventoryMovement, increaseBatchStock } = require('../services/inventory.service');

const getLayawayPlans = async (req, res) => {
    const { search = '', status = 'active' } = req.query;
    try {
        await pool.query("UPDATE layaway_plans SET status = 'overdue' WHERE deadline < CURDATE() AND status = 'active'");
        const searchTerm = `%${search}%`;
        const queryParams = [searchTerm, searchTerm];
        let query = 'SELECT * FROM layaway_plans WHERE (customer_name LIKE ? OR customer_id_doc LIKE ?)';
        if (status && status !== 'all') {
            query += ' AND status = ?';
            queryParams.push(status);
        }
        query += ' ORDER BY created_at DESC';
        const [plans] = await pool.query(query, queryParams);
        res.json(plans);
    } catch (error) {
        console.error('Error al obtener planes separe:', error);
        res.status(500).json({ msg: 'Error al obtener los planes separe' });
    }
};

const getLayawayPlanById = async (req, res) => {
    const { id } = req.params;
    try {
        const [[plan]] = await pool.query('SELECT * FROM layaway_plans WHERE id = ?', [id]);
        if (!plan) {
            return res.status(404).json({ msg: 'Plan separe no encontrado' });
        }

        const [products] = await pool.query(
            `SELECT 
                d.quantity, d.batch_id,
                p.price as price_at_sale, 
                p.name as product_name, 
                p.id as product_id,
                p.sku as product_sku,
                p.attributes as product_attributes,
                pb.batch_code, pb.cost_per_unit,
                sup.company_name as supplier_name
             FROM layaway_plan_details d 
             JOIN products p ON d.product_id = p.id
             LEFT JOIN product_batches pb ON d.batch_id = pb.id
             LEFT JOIN suppliers sup ON pb.supplier_id = sup.id
             WHERE d.layaway_plan_id = ?`,
            [id]
        );

        res.json({ ...plan, products: products });
    } catch (error) {
        console.error('Error al obtener el detalle del plan separe:', error);
        res.status(500).json({ msg: 'Error al obtener el detalle del plan' });
    }
};

const createLayawayPlan = async (req, res) => {
    const { customer_name, customer_id_doc, customer_contact, total_value, down_payment, deadline, products } = req.body;

    if (!products || !Array.isArray(products) || products.length === 0) {
        return res.status(400).json({ msg: 'La lista de productos no puede estar vacía.' });
    }

    const balance_due = total_value - down_payment;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        for (const product of products) {
            const [[batch]] = await connection.query(
                'SELECT pb.current_quantity, p.name FROM product_batches pb JOIN products p ON pb.product_id = p.id WHERE pb.id = ? FOR UPDATE',
                [product.batch_id]
            );
            if (!batch || batch.current_quantity < product.quantity) {
                await connection.rollback();
                return res.status(400).json({
                    msg: `Stock insuficiente en el lote para: ${batch?.name || 'producto desconocido'}`
                });
            }
        }

        const [planResult] = await connection.query(
            'INSERT INTO layaway_plans (customer_name, customer_id_doc, customer_contact, total_value, down_payment, balance_due, deadline) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [customer_name, customer_id_doc, customer_contact, total_value, down_payment, balance_due, deadline]
        );
        const planId = planResult.insertId;

        for (const product of products) {
            await connection.query(
                'INSERT INTO layaway_plan_details (layaway_plan_id, product_id, batch_id, quantity) VALUES (?, ?, ?, ?)',
                [planId, product.product_id, product.batch_id, product.quantity]
            );

            await connection.query(
                'UPDATE product_batches SET current_quantity = current_quantity - ? WHERE id = ?',
                [product.quantity, product.batch_id]
            );

            await registerInventoryMovement(connection, {
                productId: product.product_id,
                batchId: product.batch_id,
                movementType: 'RESERVE',
                quantity: parseInt(product.quantity, 10),
                referenceType: 'layaway',
                referenceId: planId,
                notes: `Reserva por plan separe #${planId}`
            });
        }

        if (down_payment > 0) {
            await connection.query(
                'INSERT INTO financial_ledger (entry_date, concept, income) VALUES (CURDATE(), ?, ?)',
                [`Abono inicial Plan Separe #${planId} - ${customer_name}`, down_payment]
            );
        }

        await connection.commit();
        const [newPlan] = await pool.query('SELECT * FROM layaway_plans WHERE id = ?', [planId]);
        await logAction(req.uid, `Creó un plan separe (ID: ${planId}) para el cliente ${customer_name}`);
        res.status(201).json(newPlan[0]);

    } catch (error) {
        await connection.rollback();
        console.error('Error detallado al crear plan separe:', error);
        res.status(500).json({ msg: error.message || 'Error interno al guardar los detalles del plan.' });
    } finally {
        connection.release();
    }
};

const updateLayawayPlan = async (req, res) => {
    const { id } = req.params;
    const { uid } = req;
    const { new_payment_amount } = req.body;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        const [[plan]] = await connection.query('SELECT * FROM layaway_plans WHERE id = ? FOR UPDATE', [id]);
        if (!plan) {
            await connection.rollback();
            return res.status(404).json({ msg: 'Plan separe no encontrado' });
        }

        if (plan.status === 'completed') {
            await connection.rollback();
            return res.status(400).json({ msg: 'El plan separe ya está pagado por completo.' });
        }

        const payment = parseFloat(new_payment_amount);
        if (!Number.isFinite(payment) || payment <= 0) {
            await connection.rollback();
            return res.status(400).json({ msg: 'El abono debe ser un número mayor que cero.' });
        }
        if (payment > parseFloat(plan.balance_due)) {
            await connection.rollback();
            return res.status(400).json({ msg: `El abono supera el saldo pendiente (${plan.balance_due}).` });
        }

        {
            let { down_payment, balance_due, customer_name } = plan;

            down_payment = parseFloat(down_payment) + payment;
            balance_due = parseFloat(balance_due) - payment;
            let newStatus = plan.status;

            if (balance_due <= 0) {
                newStatus = 'completed';
                balance_due = 0;
            }

            await connection.query(
                'UPDATE layaway_plans SET down_payment = ?, balance_due = ?, status = ? WHERE id = ?',
                [down_payment, balance_due, newStatus, id]
            );

            await connection.query(
                'INSERT INTO financial_ledger (entry_date, concept, income) VALUES (CURDATE(), ?, ?)',
                [`Abono a Plan Separe #${id} - ${customer_name}`, payment]
            );
        }

        const [[updatedPlan]] = await connection.query('SELECT * FROM layaway_plans WHERE id = ?', [id]);
        await connection.commit();
        await logAction(uid, `Actualizó el plan separe (ID: ${id}) con un abono.`);
        res.json(updatedPlan);
    } catch (error) {
        await connection.rollback();
        console.error('Error al actualizar el plan:', error);
        res.status(500).json({ msg: 'Error al actualizar el plan' });
    } finally {
        connection.release();
    }
};

const deleteLayawayPlan = async (req, res) => {
    const { id } = req.params;
    const { uid } = req;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [details] = await connection.query(
            'SELECT product_id, batch_id, quantity FROM layaway_plan_details WHERE layaway_plan_id = ?',
            [id]
        );

        for (const detail of details) {
            if (detail.batch_id) {
                await increaseBatchStock(detail.batch_id, detail.quantity, connection, {
                    movementType: 'RELEASE',
                    referenceType: 'layaway_cancel',
                    referenceId: parseInt(id, 10),
                    notes: `Liberación por cancelación del plan separe #${id}`
                });
            }
        }

        await connection.query('DELETE FROM layaway_plan_details WHERE layaway_plan_id = ?', [id]);
        await connection.query('DELETE FROM layaway_plans WHERE id = ?', [id]);
        await connection.commit();
        await logAction(uid, `Eliminó/Canceló el plan separe (ID: ${id})`);
        res.json({ msg: 'Plan separe eliminado y stock devuelto a los lotes correspondientes.' });
    } catch (error) {
        await connection.rollback();
        console.error('Error al eliminar plan separe:', error);
        res.status(500).json({ msg: 'Error al eliminar el plan separe' });
    } finally {
        connection.release();
    }
};

module.exports = {
    getLayawayPlans,
    getLayawayPlanById,
    createLayawayPlan,
    updateLayawayPlan,
    deleteLayawayPlan
};
