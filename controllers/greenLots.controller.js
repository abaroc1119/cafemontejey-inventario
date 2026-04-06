const pool = require('../db/database');
const { logAction } = require('../helpers/audit.helper');
const { roundCurrency, roundQty, registerInventoryMovement } = require('../services/inventory.service');

// ─── Listar lotes verdes ───────────────────────────────────────
const getGreenLots = async (req, res) => {
    const { page = 1, limit = 15, search = '', status = '' } = req.query;
    const offset = (page - 1) * limit;

    try {
        const searchTerm = `%${search}%`;
        let conditions = ['1=1'];
        const params = [];

        if (search) {
            conditions.push('(g.lot_code LIKE ? OR s.company_name LIKE ? OR g.notes LIKE ?)');
            params.push(searchTerm, searchTerm, searchTerm);
        }

        if (status && ['open', 'partial', 'distributed'].includes(status)) {
            conditions.push('g.status = ?');
            params.push(status);
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;

        const [lots] = await pool.query(
            `SELECT 
                g.*,
                s.company_name as supplier_name,
                (SELECT COUNT(*) FROM product_batches pb WHERE pb.green_lot_id = g.id) as child_batches_count
             FROM green_lot_entries g
             LEFT JOIN suppliers s ON g.supplier_id = s.id
             ${whereClause}
             ORDER BY g.entry_date DESC, g.id DESC
             LIMIT ? OFFSET ?`,
            [...params, parseInt(limit, 10), parseInt(offset, 10)]
        );

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) as total
             FROM green_lot_entries g
             LEFT JOIN suppliers s ON g.supplier_id = s.id
             ${whereClause}`,
            params
        );

        res.json({
            lots,
            totalPages: Math.ceil(total / limit),
            currentPage: parseInt(page, 10),
        });
    } catch (error) {
        console.error('Error al obtener lotes verdes:', error);
        res.status(500).json({ msg: 'Error al obtener los lotes de café verde' });
    }
};

// ─── Obtener un lote verde con sus distribuciones ──────────────
const getGreenLotById = async (req, res) => {
    const { id } = req.params;

    try {
        const [[lot]] = await pool.query(
            `SELECT g.*, s.company_name as supplier_name
             FROM green_lot_entries g
             LEFT JOIN suppliers s ON g.supplier_id = s.id
             WHERE g.id = ?`,
            [id]
        );

        if (!lot) {
            return res.status(404).json({ msg: 'Lote verde no encontrado.' });
        }

        const [childBatches] = await pool.query(
            `SELECT pb.*, p.name as product_name, p.sku as product_sku
             FROM product_batches pb
             JOIN products p ON pb.product_id = p.id
             WHERE pb.green_lot_id = ?
             ORDER BY pb.id ASC`,
            [id]
        );

        res.json({ ...lot, distributions: childBatches });
    } catch (error) {
        console.error('Error al obtener lote verde:', error);
        res.status(500).json({ msg: 'Error al obtener el lote verde' });
    }
};

// ─── Crear lote verde + distribución a productos ───────────────
const createGreenLot = async (req, res) => {
    const {
        supplier_id,
        entry_date,
        green_quantity_kg,
        green_total_cost,
        yield_percent = 80,
        delivery_cost_total = 0,
        trilla_cost_total = 0,
        roasting_cost_total = 0,
        notes,
        distributions = [],  // Array de { product_id, quantity, unit_weight_kg, margin_percent, molienda_cost, packaging_cost, bag_cost }
    } = req.body;

    const userId = req.uid;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // ── Validaciones básicas ──
        if (!green_quantity_kg || green_quantity_kg <= 0) {
            await connection.rollback();
            return res.status(400).json({ msg: 'Los kilogramos de café verde son obligatorios.' });
        }

        if (!green_total_cost || green_total_cost <= 0) {
            await connection.rollback();
            return res.status(400).json({ msg: 'El costo total del café verde es obligatorio.' });
        }

        if (!distributions || distributions.length === 0) {
            await connection.rollback();
            return res.status(400).json({ msg: 'Debes distribuir al menos una línea de producto.' });
        }

        const effectiveDate = entry_date || new Date().toISOString().split('T')[0];
        const yieldFraction = yield_percent > 1 ? yield_percent / 100 : yield_percent;
        const roastedKg = roundQty(green_quantity_kg * yieldFraction);

        // ── Validar que la distribución no exceda los kg tostados ──
        let totalDistributedKg = 0;
        for (const dist of distributions) {
            const unitWeightKg = dist.unit_weight_kg || 0;
            const qty = dist.quantity || 0;
            totalDistributedKg += unitWeightKg * qty;
        }
        totalDistributedKg = roundQty(totalDistributedKg);

        if (totalDistributedKg > roastedKg + 0.001) {
            await connection.rollback();
            return res.status(400).json({
                msg: `La distribución total (${totalDistributedKg} kg) excede los kg tostados disponibles (${roastedKg} kg).`,
            });
        }

        // ── Generar código de lote verde ──
        const dateStr = effectiveDate.replace(/-/g, '');
        const [[{ lotCount }]] = await connection.query(
            'SELECT COUNT(*) as lotCount FROM green_lot_entries WHERE DATE(entry_date) = ?',
            [effectiveDate]
        );
        const lotCode = `VERDE-${dateStr}-${String(lotCount + 1).padStart(3, '0')}`;

        // ── Determinar status ──
        const status = totalDistributedKg >= roastedKg - 0.001
            ? 'distributed'
            : totalDistributedKg > 0 ? 'partial' : 'open';

        // ── Insertar lote verde ──
        const [greenResult] = await connection.query(
            `INSERT INTO green_lot_entries 
             (supplier_id, entry_date, green_quantity_kg, green_total_cost, yield_percent,
              distributed_kg, delivery_cost_total, trilla_cost_total, roasting_cost_total, notes, lot_code, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                supplier_id || null,
                effectiveDate,
                roundQty(green_quantity_kg),
                roundCurrency(green_total_cost),
                roundQty(yield_percent > 1 ? yield_percent : yield_percent * 100),
                totalDistributedKg,
                roundCurrency(delivery_cost_total),
                roundCurrency(trilla_cost_total),
                roundCurrency(roasting_cost_total),
                notes || null,
                lotCode,
                status,
            ]
        );

        const greenLotId = greenResult.insertId;

        // ── Registrar gasto en ledger (costo del verde + flete + trilla + tostión) ──
        const baseCost = roundCurrency(green_total_cost)
            + roundCurrency(delivery_cost_total)
            + roundCurrency(trilla_cost_total)
            + roundCurrency(roasting_cost_total);

        if (baseCost > 0) {
            await connection.query(
                'INSERT INTO financial_ledger (entry_date, concept, expense) VALUES (?, ?, ?)',
                [effectiveDate, `Compra café verde - Lote ${lotCode} (${green_quantity_kg} kg)`, baseCost]
            );
        }

        // ── Costos base prorrateables por kg ──
        const baseCostPerKgRoasted = roastedKg > 0
            ? (roundCurrency(green_total_cost) + roundCurrency(delivery_cost_total) + roundCurrency(trilla_cost_total) + roundCurrency(roasting_cost_total)) / roastedKg
            : 0;

        // ── Crear lotes hijos (producto terminado) ──
        const createdBatches = [];

        for (let i = 0; i < distributions.length; i++) {
            const dist = distributions[i];

            const [[product]] = await connection.query(
                'SELECT id, name, sku FROM products WHERE id = ? AND is_active = TRUE',
                [dist.product_id]
            );

            if (!product) {
                await connection.rollback();
                return res.status(404).json({ msg: `Producto ID ${dist.product_id} no encontrado o inactivo.` });
            }

            const qty = parseInt(dist.quantity, 10);
            const unitWeightKg = parseFloat(dist.unit_weight_kg) || 0;
            const lineKg = roundQty(qty * unitWeightKg);
            const marginPercent = parseFloat(dist.margin_percent) || 40;
            const marginFraction = marginPercent > 1 ? marginPercent / 100 : marginPercent;

            // Costos específicos de esta línea (molienda, empaque, bolsa — trilla ya está en costos base)
            const lineMolienda = roundCurrency(dist.molienda_cost || 0);
            const linePackaging = roundCurrency(dist.packaging_cost || 0);
            const lineBag = roundCurrency(dist.bag_cost || 0);

            // Costo base proporcional al kg que consume esta línea
            const lineBaseCost = roundCurrency(baseCostPerKgRoasted * lineKg);

            // Costo total de esta línea
            const lineTotalCost = lineBaseCost + lineMolienda + linePackaging + lineBag;

            // Costos unitarios
            const costPerUnit = qty > 0 ? roundCurrency(lineTotalCost / qty) : 0;
            const costPerKg = lineKg > 0 ? roundCurrency(lineTotalCost / lineKg) : 0;

            // Precio sugerido
            const suggestedPrice = costPerUnit > 0 && marginFraction < 1
                ? roundCurrency(costPerUnit / (1 - marginFraction))
                : 0;

            // Generar batch_code
            const [[{ batchCount }]] = await connection.query(
                'SELECT COUNT(*) as batchCount FROM product_batches WHERE product_id = ? AND DATE(entry_date) = ?',
                [product.id, effectiveDate]
            );
            const batchCode = `${product.sku || `P${product.id}`}-${dateStr}-${String(batchCount + 1).padStart(3, '0')}`;

            const [batchResult] = await connection.query(
                `INSERT INTO product_batches (
                    product_id, supplier_id, green_lot_id, cost_per_unit,
                    initial_quantity, current_quantity, entry_date, batch_code, notes,
                    green_quantity_kg, green_total_cost, green_cost_per_kg,
                    yield_percent, roasted_quantity_kg,
                    delivery_cost_total, roasting_cost_total,
                    packaging_cost_total, bag_cost_total,
                    line_trilla_cost, line_molienda_cost, line_packaging_cost, line_bag_cost,
                    unit_weight_kg, final_cost_per_unit, final_cost_per_kg,
                    suggested_price, margin_percent
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    product.id,
                    supplier_id || null,
                    greenLotId,
                    costPerUnit,
                    qty,
                    qty,
                    effectiveDate,
                    batchCode,
                    dist.notes || `Derivado de lote verde ${lotCode}`,
                    // Datos del verde proporcional a esta línea
                    roundQty(lineKg / yieldFraction),  // green_quantity_kg proporcional
                    roundCurrency(lineBaseCost),         // green_total_cost proporcional (base)
                    roundCurrency(baseCostPerKgRoasted / yieldFraction), // green_cost_per_kg
                    roundQty(yield_percent > 1 ? yield_percent : yield_percent * 100),
                    lineKg,  // roasted_quantity_kg
                    // Costos compartidos prorrateados (ya incluidos en lineBaseCost)
                    0, 0,
                    // Costos del batch (empaque+bolsa genéricos)
                    linePackaging, lineBag,
                    // Costos específicos de línea (trilla=0 porque es costo base global)
                    0, lineMolienda, linePackaging, lineBag,
                    // Métricas
                    unitWeightKg,
                    costPerUnit,
                    costPerKg,
                    suggestedPrice,
                    roundQty(marginPercent),
                ]
            );

            // Registrar movimiento de inventario
            await registerInventoryMovement(connection, {
                product_id: product.id,
                batch_id: batchResult.insertId,
                movement_type: 'IN',
                quantity: qty,
                reference_type: 'green_lot_distribution',
                reference_id: greenLotId,
                notes: `Distribución desde lote verde ${lotCode} → ${product.name} (${qty} uds × ${dist.unit_weight_kg}kg)`,
            });

            // Registrar costos de procesamiento específicos en ledger si los hay
            const lineProcessingCost = lineMolienda + linePackaging + lineBag;
            if (lineProcessingCost > 0) {
                await connection.query(
                    'INSERT INTO financial_ledger (entry_date, concept, expense) VALUES (?, ?, ?)',
                    [effectiveDate, `Procesamiento ${product.name} - Lote ${batchCode} (${qty} uds): molienda/empaque/bolsa`, lineProcessingCost]
                );
            }

            createdBatches.push({
                batch_id: batchResult.insertId,
                batch_code: batchCode,
                product_name: product.name,
                quantity: qty,
                cost_per_unit: costPerUnit,
                suggested_price: suggestedPrice,
            });
        }

        await connection.commit();

        await logAction(userId,
            `Ingresó lote de café verde ${lotCode} (${green_quantity_kg} kg) → ` +
            createdBatches.map(b => `${b.quantity} uds ${b.product_name}`).join(', ')
        );

        res.status(201).json({
            msg: 'Lote verde registrado y distribuido correctamente.',
            green_lot_id: greenLotId,
            lot_code: lotCode,
            roasted_kg: roastedKg,
            distributed_kg: totalDistributedKg,
            batches: createdBatches,
        });

    } catch (error) {
        await connection.rollback();
        console.error('Error al crear lote verde:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ msg: 'Ya existe un lote con ese código.' });
        }
        res.status(500).json({ msg: error.message || 'Error al registrar el lote de café verde' });
    } finally {
        connection.release();
    }
};

// ─── Eliminar lote verde (solo si ningún hijo ha vendido) ──────
const deleteGreenLot = async (req, res) => {
    const { id } = req.params;
    const userId = req.uid;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [[lot]] = await connection.query(
            'SELECT * FROM green_lot_entries WHERE id = ?',
            [id]
        );

        if (!lot) {
            await connection.rollback();
            return res.status(404).json({ msg: 'Lote verde no encontrado.' });
        }

        // Verificar que ningún lote hijo haya vendido unidades
        const [childBatches] = await connection.query(
            'SELECT id, batch_code, initial_quantity, current_quantity, product_id FROM product_batches WHERE green_lot_id = ?',
            [id]
        );

        for (const child of childBatches) {
            if (child.current_quantity !== child.initial_quantity) {
                await connection.rollback();
                return res.status(400).json({
                    msg: `No se puede eliminar: el lote ${child.batch_code} ya tiene unidades vendidas.`
                });
            }
        }

        // Eliminar movimientos de inventario de los hijos
        for (const child of childBatches) {
            await connection.query(
                'DELETE FROM inventory_movements WHERE batch_id = ?',
                [child.id]
            );
        }

        // Eliminar lotes hijos
        await connection.query(
            'DELETE FROM product_batches WHERE green_lot_id = ?',
            [id]
        );

        // Eliminar lote verde
        await connection.query(
            'DELETE FROM green_lot_entries WHERE id = ?',
            [id]
        );

        await connection.commit();
        await logAction(userId, `Eliminó lote verde ${lot.lot_code} y sus ${childBatches.length} lotes derivados.`);
        res.json({ msg: 'Lote verde y sus derivados eliminados correctamente.' });

    } catch (error) {
        await connection.rollback();
        console.error('Error al eliminar lote verde:', error);
        res.status(500).json({ msg: 'Error al eliminar el lote verde' });
    } finally {
        connection.release();
    }
};

module.exports = {
    getGreenLots,
    getGreenLotById,
    createGreenLot,
    deleteGreenLot,
};
