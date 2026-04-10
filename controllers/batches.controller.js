const pool = require('../db/database');
const { logAction } = require('../helpers/audit.helper');
const { calculateBatchCosts, registerInventoryMovement, roundCurrency } = require('../services/inventory.service');

const baseBatchSelect = `
    SELECT 
        pb.id, pb.product_id, pb.supplier_id, pb.cost_per_unit,
        pb.initial_quantity, pb.current_quantity, pb.entry_date,
        pb.batch_code, pb.notes, pb.created_at,
        pb.green_quantity_kg, pb.green_total_cost, pb.green_cost_per_kg,
        pb.yield_percent, pb.roasted_quantity_kg,
        pb.delivery_cost_total, pb.roasting_cost_total,
        pb.packaging_cost_total, pb.bag_cost_total,
        pb.unit_weight_kg, pb.final_cost_per_unit,
        pb.final_cost_per_kg, pb.suggested_price, pb.margin_percent,
        s.company_name as supplier_name
    FROM product_batches pb
    LEFT JOIN suppliers s ON pb.supplier_id = s.id`;

const getBatchesByProduct = async (req, res) => {
    const { productId } = req.params;
    const { showEmpty = 'false' } = req.query;

    try {
        let query = `${baseBatchSelect} WHERE pb.product_id = ?`;
        if (showEmpty === 'false') {
            query += ' AND pb.current_quantity > 0';
        }
        query += ' ORDER BY pb.entry_date ASC, pb.id ASC';

        const [batches] = await pool.query(query, [productId]);
        res.json(batches);
    } catch (error) {
        console.error('Error al obtener lotes del producto:', error);
        res.status(500).json({ msg: 'Error al obtener los lotes del producto' });
    }
};

const getAllBatches = async (req, res) => {
    const { page = 1, limit = 15, search = '', showEmpty = 'false' } = req.query;
    const offset = (page - 1) * limit;

    try {
        const searchTerm = `%${search}%`;
        let conditions = ['p.is_active = TRUE'];
        const params = [];

        if (search) {
            conditions.push('(p.name LIKE ? OR p.sku LIKE ? OR pb.batch_code LIKE ? OR s.company_name LIKE ?)');
            params.push(searchTerm, searchTerm, searchTerm, searchTerm);
        }

        if (showEmpty === 'false') {
            conditions.push('pb.current_quantity > 0');
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const [batches] = await pool.query(
            `SELECT 
                pb.id, pb.product_id, pb.supplier_id, pb.cost_per_unit,
                pb.initial_quantity, pb.current_quantity, pb.entry_date,
                pb.batch_code, pb.notes, pb.created_at,
                pb.green_quantity_kg, pb.green_total_cost, pb.green_cost_per_kg,
                pb.yield_percent, pb.roasted_quantity_kg,
                pb.delivery_cost_total, pb.roasting_cost_total,
                pb.packaging_cost_total, pb.bag_cost_total,
                pb.unit_weight_kg, pb.final_cost_per_unit,
                pb.final_cost_per_kg, pb.suggested_price, pb.margin_percent,
                p.name as product_name, p.sku as product_sku,
                s.company_name as supplier_name
             FROM product_batches pb
             JOIN products p ON pb.product_id = p.id
             LEFT JOIN suppliers s ON pb.supplier_id = s.id
             ${whereClause}
             ORDER BY pb.entry_date DESC, pb.id DESC
             LIMIT ? OFFSET ?`,
            [...params, parseInt(limit, 10), parseInt(offset, 10)]
        );

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) as total
             FROM product_batches pb
             JOIN products p ON pb.product_id = p.id
             LEFT JOIN suppliers s ON pb.supplier_id = s.id
             ${whereClause}`,
            params
        );

        res.json({
            batches,
            totalPages: Math.ceil(total / limit),
            currentPage: parseInt(page, 10),
        });
    } catch (error) {
        console.error('Error al obtener lotes:', error);
        res.status(500).json({ msg: 'Error al obtener los lotes' });
    }
};

const createBatch = async (req, res) => {
    const {
        product_id,
        supplier_id,
        cost_per_unit,
        quantity,
        entry_date,
        notes,
        green_quantity_kg,
        green_total_cost,
        yield_percent,
        delivery_cost_total,
        roasting_cost_total,
        packaging_cost_total,
        bag_cost_total,
        unit_weight_kg,
        margin_percent,
    } = req.body;

    const userId = req.uid;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [[product]] = await connection.query(
            'SELECT id, name, sku FROM products WHERE id = ? AND is_active = TRUE',
            [product_id]
        );

        if (!product) {
            await connection.rollback();
            return res.status(404).json({ msg: 'Producto no encontrado o inactivo.' });
        }

        const calculated = calculateBatchCosts({
            quantity,
            green_quantity_kg,
            green_total_cost,
            yield_percent,
            delivery_cost_total,
            roasting_cost_total,
            packaging_cost_total,
            bag_cost_total,
            unit_weight_kg,
            margin_percent,
        });

        const resolvedCostPerUnit = calculated.final_cost_per_unit > 0
            ? calculated.final_cost_per_unit
            : roundCurrency(cost_per_unit);

        if (!quantity || !entry_date || resolvedCostPerUnit <= 0) {
            await connection.rollback();
            return res.status(400).json({
                msg: 'Producto, cantidad, fecha y un costo unitario válido son obligatorios.'
            });
        }

        const effectiveDate = entry_date || new Date().toISOString().split('T')[0];
        const dateStr = effectiveDate.replace(/-/g, '');
        const [[{ batchCount }]] = await connection.query(
            'SELECT COUNT(*) as batchCount FROM product_batches WHERE product_id = ? AND DATE(entry_date) = ?',
            [product_id, effectiveDate]
        );
        const batchCode = `${product.sku || `P${product_id}`}-${dateStr}-${String(batchCount + 1).padStart(3, '0')}`;

        const [result] = await connection.query(
            `INSERT INTO product_batches (
                product_id, supplier_id, cost_per_unit, initial_quantity, current_quantity, entry_date, batch_code, notes,
                green_quantity_kg, green_total_cost, green_cost_per_kg, yield_percent, roasted_quantity_kg,
                delivery_cost_total, roasting_cost_total, packaging_cost_total, bag_cost_total,
                unit_weight_kg, final_cost_per_unit, final_cost_per_kg, suggested_price, margin_percent
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                product_id,
                supplier_id || null,
                resolvedCostPerUnit,
                parseInt(quantity, 10),
                parseInt(quantity, 10),
                effectiveDate,
                batchCode,
                notes || null,
                calculated.green_quantity_kg || null,
                calculated.green_total_cost || null,
                calculated.green_cost_per_kg || null,
                calculated.yield_percent || null,
                calculated.roasted_quantity_kg || null,
                calculated.delivery_cost_total || null,
                calculated.roasting_cost_total || null,
                calculated.packaging_cost_total || null,
                calculated.bag_cost_total || null,
                calculated.unit_weight_kg || null,
                calculated.final_cost_per_unit || resolvedCostPerUnit,
                calculated.final_cost_per_kg || null,
                calculated.suggested_price || null,
                calculated.margin_percent || null,
            ]
        );

        const totalLotCost = calculated.final_lot_cost > 0
            ? calculated.final_lot_cost
            : resolvedCostPerUnit * parseInt(quantity, 10);

        if (totalLotCost > 0) {
            await connection.query(
                'INSERT INTO financial_ledger (entry_date, concept, expense) VALUES (?, ?, ?)',
                [effectiveDate, `Compra/producción de inventario: ${product.name} - Lote ${batchCode} (${quantity} uds)`, totalLotCost]
            );
        }

        await registerInventoryMovement(connection, {
            product_id,
            batch_id: result.insertId,
            movement_type: 'IN',
            quantity: parseInt(quantity, 10),
            reference_type: 'batch_entry',
            reference_id: result.insertId,
            notes: `Ingreso lote ${batchCode}`,
        });

        await connection.commit();

        const [[newBatch]] = await pool.query(
            `SELECT 
                pb.*, s.company_name as supplier_name, p.name as product_name, p.sku as product_sku
             FROM product_batches pb
             LEFT JOIN suppliers s ON pb.supplier_id = s.id
             JOIN products p ON pb.product_id = p.id
             WHERE pb.id = ?`,
            [result.insertId]
        );

        await logAction(userId, `Registró lote de inventario: ${quantity} uds de '${product.name}' (Lote: ${batchCode})`);
        res.status(201).json(newBatch);
    } catch (error) {
        await connection.rollback();
        console.error('Error al crear lote:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ msg: 'Ya existe un lote con ese código.' });
        }
        if (error.code === 'ER_BAD_FIELD_ERROR') {
            return res.status(500).json({ msg: 'Faltan columnas de costos por lote en la base de datos. Ejecuta primero la migración SQL.' });
        }
        res.status(500).json({ msg: 'Error al registrar el lote de inventario' });
    } finally {
        connection.release();
    }
};

const updateBatch = async (req, res) => {
    const { id } = req.params;
    const {
        supplier_id, cost_per_unit, notes, entry_date,
        margin_percent, suggested_price,
        packaging_cost_total, bag_cost_total,
        line_trilla_cost, line_molienda_cost, line_packaging_cost, line_bag_cost,
    } = req.body;
    const userId = req.uid;

    try {
        // Obtener lote actual
        const [[batch]] = await pool.query(
            `SELECT pb.*, p.name as product_name, p.sku as product_sku
             FROM product_batches pb
             JOIN products p ON pb.product_id = p.id
             WHERE pb.id = ?`,
            [id]
        );

        if (!batch) {
            return res.status(404).json({ msg: 'Lote no encontrado.' });
        }

        // Construir SET dinámico solo con campos que vienen en el body
        const updates = [];
        const params = [];

        if (supplier_id !== undefined) { updates.push('supplier_id = ?'); params.push(supplier_id || null); }
        if (notes !== undefined) { updates.push('notes = ?'); params.push(notes || null); }
        if (cost_per_unit !== undefined) { updates.push('cost_per_unit = ?'); params.push(roundCurrency(cost_per_unit)); }
        if (entry_date !== undefined) { updates.push('entry_date = ?'); params.push(entry_date); }
        if (margin_percent !== undefined) { updates.push('margin_percent = ?'); params.push(parseFloat(margin_percent)); }
        if (suggested_price !== undefined) { updates.push('suggested_price = ?'); params.push(roundCurrency(suggested_price)); }
        if (packaging_cost_total !== undefined) { updates.push('packaging_cost_total = ?'); params.push(roundCurrency(packaging_cost_total)); }
        if (bag_cost_total !== undefined) { updates.push('bag_cost_total = ?'); params.push(roundCurrency(bag_cost_total)); }
        if (line_trilla_cost !== undefined) { updates.push('line_trilla_cost = ?'); params.push(roundCurrency(line_trilla_cost)); }
        if (line_molienda_cost !== undefined) { updates.push('line_molienda_cost = ?'); params.push(roundCurrency(line_molienda_cost)); }
        if (line_packaging_cost !== undefined) { updates.push('line_packaging_cost = ?'); params.push(roundCurrency(line_packaging_cost)); }
        if (line_bag_cost !== undefined) { updates.push('line_bag_cost = ?'); params.push(roundCurrency(line_bag_cost)); }

        // Recalcular costo por unidad si se cambian costos de línea
        if (line_molienda_cost !== undefined || line_packaging_cost !== undefined || line_bag_cost !== undefined) {
            const molienda = line_molienda_cost !== undefined ? parseFloat(line_molienda_cost) : parseFloat(batch.line_molienda_cost || 0);
            const packaging = line_packaging_cost !== undefined ? parseFloat(line_packaging_cost) : parseFloat(batch.line_packaging_cost || 0);
            const bag = line_bag_cost !== undefined ? parseFloat(line_bag_cost) : parseFloat(batch.line_bag_cost || 0);

            // Costo base proporcional (verde+flete+trilla+tostión ya prorrateado)
            const baseGreenCost = parseFloat(batch.green_total_cost || 0);
            const lineTotalCost = baseGreenCost + molienda + packaging + bag;
            const qty = batch.initial_quantity;

            if (qty > 0) {
                const newCostPerUnit = roundCurrency(lineTotalCost / qty);
                updates.push('cost_per_unit = ?'); params.push(newCostPerUnit);
                updates.push('final_cost_per_unit = ?'); params.push(newCostPerUnit);

                const unitWeightKg = parseFloat(batch.unit_weight_kg || 0);
                const totalKg = qty * unitWeightKg;
                if (totalKg > 0) {
                    updates.push('final_cost_per_kg = ?'); params.push(roundCurrency(lineTotalCost / totalKg));
                }

                // Recalcular precio sugerido si hay margen
                const margin = margin_percent !== undefined ? parseFloat(margin_percent) : parseFloat(batch.margin_percent || 40);
                const marginFraction = margin > 1 ? margin / 100 : margin;
                if (newCostPerUnit > 0 && marginFraction < 1) {
                    const newSuggested = roundCurrency(newCostPerUnit / (1 - marginFraction));
                    updates.push('suggested_price = ?'); params.push(newSuggested);
                }
            }
        }

        if (updates.length === 0) {
            return res.status(400).json({ msg: 'No se proporcionaron campos para actualizar.' });
        }

        params.push(id);
        await pool.query(`UPDATE product_batches SET ${updates.join(', ')} WHERE id = ?`, params);

        const [[updatedBatch]] = await pool.query(
            `SELECT pb.*, s.company_name as supplier_name, p.name as product_name, p.sku as product_sku
             FROM product_batches pb
             LEFT JOIN suppliers s ON pb.supplier_id = s.id
             JOIN products p ON pb.product_id = p.id
             WHERE pb.id = ?`,
            [id]
        );

        await logAction(userId, `Editó el lote ${updatedBatch.batch_code} del producto '${updatedBatch.product_name}'`);
        res.json(updatedBatch);
    } catch (error) {
        console.error('Error al actualizar lote:', error);
        res.status(500).json({ msg: 'Error al actualizar el lote' });
    }
};

const deleteBatch = async (req, res) => {
    const { id } = req.params;
    const userId = req.uid;

    try {
        const [[batch]] = await pool.query(
            'SELECT pb.*, p.name as product_name FROM product_batches pb JOIN products p ON pb.product_id = p.id WHERE pb.id = ?',
            [id]
        );

        if (!batch) {
            return res.status(404).json({ msg: 'Lote no encontrado.' });
        }

        if (batch.current_quantity !== batch.initial_quantity) {
            return res.status(400).json({
                msg: 'No se puede eliminar un lote del cual ya se han vendido o apartado unidades. Solo puedes eliminarlo si no se ha movido inventario.'
            });
        }

        await pool.query('DELETE FROM product_batches WHERE id = ?', [id]);
        await logAction(userId, `Eliminó el lote ${batch.batch_code} del producto '${batch.product_name}'`);
        res.json({ msg: 'Lote eliminado correctamente.' });
    } catch (error) {
        console.error('Error al eliminar lote:', error);
        res.status(500).json({ msg: 'Error al eliminar el lote' });
    }
};

const bulkImportBatches = async (req, res) => {
    const { batches } = req.body;
    const userId = req.uid;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [products] = await connection.query('SELECT id, sku, name FROM products WHERE is_active = TRUE');
        const productMap = new Map(products.map((p) => [p.sku?.toUpperCase(), p]));

        const [suppliers] = await connection.query('SELECT id, nit, company_name FROM suppliers');
        const supplierMap = new Map(suppliers.map((s) => [s.nit?.toUpperCase(), s]));

        let createdCount = 0;

        for (const batch of batches) {
            const product = productMap.get(batch.SKU?.toUpperCase());
            if (!product) {
                throw new Error(`Producto con SKU '${batch.SKU}' no encontrado.`);
            }

            let supplierId = null;
            if (batch.NIT_PROVEEDOR) {
                const supplier = supplierMap.get(batch.NIT_PROVEEDOR.toString().toUpperCase());
                if (supplier) supplierId = supplier.id;
            }

            const entryDate = batch.FECHA_INGRESO || new Date().toISOString().split('T')[0];
            const dateStr = entryDate.replace(/-/g, '');
            const [[{ batchCount }]] = await connection.query(
                'SELECT COUNT(*) as batchCount FROM product_batches WHERE product_id = ? AND DATE(entry_date) = ?',
                [product.id, entryDate]
            );
            const batchCode = `${product.sku}-${dateStr}-${String(batchCount + 1).padStart(3, '0')}`;

            const [insertResult] = await connection.query(
                `INSERT INTO product_batches 
                 (product_id, supplier_id, cost_per_unit, initial_quantity, current_quantity, entry_date, batch_code, notes) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [product.id, supplierId, batch.COSTO || 0, batch.CANTIDAD, batch.CANTIDAD, entryDate, batchCode, batch.NOTAS || null]
            );

            await registerInventoryMovement(connection, {
                product_id: product.id,
                batch_id: insertResult.insertId,
                movement_type: 'IN',
                quantity: parseInt(batch.CANTIDAD, 10),
                reference_type: 'batch_import',
                reference_id: insertResult.insertId,
                notes: `Ingreso masivo lote ${batchCode}`,
            });

            createdCount++;
        }

        await connection.commit();
        await logAction(userId, `Importó masivamente ${createdCount} lotes de inventario desde Excel.`);
        res.status(201).json({ msg: `${createdCount} lotes importados exitosamente.` });
    } catch (error) {
        await connection.rollback();
        console.error('Error en importación masiva de lotes:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ msg: 'El archivo contiene códigos de lote duplicados.' });
        }
        res.status(500).json({ msg: error.message || 'Error durante la importación de lotes.' });
    } finally {
        connection.release();
    }
};

module.exports = {
    getBatchesByProduct,
    getAllBatches,
    createBatch,
    updateBatch,
    deleteBatch,
    bulkImportBatches,
};
