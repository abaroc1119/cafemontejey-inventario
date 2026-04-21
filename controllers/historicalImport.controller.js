const pool = require('../db/database');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const {
    validateAndNormalize,
    buildPlan,
    executeImport,
    MONTEJEY_SKUS,
} = require('../services/historicalImport.service');

/**
 * POST /api/historical-import/preview
 * Recibe las filas parseadas del Excel y devuelve el resumen y warnings,
 * sin tocar la base de datos.
 */
const previewImport = async (req, res) => {
    try {
        const { rows } = req.body;
        const { rows: normalized, warnings, totals } = validateAndNormalize(rows);

        // Conteo actual para que el usuario vea qué se borraría
        const [[counts]] = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM product_batches)     AS batches,
                (SELECT COUNT(*) FROM sales)               AS sales,
                (SELECT COUNT(*) FROM sale_details)        AS sale_details,
                (SELECT COUNT(*) FROM inventory_movements) AS inventory_movements,
                (SELECT COUNT(*) FROM financial_ledger)    AS financial_ledger,
                (SELECT COUNT(*) FROM commissions)         AS commissions
        `);

        res.json({
            ok: true,
            preview: normalized,
            warnings,
            totals,
            willBeDeleted: counts,
            skusInvolved: MONTEJEY_SKUS.map((s) => ({ sku: s.sku, name: s.name })),
        });
    } catch (error) {
        console.error('Error en preview de importación:', error);
        res.status(400).json({ ok: false, msg: error.message || 'Error validando la data.' });
    }
};

/**
 * POST /api/historical-import/execute
 *
 * Body:
 *   rows: [...]        - filas parseadas desde el Excel
 *   seller_id: number  - vendedor al que se asocian las comisiones
 *   confirmText: str   - debe ser EXACTAMENTE "BORRAR" para proceder
 *   createBackup: bool - (opcional) intenta mysqldump antes de truncar
 */
const executeHistoricalImport = async (req, res) => {
    const { rows, seller_id, confirmText, createBackup = true } = req.body;
    const userId = req.uid;

    if (confirmText !== 'BORRAR') {
        return res.status(400).json({
            ok: false,
            msg: 'Confirmación inválida. Debes enviar exactamente la palabra "BORRAR" para proceder.',
        });
    }

    if (!seller_id) {
        return res.status(400).json({ ok: false, msg: 'Debes seleccionar un vendedor para asociar las comisiones.' });
    }

    try {
        // 1. Validar seller existe
        const [[seller]] = await pool.query('SELECT id, full_name FROM sellers WHERE id = ?', [seller_id]);
        if (!seller) {
            return res.status(404).json({ ok: false, msg: 'Vendedor no encontrado.' });
        }

        // 2. Validar filas
        const { rows: normalized, warnings, totals } = validateAndNormalize(rows);

        // 3. Backup (best-effort - no aborta si falla)
        let backupResult = null;
        if (createBackup) {
            backupResult = await tryCreateBackup();
        }

        // 4. Construir plan (necesita skuMap, pero executeImport lo vuelve a
        //    generar internamente; aquí usamos un mapa placeholder)
        const plan = buildPlan(normalized, buildPlaceholderSkuMap(), seller_id);

        // 5. Ejecutar
        const stats = await executeImport(plan, { userId, sellerId: seller_id });

        res.json({
            ok: true,
            msg: 'Reimportación histórica completada correctamente.',
            stats,
            warnings,
            totals,
            backup: backupResult,
            seller: seller.full_name,
        });
    } catch (error) {
        console.error('Error en ejecución de importación histórica:', error);
        res.status(500).json({
            ok: false,
            msg: error.message || 'Error ejecutando la reimportación.',
        });
    }
};

/**
 * Mapa placeholder que cumple con la interfaz esperada por buildPlan.
 * executeImport reemplaza los product_ids usando el skuMap real de la BD.
 */
const buildPlaceholderSkuMap = () => {
    const map = new Map();
    MONTEJEY_SKUS.forEach((s) => map.set(s.sku, { id: 0, sku: s.sku, name: s.name }));
    return map;
};

/**
 * Best-effort: intenta hacer un mysqldump a /backups/ usando la misma
 * config que usa el pool. Si mysqldump no está disponible o la escritura
 * falla, devolvemos un warning pero NO abortamos.
 */
const tryCreateBackup = () => {
    return new Promise((resolve) => {
        try {
            const backupDir = path.join(__dirname, '..', 'backups');
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
            }

            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const file = path.join(backupDir, `pre_historical_import_${stamp}.sql`);

            const host = process.env.DB_HOST || 'localhost';
            const user = process.env.DB_USER || 'root';
            const pass = process.env.DB_PASSWORD || '';
            const db   = process.env.DB_NAME || 'gestioneexus_db';
            const port = process.env.DB_PORT || '3306';

            // Usamos MYSQL_PWD para no exponer el password en la línea de comandos
            const cmd = `mysqldump -h ${host} -P ${port} -u ${user} --single-transaction --quick --routines ${db} > "${file}"`;

            exec(cmd, { env: { ...process.env, MYSQL_PWD: pass }, maxBuffer: 200 * 1024 * 1024 },
                (err) => {
                    if (err) {
                        resolve({ ok: false, warning: `No se pudo generar backup automático: ${err.message}. Haz un dump manual antes de continuar.` });
                    } else {
                        resolve({ ok: true, file });
                    }
                }
            );
        } catch (e) {
            resolve({ ok: false, warning: `No se pudo preparar backup: ${e.message}` });
        }
    });
};

module.exports = {
    previewImport,
    executeHistoricalImport,
};
