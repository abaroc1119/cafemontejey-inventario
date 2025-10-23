const pool = require('../db/database');
const { logAction } = require('../helpers/audit.helper');

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
        console.error("Error al obtener planes separe:", error);
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
                d.quantity, 
                p.price as price_at_sale, 
                p.name as product_name, 
                p.id as product_id,
                p.sku as product_sku,
                p.attributes as product_attributes,
                p.cost as product_cost
             FROM layaway_plan_details d 
             JOIN products p ON d.product_id = p.id 
             WHERE d.layaway_plan_id = ?`,
            [id]
        );

        res.json({ ...plan, products: products });
    } catch (error) {
        console.error("Error al obtener el detalle del plan separe:", error);
        res.status(500).json({ msg: 'Error al obtener el detalle del plan' });
    }
};

const createLayawayPlan = async (req, res) => {
    const { 
        customer_name, customer_id_doc, customer_contact, 
        total_value, down_payment, deadline, products,
        iva_rate = 0, iva_amount = 0 
    } = req.body;
    
    if (!products || !Array.isArray(products) || products.length === 0) {
        return res.status(400).json({ msg: 'La lista de productos no puede estar vacía.' });
    }

    const balance_due = total_value - down_payment;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        for (const product of products) {
            const [[dbProduct]] = await connection.query('SELECT quantity, name FROM products WHERE id = ? FOR UPDATE', [product.product_id]);
            if (!dbProduct || dbProduct.quantity < product.quantity) {
                await connection.rollback();
                return res.status(400).json({ msg: `Stock insuficiente para el producto: ${dbProduct.name}` });
            }
        }

        const [planResult] = await connection.query(
            'INSERT INTO layaway_plans (customer_name, customer_id_doc, customer_contact, total_value, down_payment, balance_due, deadline, iva_rate, iva_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [customer_name, customer_id_doc, customer_contact, total_value, down_payment, balance_due, deadline, iva_rate, iva_amount]
        );
        
        const planId = planResult.insertId;

        const detailQueries = products.map(product => {
            return connection.query(
                'INSERT INTO layaway_plan_details (layaway_plan_id, product_id, quantity) VALUES (?, ?, ?)',
                [planId, product.product_id, product.quantity]
            );
        });
        await Promise.all(detailQueries);

        // --- INICIO DE LA MODIFICACIÓN ---
        // Se registra el abono inicial junto con la referencia directa al plan (layaway_plan_id).
        if (down_payment > 0) {
            await connection.query(
                'INSERT INTO financial_ledger (entry_date, concept, income, layaway_plan_id) VALUES (CURDATE(), ?, ?, ?)',
                [`Abono inicial Plan #${planId} - ${customer_name}`, down_payment, planId]
            );
        }
        // --- FIN DE LA MODIFICACIÓN ---

        await connection.commit();
        const [newPlan] = await pool.query('SELECT * FROM layaway_plans WHERE id = ?', [planId]);
        await logAction(req.uid, `Creó un plan separe (ID: ${planId}) para el cliente ${customer_name}`);
        res.status(201).json(newPlan[0]);

    } catch (error) {
        await connection.rollback();
        console.error("Error detallado al crear plan separe:", error);
        res.status(500).json({ msg: 'Error interno al guardar los detalles del plan.', error: error.message });
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
        
        let newStatus = plan.status;
        
        if (new_payment_amount && !isNaN(new_payment_amount) && new_payment_amount > 0) {
            const payment = parseFloat(new_payment_amount);
            let { down_payment, balance_due, customer_name } = plan;

            down_payment = parseFloat(down_payment) + payment;
            balance_due = parseFloat(balance_due) - payment;

            if (balance_due <= 0) {
                newStatus = 'completed';
                balance_due = 0;
            }

            await connection.query(
                'UPDATE layaway_plans SET down_payment = ?, balance_due = ?, status = ? WHERE id = ?',
                [down_payment, balance_due, newStatus, id]
            );

            // --- INICIO DE LA MODIFICACIÓN ---
            // Se registra el abono con la referencia directa al plan (layaway_plan_id).
            const [ledgerResult] = await connection.query(
                'INSERT INTO financial_ledger (entry_date, concept, income, layaway_plan_id) VALUES (CURDATE(), ?, ?, ?)',
                [`Abono a Plan #${id} - ${customer_name}`, payment, id]
            );
            const ledgerEntryId = ledgerResult.insertId;
            // --- FIN DE LA MODIFICACIÓN ---

            if (newStatus === 'completed') {
                const [[customer]] = await connection.query(
                    'SELECT id FROM customers WHERE full_name = ? OR id_document = ? LIMIT 1',
                    [plan.customer_name, plan.customer_id_doc]
                );
                const customerId = customer ? customer.id : null;

                const [saleResult] = await connection.query(
                    `INSERT INTO sales (user_id, customer_id, total_amount, discount, created_at, iva_rate, iva_amount, layaway_plan_id)
                     VALUES (?, ?, ?, ?, NOW(), ?, ?, ?)`,
                    [uid, customerId, plan.total_value, 0, plan.iva_rate, plan.iva_amount, id]
                );
                const newSaleId = saleResult.insertId;

                const [planDetails] = await connection.query(
                    `SELECT lpd.quantity, p.id as product_id, p.price, p.cost 
                     FROM layaway_plan_details lpd
                     JOIN products p ON lpd.product_id = p.id
                     WHERE lpd.layaway_plan_id = ?`,
                    [id]
                );
                
                for (const detail of planDetails) {
                    await connection.query(
                        `INSERT INTO sale_details (sale_id, product_id, quantity, unit_price, unit_cost)
                         VALUES (?, ?, ?, ?, ?)`,
                        [newSaleId, detail.product_id, detail.quantity, detail.price, detail.cost]
                    );
                }
                
                // --- INICIO DE LA MODIFICACIÓN ---
                // Se actualiza el abono final para incluir también la referencia a la venta (sale_id).
                await connection.query(
                    `UPDATE financial_ledger SET concept = ?, sale_id = ? WHERE id = ?`,
                    [`Cierre Plan #${id} (Venta #${newSaleId})`, newSaleId, ledgerEntryId]
                );
                // --- FIN DE LA MODIFICACIÓN ---
                
                await logAction(uid, `Completó el plan separe (ID: ${id}) y lo convirtió a Venta (ID: ${newSaleId})`);
            }
        }

        const [[updatedPlan]] = await connection.query('SELECT * FROM layaway_plans WHERE id = ?', [id]);
        await connection.commit();

        if (newStatus !== 'completed' && new_payment_amount > 0) {
             await logAction(uid, `Registró un abono al plan separe (ID: ${id}).`);
        }
        
        res.json(updatedPlan);
    } catch (error) {
        await connection.rollback();
        console.error("Error al actualizar el plan:", error);
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
        await connection.query('DELETE FROM layaway_plan_details WHERE layaway_plan_id = ?', [id]);
        await connection.query('DELETE FROM layaway_plans WHERE id = ?', [id]);
        await connection.commit();
        await logAction(uid, `Eliminó/Canceló el plan separe (ID: ${id})`);
        res.json({ msg: 'Plan separe eliminado y stock devuelto.' });
    } catch (error) {
        await connection.rollback();
        console.error("Error al eliminar plan separe:", error);
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