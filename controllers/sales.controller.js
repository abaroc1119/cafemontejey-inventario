const pool = require('../db/database');
const { logAction } = require('../helpers/audit.helper');
const { registerInventoryMovement } = require('../services/inventory.service');

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
        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

        const salesQuery = `
            SELECT 
                s.id, s.total_amount, s.discount, s.created_at, u.full_name as user_name,
                s.iva_rate, s.iva_amount,
                SUM(sd.quantity * sd.unit_cost) as total_cost,
                (s.total_amount - s.iva_amount - SUM(sd.quantity * sd.unit_cost)) as profit
            FROM sales s
            JOIN users u ON s.user_id = u.id
            JOIN sale_details sd ON s.id = sd.sale_id
            ${whereClause}
            GROUP BY s.id
            ORDER BY s.created_at DESC
            LIMIT ? OFFSET ?`;
        params.push(parseInt(limit, 10), parseInt(offset, 10));
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
            currentPage: parseInt(page, 10),
        });
    } catch (error) {
        console.error('Error al obtener las ventas:', error);
        res.status(500).json({ msg: 'Error al obtener las ventas' });
    }
};

const getSaleById = async (req, res) => {
    const { id } = req.params;
    try {
        const [[sale]] = await pool.query(
            `SELECT s.id, s.total_amount, s.discount, s.created_at, u.full_name as user_name, 
                    s.iva_rate, s.iva_amount, c.full_name as customer_name
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
            `SELECT sd.quantity, sd.unit_price, sd.unit_cost, 
                    p.name as product_name, p.attributes,
                    pb.batch_code, sup.company_name as supplier_name
             FROM sale_details sd
             JOIN products p ON sd.product_id = p.id
             LEFT JOIN product_batches pb ON sd.batch_id = pb.id
             LEFT JOIN suppliers sup ON pb.supplier_id = sup.id
             WHERE sd.sale_id = ?`,
            [id]
        );

        res.json({ ...sale, details });
    } catch (error) {
        console.error('Error al obtener el detalle de la venta:', error);
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
            const [[batch]] = await connection.query(
                `SELECT pb.current_quantity, pb.cost_per_unit, p.name, p.id as product_id
                 FROM product_batches pb
                 JOIN products p ON pb.product_id = p.id
                 WHERE pb.id = ?
                 FOR UPDATE`,
                [product.batch_id]
            );

            if (!batch) {
                await connection.rollback();
                return res.status(400).json({ msg: `Lote no encontrado (ID: ${product.batch_id}).` });
            }

            if (batch.current_quantity < product.quantity) {
                await connection.rollback();
                return res.status(400).json({
                    msg: `Stock insuficiente en el lote seleccionado para: ${batch.name}. Disponible: ${batch.current_quantity}, Solicitado: ${product.quantity}`,
                });
            }

            product.cost = batch.cost_per_unit;
        }

        const [saleResult] = await connection.query(
            'INSERT INTO sales (user_id, customer_id, total_amount, discount, iva_rate, iva_amount) VALUES (?, ?, ?, ?, ?, ?)',
            [userId, customer_id, total_amount, discount, iva_rate, iva_amount]
        );
        const saleId = saleResult.insertId;

        for (const product of products) {
            await connection.query(
                'INSERT INTO sale_details (sale_id, product_id, batch_id, quantity, unit_price, unit_cost) VALUES (?, ?, ?, ?, ?, ?)',
                [saleId, product.product_id, product.batch_id, product.quantity, product.unit_price, product.cost]
            );

            await connection.query(
                'UPDATE product_batches SET current_quantity = current_quantity - ? WHERE id = ?',
                [product.quantity, product.batch_id]
            );

            await registerInventoryMovement(connection, {
                product_id: product.product_id,
                batch_id: product.batch_id,
                movement_type: 'OUT',
                quantity: product.quantity,
                reference_type: 'sale',
                reference_id: saleId,
                notes: `Salida por venta #${saleId}`,
            });
        }

        const netIncome = parseFloat(total_amount) - parseFloat(iva_amount);
        await connection.query(
            'INSERT INTO financial_ledger (entry_date, concept, income) VALUES (CURDATE(), ?, ?)',
            [`Venta (ID: ${saleId})`, netIncome]
        );

        await connection.commit();
        await logAction(userId, `Registró una venta (ID: ${saleId}) por un total de ${total_amount}.`);
        res.status(201).json({ msg: 'Venta creada exitosamente', saleId });
    } catch (error) {
        await connection.rollback();
        console.error('Error al crear la venta:', error);
        res.status(500).json({ msg: 'Error al procesar la venta' });
    } finally {
        connection.release();
    }
};

const bulkImportSales = async (req, res) => {
    const { sales } = req.body;
    const userId = req.uid;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        let salesCreatedCount = 0;
        for (const sale of sales) {
            for (const product of sale.products) {
                const [[dbProduct]] = await connection.query(
                    'SELECT id, name FROM products WHERE sku = ?',
                    [product.product_sku]
                );
                if (!dbProduct) {
                    throw new Error(`El producto con SKU '${product.product_sku}' no fue encontrado.`);
                }
                product.product_id = dbProduct.id;

                const [[batch]] = await connection.query(
                    `SELECT id, current_quantity, cost_per_unit 
                     FROM product_batches 
                     WHERE product_id = ? AND current_quantity >= ? 
                     ORDER BY entry_date ASC, id ASC 
                     LIMIT 1 FOR UPDATE`,
                    [dbProduct.id, product.quantity]
                );
                if (!batch) {
                    throw new Error(`Stock insuficiente en lotes para '${dbProduct.name}' (SKU: ${product.product_sku}).`);
                }
                product.batch_id = batch.id;
                product.cost = batch.cost_per_unit;
            }

            const [saleResult] = await connection.query(
                'INSERT INTO sales (user_id, total_amount, discount, created_at) VALUES (?, ?, ?, NOW())',
                [userId, sale.total_amount, sale.discount || 0]
            );
            const newSaleId = saleResult.insertId;

            for (const product of sale.products) {
                await connection.query(
                    'INSERT INTO sale_details (sale_id, product_id, batch_id, quantity, unit_price, unit_cost) VALUES (?, ?, ?, ?, ?, ?)',
                    [newSaleId, product.product_id, product.batch_id, product.quantity, product.unit_price, product.cost]
                );

                await connection.query(
                    'UPDATE product_batches SET current_quantity = current_quantity - ? WHERE id = ?',
                    [product.quantity, product.batch_id]
                );

                await registerInventoryMovement(connection, {
                    product_id: product.product_id,
                    batch_id: product.batch_id,
                    movement_type: 'OUT',
                    quantity: product.quantity,
                    reference_type: 'sale_import',
                    reference_id: newSaleId,
                    notes: `Salida por venta importada #${newSaleId}`,
                });
            }

            const finalAmount = sale.total_amount * (1 - ((sale.discount || 0) / 100));
            await connection.query(
                'INSERT INTO financial_ledger (entry_date, concept, income) VALUES (CURDATE(), ?, ?)',
                [`Venta importada (ID Archivo: ${sale.sale_id}, ID Sistema: ${newSaleId})`, finalAmount]
            );
            salesCreatedCount++;
        }

        await connection.commit();
        await logAction(userId, `Importó masivamente ${salesCreatedCount} ventas desde un archivo Excel.`);
        res.status(201).json({ msg: `${salesCreatedCount} ventas han sido importadas exitosamente.` });
    } catch (error) {
        await connection.rollback();
        console.error('Error en la importación masiva de ventas:', error);
        res.status(500).json({ msg: error.message || 'Ocurrió un error en el servidor durante la importación.' });
    } finally {
        connection.release();
    }
};

module.exports = { getSales, getSaleById, createSale, bulkImportSales };

async function deleteSale(req, res) {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const saleId = req.params.id;

    // 1. Obtener detalles de la venta
    const [details] = await connection.query(
      "SELECT * FROM sale_details WHERE sale_id = ?",
      [saleId]
    );

    if (details.length === 0) {
      throw new Error("Venta no encontrada o ya eliminada");
    }

    for (const d of details) {

      // 2. Devolver stock al lote
      await connection.query(`
        UPDATE product_batches
        SET current_quantity = current_quantity + ?
        WHERE id = ?
      `, [d.quantity, d.batch_id]);

      // 3. Registrar reversa en kardex
      await connection.query(`
        INSERT INTO inventory_movements
        (product_id, batch_id, movement_type, quantity, reference_type, reference_id, notes)
        VALUES (?, ?, 'IN', ?, 'sale_reversal', ?, 'Anulación de venta')
      `, [d.product_id, d.batch_id, d.quantity, saleId]);
    }

    // 4. Eliminar detalles
    await connection.query(
      "DELETE FROM sale_details WHERE sale_id = ?",
      [saleId]
    );

    // 5. Eliminar venta
    await connection.query(
      "DELETE FROM sales WHERE id = ?",
      [saleId]
    );

    await connection.commit();

    res.json({ message: "Venta anulada correctamente" });

  } catch (error) {
    await connection.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    connection.release();
  }
}


