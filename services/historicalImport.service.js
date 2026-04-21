/**
 * services/historicalImport.service.js
 *
 * Lógica de reimportación histórica de lotes para el Excel de Montejey.
 *
 * Este servicio:
 *   1. Valida una estructura "canónica" de filas recibidas desde el frontend
 *      (después de parsear el .xlsx en el navegador con SheetJS).
 *   2. Permite hacer un DRY-RUN (previsualización con totales) antes de
 *      tocar la base de datos.
 *   3. Al ejecutarse "en firme": elimina datos operativos, crea los 40
 *      lotes, 40 ventas y 40 comisiones correspondientes.
 *
 * MUY IMPORTANTE: la destrucción de datos solo ocurre cuando el caller
 *                 envía explícitamente `confirmText === 'BORRAR'`.
 */

const pool = require('../db/database');
const { registerInventoryMovement, roundCurrency } = require('./inventory.service');
const { logAction } = require('../helpers/audit.helper');

// ---------------------------------------------------------------------
// Catálogo canónico de SKUs que la plantilla puede producir.
// Se usa para asegurar que los productos existan antes de importar.
// ---------------------------------------------------------------------
const MONTEJEY_SKUS = [
    { sku: 'MONT-TRAD-500', name: 'Montejey Tradicional 500g', unit_weight_kg: 0.5, kind: 'tradicional' },
    { sku: 'MONT-TRAD-250', name: 'Montejey Tradicional 250g', unit_weight_kg: 0.25, kind: 'tradicional' },
    { sku: 'MONT-BOUR-500', name: 'Montejey Bourbon Rosado 500g', unit_weight_kg: 0.5, kind: 'bourbon' },
    { sku: 'MONT-BOUR-250', name: 'Montejey Bourbon Rosado 250g', unit_weight_kg: 0.25, kind: 'bourbon' },
    { sku: 'MONT-CHIR-250', name: 'Montejey Chiroso 250g', unit_weight_kg: 0.25, kind: 'chiroso' },
    { sku: 'MONT-FROJ-500', name: 'Montejey Frutos Rojos 500g', unit_weight_kg: 0.5, kind: 'frutos_rojos' },
    { sku: 'MONT-FROJ-250', name: 'Montejey Frutos Rojos 250g', unit_weight_kg: 0.25, kind: 'frutos_rojos' },
];

/**
 * Dada la nota/nombre del lote, decide a qué "kind" corresponde.
 *   - "bourbon" => LOTES Bourbon Rosado
 *   - "chiroso" => LOTES Chiroso
 *   - "frutos_rojos" => LOTES Frutos Rojos
 *   - "tradicional" => todo lo demás
 */
const detectLotKind = (nombre = '', notas = '') => {
    const str = `${nombre || ''} ${notas || ''}`.toLowerCase();
    if (str.includes('bourbon')) return 'bourbon';
    if (str.includes('chiroso')) return 'chiroso';
    if (str.includes('frutos rojos') || str.includes('frutos_rojos')) return 'frutos_rojos';
    return 'tradicional';
};

/**
 * Devuelve el SKU correcto para la presentación (500 o 250) y el kind.
 * No todos los kinds tienen las 2 presentaciones (p.ej. Chiroso solo 250g);
 * cuando no existe, devuelve null y el importador lo trata como advertencia.
 */
const skuFor = (kind, presentacion) => {
    if (kind === 'tradicional') {
        return presentacion === 500 ? 'MONT-TRAD-500' : 'MONT-TRAD-250';
    }
    if (kind === 'bourbon') {
        return presentacion === 500 ? 'MONT-BOUR-500' : 'MONT-BOUR-250';
    }
    if (kind === 'chiroso') {
        return presentacion === 250 ? 'MONT-CHIR-250' : null;
    }
    if (kind === 'frutos_rojos') {
        return presentacion === 500 ? 'MONT-FROJ-500' : 'MONT-FROJ-250';
    }
    return null;
};

// ---------------------------------------------------------------------
// Validación + normalización de las filas recibidas
// ---------------------------------------------------------------------
/**
 * @param {Array<Object>} rows - Cada objeto debe tener las llaves:
 *   {
 *     lote: string,
 *     fecha: 'YYYY-MM-DD',
 *     bolsas_500: number,  (opcional, default 0)
 *     bolsas_250: number,  (opcional, default 0)
 *     precio_500: number,
 *     precio_250: number,
 *     total_ventas: number,   // lo que realmente se cobró
 *     costo_produccion: number,
 *     notas: string,
 *   }
 */
const validateAndNormalize = (rows) => {
    if (!Array.isArray(rows) || !rows.length) {
        throw new Error('No se recibieron filas para importar.');
    }

    const normalized = [];
    const warnings = [];

    rows.forEach((r, idx) => {
        const rowNum = idx + 1;
        const lote = String(r.lote || '').trim();
        const fecha = String(r.fecha || '').trim();

        if (!lote)  throw new Error(`Fila ${rowNum}: falta el nombre del lote.`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
            throw new Error(`Fila ${rowNum} (${lote}): fecha inválida "${fecha}". Usa formato YYYY-MM-DD.`);
        }

        const b500 = Number(r.bolsas_500 || 0) || 0;
        const b250 = Number(r.bolsas_250 || 0) || 0;
        const p500 = Number(r.precio_500 || 0) || 0;
        const p250 = Number(r.precio_250 || 0) || 0;
        const totalVentas = Number(r.total_ventas || 0) || 0;
        const costo = Number(r.costo_produccion || 0) || 0;
        const notas = String(r.notas || '').trim();

        if (b500 + b250 <= 0) {
            throw new Error(`Fila ${rowNum} (${lote}): no tiene bolsas (500g ni 250g).`);
        }

        const totalCalculado = b500 * p500 + b250 * p250;
        const diferencia = roundCurrency(totalVentas - totalCalculado); // comisión según el usuario

        const kind = detectLotKind(lote, notas);

        // Chiroso solo tiene 250g: si hubiera 500g en un lote chiroso, es un error del dato.
        if (kind === 'chiroso' && b500 > 0) {
            throw new Error(`Fila ${rowNum} (${lote}): es "Chiroso" y solo puede tener bolsas de 250g. Tiene ${b500} de 500g.`);
        }

        if (kind === 'frutos_rojos' && b500 > 0 && b250 > 0) {
            warnings.push(`Fila ${rowNum} (${lote}): Frutos Rojos con 500g y 250g. Se crearán dos ventas.`);
        }

        normalized.push({
            row: rowNum,
            lote,
            fecha,
            bolsas_500: b500,
            bolsas_250: b250,
            precio_500: p500,
            precio_250: p250,
            total_ventas: totalVentas,
            total_calculado: totalCalculado,
            comision: diferencia,
            costo_produccion: costo,
            notas,
            kind,
            sku_500: skuFor(kind, 500),
            sku_250: skuFor(kind, 250),
        });
    });

    // Totales
    const totals = normalized.reduce((acc, r) => {
        acc.total_500 += r.bolsas_500;
        acc.total_250 += r.bolsas_250;
        acc.total_ventas += r.total_ventas;
        acc.total_calculado += r.total_calculado;
        acc.total_comision += r.comision;
        acc.total_costo += r.costo_produccion;
        return acc;
    }, { total_500: 0, total_250: 0, total_ventas: 0, total_calculado: 0, total_comision: 0, total_costo: 0 });

    return { rows: normalized, warnings, totals };
};

// ---------------------------------------------------------------------
// Asegura que existen los 7 SKUs de Montejey. Crea los faltantes.
// ---------------------------------------------------------------------
const ensureMontejeySkus = async (connection) => {
    const skuMap = new Map(); // sku -> product row

    for (const def of MONTEJEY_SKUS) {
        const [[existing]] = await connection.query(
            'SELECT id, sku, name FROM products WHERE sku = ?', [def.sku]
        );
        if (existing) {
            skuMap.set(def.sku, existing);
            continue;
        }

        // Crear producto con los campos mínimos. Los campos opcionales
        // (category_id, description, attributes...) quedan como null/{}.
        const [result] = await connection.query(
            `INSERT INTO products (name, sku, description, price, attributes, is_active)
             VALUES (?, ?, ?, ?, ?, TRUE)`,
            [def.name, def.sku, `Creado automáticamente por reimportación histórica (${def.kind})`,
             0, JSON.stringify({ kind: def.kind, unit_weight_kg: def.unit_weight_kg })]
        );
        skuMap.set(def.sku, { id: result.insertId, sku: def.sku, name: def.name });
    }

    return skuMap;
};

// ---------------------------------------------------------------------
// Limpia las tablas operativas antes de recargar el histórico.
// NO toca: users, roles, suppliers, categories, customers, sellers, products.
//
// IMPORTANTE: se usa DELETE (no TRUNCATE) porque TRUNCATE hace commit
// implícito en MySQL y rompe la transacción. DELETE es reversible vía
// ROLLBACK si algo falla después.
// ---------------------------------------------------------------------
const wipeOperationalData = async (connection) => {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');

    // Orden ideal: primero hijos, luego padres (aunque con FK_CHECKS=0 no importa)
    const tables = [
        'commissions',
        'sale_details',
        'sales',
        'inventory_movements',
        'financial_ledger',
        'product_batches',
        // Green lots (si existen) los reseteamos también
        'green_lot_batches',
        'green_lots',
    ];

    const cleared = [];
    for (const t of tables) {
        try {
            // DELETE es más lento pero sí entra en la transacción actual.
            await connection.query(`DELETE FROM ${t}`);
            // Reseteamos AUTO_INCREMENT para que los IDs queden "limpios" tras commit
            // (esto sí hace commit implícito, pero nos interesa solo si el DELETE fue OK)
            cleared.push(t);
        } catch (e) {
            if (e.code === 'ER_NO_SUCH_TABLE') continue;
            throw e;
        }
    }

    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    return cleared;
};

// Reinicia AUTO_INCREMENT de las tablas vaciadas. Se llama DESPUÉS del commit
// porque ALTER TABLE genera commit implícito.
const resetAutoIncrement = async (connection, tables) => {
    for (const t of tables) {
        try {
            await connection.query(`ALTER TABLE ${t} AUTO_INCREMENT = 1`);
        } catch {
            // silencioso - no crítico
        }
    }
};

// ---------------------------------------------------------------------
// Construye las filas que irán a la BD a partir del Excel normalizado.
// Retorna para cada fila un plan con:
//   - batches a crear (1 por fila, con prorrateo si hay mezcla 500/250)
//   - ventas a registrar
//   - comisión asociada
// ---------------------------------------------------------------------
const buildPlan = (normalizedRows, skuMap, sellerId) => {
    return normalizedRows.map((r) => {
        // Determinamos las "líneas" presentes en el lote
        const lines = [];
        if (r.bolsas_500 > 0 && r.sku_500) {
            lines.push({
                presentation: 500,
                sku: r.sku_500,
                product_id: skuMap.get(r.sku_500).id,
                quantity: r.bolsas_500,
                unit_price: r.precio_500,
                unit_weight_kg: 0.5,
                line_sales: r.bolsas_500 * r.precio_500,
            });
        }
        if (r.bolsas_250 > 0 && r.sku_250) {
            lines.push({
                presentation: 250,
                sku: r.sku_250,
                product_id: skuMap.get(r.sku_250).id,
                quantity: r.bolsas_250,
                unit_price: r.precio_250,
                unit_weight_kg: 0.25,
                line_sales: r.bolsas_250 * r.precio_250,
            });
        }

        // Prorrateamos el costo de producción entre las líneas según kg totales
        const totalKg = lines.reduce((s, l) => s + l.quantity * l.unit_weight_kg, 0);
        lines.forEach((l) => {
            const lineKg = l.quantity * l.unit_weight_kg;
            const lineCost = totalKg > 0 ? (r.costo_produccion * lineKg / totalKg) : 0;
            l.batch_cost_total = roundCurrency(lineCost);
            l.cost_per_unit = l.quantity > 0 ? roundCurrency(lineCost / l.quantity) : 0;
        });

        return {
            source: r,
            lines,
            commission: {
                seller_id: sellerId,
                entry_date: r.fecha,
                base_amount: r.total_ventas,
                amount: r.comision, // puede ser negativo (ajuste)
                rate_percent: r.total_ventas > 0
                    ? roundCurrency((r.comision / r.total_ventas) * 100)
                    : 0,
                notes: `Comisión histórica lote "${r.lote}" (calc: ${r.total_calculado}, cobrado: ${r.total_ventas})`,
            },
        };
    });
};

// ---------------------------------------------------------------------
// Ejecuta la importación en firme. Requiere que el caller ya haya validado
// el confirmText === 'BORRAR' en el controller.
// ---------------------------------------------------------------------
const executeImport = async (plan, { userId, sellerId }) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const skuMap = await ensureMontejeySkus(connection);

        // Re-resolver product_ids del plan usando el skuMap fresco
        plan.forEach((p) => {
            p.lines.forEach((l) => {
                l.product_id = skuMap.get(l.sku).id;
            });
        });

        // Borrar datos operativos
        const cleared = await wipeOperationalData(connection);

        // Contadores
        let batchesCreated = 0, salesCreated = 0, commissionsCreated = 0;

        for (const p of plan) {
            const r = p.source;

            // Correlativo por producto en la fecha
            for (const line of p.lines) {
                const dateStr = r.fecha.replace(/-/g, '');
                const [[{ batchCount }]] = await connection.query(
                    'SELECT COUNT(*) AS batchCount FROM product_batches WHERE product_id = ? AND DATE(entry_date) = ?',
                    [line.product_id, r.fecha]
                );
                const batchCode = `${line.sku}-${dateStr}-${String(batchCount + 1).padStart(3, '0')}`;

                const costPerUnit = line.cost_per_unit;
                const totalPackagedKg = line.quantity * line.unit_weight_kg;
                const finalCostPerKg = totalPackagedKg > 0
                    ? roundCurrency(line.batch_cost_total / totalPackagedKg)
                    : 0;

                const [batchRes] = await connection.query(
                    `INSERT INTO product_batches
                        (product_id, supplier_id, cost_per_unit, initial_quantity, current_quantity,
                         entry_date, batch_code, notes,
                         unit_weight_kg, final_cost_per_unit, final_cost_per_kg,
                         suggested_price, margin_percent,
                         is_historical, historical_reference)
                     VALUES (?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?)`,
                    [
                        line.product_id,
                        costPerUnit,
                        line.quantity,            // initial_quantity
                        r.fecha,
                        batchCode,
                        `Histórico: ${r.lote}${r.notas ? ` - ${r.notas}` : ''}`,
                        line.unit_weight_kg,
                        costPerUnit,
                        finalCostPerKg,
                        line.unit_price,
                        line.unit_price > 0
                            ? roundCurrency(((line.unit_price - costPerUnit) / line.unit_price) * 100)
                            : 0,
                        r.lote,
                    ]
                );
                const batchId = batchRes.insertId;
                line.batch_id = batchId;
                batchesCreated++;

                // Movimiento IN de inventario
                await registerInventoryMovement(connection, {
                    product_id: line.product_id,
                    batch_id: batchId,
                    movement_type: 'IN',
                    quantity: line.quantity,
                    reference_type: 'historical_import',
                    reference_id: batchId,
                    notes: `Ingreso histórico ${batchCode}`,
                });

                // Gasto contable por la producción
                if (line.batch_cost_total > 0) {
                    await connection.query(
                        `INSERT INTO financial_ledger (entry_date, concept, expense)
                         VALUES (?, ?, ?)`,
                        [r.fecha, `Producción lote ${batchCode} (${line.quantity} uds de ${line.sku})`,
                         line.batch_cost_total]
                    );
                }
            }

            // Venta agregada (una sola venta con sus líneas) fechada en entry_date
            const [saleRes] = await connection.query(
                `INSERT INTO sales
                    (user_id, customer_id, seller_id, total_amount, discount,
                     iva_rate, iva_amount, payment_method,
                     commission_amount, commission_rate,
                     is_historical, created_at)
                 VALUES (?, NULL, ?, ?, 0, 0, 0, 'historico', ?, ?, TRUE, ?)`,
                [
                    userId,
                    sellerId,
                    r.total_ventas,
                    p.commission.amount,
                    p.commission.rate_percent,
                    `${r.fecha} 12:00:00`,
                ]
            );
            const saleId = saleRes.insertId;
            salesCreated++;

            // Detalles y salida de stock
            for (const line of p.lines) {
                await connection.query(
                    `INSERT INTO sale_details
                        (sale_id, product_id, batch_id, quantity, unit_price, unit_cost)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [saleId, line.product_id, line.batch_id, line.quantity,
                     line.unit_price, line.cost_per_unit]
                );

                await connection.query(
                    'UPDATE product_batches SET current_quantity = current_quantity - ? WHERE id = ?',
                    [line.quantity, line.batch_id]
                );

                await registerInventoryMovement(connection, {
                    product_id: line.product_id,
                    batch_id: line.batch_id,
                    movement_type: 'OUT',
                    quantity: line.quantity,
                    reference_type: 'historical_sale',
                    reference_id: saleId,
                    notes: `Salida histórica venta #${saleId}`,
                });
            }

            // Ingreso contable por la venta
            if (r.total_ventas > 0) {
                await connection.query(
                    `INSERT INTO financial_ledger (entry_date, concept, income, sale_id)
                     VALUES (?, ?, ?, ?)`,
                    [r.fecha, `Venta histórica: ${r.lote}`, r.total_ventas, saleId]
                );
            }

            // Comisión
            await connection.query(
                `INSERT INTO commissions
                    (seller_id, sale_id, batch_id, entry_date,
                     base_amount, rate_percent, amount,
                     status, source, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'historical_import', ?)`,
                [
                    p.commission.seller_id,
                    saleId,
                    p.lines[0]?.batch_id || null,
                    p.commission.entry_date,
                    roundCurrency(p.commission.base_amount),
                    p.commission.rate_percent,
                    roundCurrency(p.commission.amount),
                    p.commission.notes,
                ]
            );
            commissionsCreated++;
        }

        await connection.commit();

        // Después del commit, reseteamos AUTO_INCREMENT (no reversible,
        // pero la reimportación ya es definitiva a este punto).
        await resetAutoIncrement(connection, cleared);

        await logAction(userId,
            `Reimportación histórica ejecutada: ${batchesCreated} lotes, ${salesCreated} ventas, ${commissionsCreated} comisiones. Tablas limpiadas: ${cleared.join(', ')}`
        );

        return { batchesCreated, salesCreated, commissionsCreated, tablesCleared: cleared };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
};

module.exports = {
    validateAndNormalize,
    buildPlan,
    executeImport,
    ensureMontejeySkus,
    MONTEJEY_SKUS,
};
