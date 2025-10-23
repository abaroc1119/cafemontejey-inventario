const pool = require('../db/database');
const { logAction } = require('../helpers/audit.helper');

const getSales = async (req, res) => {
    const { page = 1, limit = 15, userId, startDate, endDate } = req.query;
    const offset = (page - 1) * limit;

    try {
        let params = [];
        let countParams = [];
        let whereConditions = [];

        if (userId) {
            whereConditions.push('s.user_id = ?');
            params.push(userId);
        }
        if (startDate && endDate) {
            whereConditions.push('s.created_at BETWEEN ? AND ?');
            params.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
        }
        
        countParams = [...params];

        const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

        const salesQuery = `
            SELECT 
                s.id, s.total_amount, s.discount, s.created_at, u.full_name as user_name,
                s.iva_rate, s.iva_amount,
                SUM(sd.quantity * sd.unit_cost) as total_cost
            FROM sales s
            JOIN users u ON s.user_id = u.id
            JOIN sale_details sd ON s.id = sd.sale_id
            ${whereClause}
            GROUP BY s.id
            ORDER BY s.created_at DESC
            LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));
        const [sales] = await pool.query(salesQuery, params);

        const countQuery = `
            SELECT COUNT(DISTINCT s.id) as total 
            FROM sales s
            JOIN users u ON s.user_id = u.id
            JOIN sale_details sd ON s.id = sd.sale_id
            ${whereClause}`;
        const [[{ total }]] = await pool.query(countQuery, countParams);

        res.json({
            sales,
            totalPages: Math.ceil(total / limit),
            currentPage: parseInt(page)
        });
    } catch (error) {
        console.error("Error al obtener las ventas:", error);
        res.status(500).json({ msg: 'Error al obtener las ventas' });
    }
};

const getSaleById = async (req, res) => {
    const { id } = req.params;
    try {
        const [[sale]] = await pool.query(
            `SELECT s.id, s.total_amount, s.discount, s.created_at, u.full_name as user_name, s.iva_rate, s.iva_amount, c.full_name as customer_name
             FROM sales s
             JOIN users u ON s.user_id = u.id
             LEFT JOIN customers c ON s.customer_id = c.id
             WHERE s.id = ?`, 
            [id]
        );

        if (!sale) {
            return res.status(404).json({ msg: 'Venta no encontrada' });
        }

        const [details] = await pool.query(
            `SELECT sd.quantity, sd.unit_price, sd.unit_cost, p.name as product_name, p.attributes
             FROM sale_details sd
             JOIN products p ON sd.product_id = p.id
             WHERE sd.sale_id = ?`,
            [id]
        );

        res.json({ ...sale, details });
    } catch (error) {
        console.error("Error al obtener el detalle de la venta:", error);
        res.status(500).json({ msg: 'Error al obtener el detalle de la venta' });
    }
};

const createSale = async (req, res) => {
    const { total_amount, products, discount = 0, customer_id = null, iva_rate = 0, iva_amount = 0 } = req.body;
    const userId = req.uid;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        for (const product of products) {
            const [[dbProduct]] = await connection.query('SELECT quantity, name, cost FROM products WHERE id = ? FOR UPDATE', [product.product_id]);
            if (!dbProduct || dbProduct.quantity < product.quantity) {
                await connection.rollback();
                return res.status(400).json({ msg: `Stock insuficiente para: ${dbProduct?.name || 'producto desconocido'}` });
            }
            product.cost = dbProduct.cost;
        }

        const [saleResult] = await connection.query(
            'INSERT INTO sales (user_id, customer_id, total_amount, discount, iva_rate, iva_amount) VALUES (?, ?, ?, ?, ?, ?)',
            [userId, customer_id, total_amount, discount, iva_rate, iva_amount]
        );
        const saleId = saleResult.insertId;

        for (const product of products) {
            await connection.query(
                'INSERT INTO sale_details (sale_id, product_id, quantity, unit_price, unit_cost) VALUES (?, ?, ?, ?, ?)',
                [saleId, product.product_id, product.quantity, product.unit_price, product.cost]
            );
        }

        const netIncome = parseFloat(total_amount) - parseFloat(iva_amount);
        
        // --- INICIO DE LA MODIFICACIÓN ---
        // Se inserta el ingreso neto junto con la referencia directa a la venta (sale_id).
        await connection.query(
            'INSERT INTO financial_ledger (entry_date, concept, income, sale_id) VALUES (CURDATE(), ?, ?, ?)',
            [`Venta #${saleId}`, netIncome, saleId]
        );
        // --- FIN DE LA MODIFICACIÓN ---
        
        await connection.commit();
        
        await logAction(userId, `Registró una venta (ID: ${saleId}) por un total de ${total_amount}.`);

        res.status(201).json({ msg: 'Venta creada exitosamente', saleId });

    } catch (error) {
        await connection.rollback();
        console.error("Error al crear la venta:", error);
        res.status(500).json({ msg: 'Error al procesar la venta' });
    } finally {
        connection.release();
    }
};

// ... (El resto del archivo, incluyendo bulkImportSales, se mantiene igual por ahora para no complicar el cambio)

const bulkImportSales = async (req, res) => {
    const { sales } = req.body;
    const userId = req.uid;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        let salesCreatedCount = 0;
        for (const sale of sales) {
            for (const product of sale.products) {
                const [[dbProduct]] = await connection.query('SELECT id, quantity, name, cost FROM products WHERE sku = ? FOR UPDATE', [product.product_sku]);
                if (!dbProduct) {
                    throw new Error(`El producto con SKU '${product.product_sku}' de la venta '${sale.sale_id}' no fue encontrado.`);
                }
                if (dbProduct.quantity < product.quantity) {
                    throw new Error(`Stock insuficiente para '${dbProduct.name}' (SKU: ${product.product_sku}) en la venta '${sale.sale_id}'.`);
                }
                product.product_id = dbProduct.id;
                product.cost = dbProduct.cost;
            }

            const [saleResult] = await connection.query(
                'INSERT INTO sales (user_id, total_amount, discount, created_at) VALUES (?, ?, ?, NOW())',
                [userId, sale.total_amount, sale.discount || 0]
            );
            const newSaleId = saleResult.insertId;

            for (const product of sale.products) {
                await connection.query(
                    'INSERT INTO sale_details (sale_id, product_id, quantity, unit_price, unit_cost) VALUES (?, ?, ?, ?, ?)',
                    [newSaleId, product.product_id, product.quantity, product.unit_price, product.cost]
                );
            }

            const finalAmount = sale.total_amount * (1 - ((sale.discount || 0) / 100));
            await connection.query(
                'INSERT INTO financial_ledger (entry_date, concept, income, sale_id) VALUES (CURDATE(), ?, ?, ?)',
                [`Venta importada #${newSaleId}`, finalAmount, newSaleId]
            );
            salesCreatedCount++;
        }

        await connection.commit();
        await logAction(userId, `Importó masivamente ${salesCreatedCount} ventas desde un archivo Excel.`);
        res.status(201).json({ msg: `${salesCreatedCount} ventas han sido importadas exitosamente.` });

    } catch (error) {
        await connection.rollback();
        console.error("Error en la importación masiva de ventas:", error);
        res.status(500).json({ msg: error.message || 'Ocurrió un error en el servidor durante la importación.' });
    } finally {
        connection.release();
    }
};

module.exports = { getSales, getSaleById, createSale, bulkImportSales };