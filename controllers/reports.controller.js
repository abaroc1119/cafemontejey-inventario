const pool = require('../db/database');
const { logAction } = require('../helpers/audit.helper');
const ExcelJS = require('exceljs');
const { jsPDF } = require("jspdf");
const autoTable = require('jspdf-autotable');

const getFinancialLedger = async (req, res) => {
    const { page = 1, limit = 15, startDate, endDate, search = '' } = req.query;
    const offset = (page - 1) * limit;
    
    const conditions = [];
    const params = [];

    if (startDate && endDate) {
        conditions.push('fl.entry_date BETWEEN ? AND ?');
        params.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
    }
    if (search) {
        conditions.push('fl.concept LIKE ?');
        params.push(`%${search}%`);
    }
    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    
    try {
        // --- INICIO DE LA CORRECCIÓN FINAL ---
        const entriesQuery = `
            SELECT
                fl.id,
                fl.entry_date,
                fl.concept,
                -- Ingreso Bruto: Solo se calcula para ventas directas (sin layaway_plan_id). 
                -- Para todos los abonos (con layaway_plan_id), el bruto es igual al neto.
                CASE 
                    WHEN fl.sale_id IS NOT NULL AND fl.layaway_plan_id IS NULL THEN fl.income + COALESCE(s.iva_amount, 0)
                    ELSE fl.income 
                END as gross_income,
                
                -- IVA: Solo se muestra en la fila que tiene una venta asociada (sea directa o de plan).
                COALESCE(s.iva_amount, 0) as iva_amount,
                
                -- Ingreso Neto: Siempre es el valor del movimiento individual en el libro contable.
                fl.income as net_income,
                fl.expense
            FROM 
                financial_ledger fl
            LEFT JOIN 
                sales s ON fl.sale_id = s.id
            ${whereClause}
            ORDER BY 
                fl.entry_date DESC, fl.id DESC 
            LIMIT ? OFFSET ?
        `;
        // --- FIN DE LA CORRECCIÓN FINAL ---
        
        const [entries] = await pool.query(entriesQuery, [...params, parseInt(limit), parseInt(offset)]);

        const [[{ total }]] = await pool.query(`SELECT COUNT(*) as total FROM financial_ledger fl ${whereClause}`, params);
        
        const [[summary]] = await pool.query(`
            SELECT
                SUM(fl.income) as totalIncome,
                SUM(fl.expense) as totalExpense
            FROM financial_ledger fl
            ${whereClause}
        `, params);

        let ivaQuery = `SELECT SUM(iva_amount) as totalIva FROM sales s`;
        if (startDate && endDate) {
            ivaQuery += ` WHERE s.created_at BETWEEN ? AND ?`;
        }
        const [[{ totalIva }]] = await pool.query(ivaQuery, (startDate && endDate) ? [`${startDate} 00:00:00`, `${endDate} 23:59:59`] : []);

        res.json({
            entries,
            totalPages: Math.ceil(total / limit),
            currentPage: parseInt(page),
            summary: {
                totalIncome: summary.totalIncome || 0,
                totalExpense: summary.totalExpense || 0,
                netBalance: (summary.totalIncome || 0) - (summary.totalExpense || 0),
                totalIvaCollected: totalIva || 0
            }
        });
    } catch (error) {
        console.error("Error al obtener el libro contable:", error);
        res.status(500).json({ msg: 'Error al obtener los reportes' });
    }
};

const createFinancialEntry = async (req, res) => {
    const { entry_date, concept, income, expense } = req.body;
    const userId = req.uid; 

    try {
        await pool.query(
            'INSERT INTO financial_ledger (entry_date, concept, income, expense, sale_id, layaway_plan_id) VALUES (?, ?, ?, ?, NULL, NULL)',
            [entry_date, concept || null, income || 0, expense || 0]
        );

        let actionDetails = '';
        if (income > 0) {
            actionDetails = `Se registró un INGRESO por "${concept}" por un monto de ${income}.`;
        } else if (expense > 0) {
            actionDetails = `Se registró un EGRESO por "${concept}" por un monto de ${expense}.`;
        }

        if (actionDetails) {
            await logAction(userId, actionDetails);
        }

        res.status(201).json({ msg: 'Entrada contable creada' });
    } catch (error) {
        console.error("Error al registrar movimiento:", error);
        const errorMsg = error.response?.data?.errors?.[0]?.msg || error.response?.data?.msg || 'No se pudo registrar el movimiento.';
        res.status(500).json({ msg: errorMsg });
    }
};

const exportLedgerToExcel = async (req, res) => {
    try {
        const entriesQuery = `
            SELECT
                fl.id, fl.entry_date, fl.concept,
                CASE WHEN fl.sale_id IS NOT NULL AND fl.layaway_plan_id IS NULL THEN fl.income + COALESCE(s.iva_amount, 0) ELSE fl.income END as gross_income,
                COALESCE(s.iva_amount, 0) as iva_amount,
                fl.income as net_income,
                fl.expense
            FROM financial_ledger fl
            LEFT JOIN sales s ON fl.sale_id = s.id
            ORDER BY fl.entry_date DESC, fl.id DESC
        `;
        const [ledgerData] = await pool.query(entriesQuery);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Reporte Financiero');
        worksheet.columns = [
            { header: 'Fecha', key: 'date', width: 15 },
            { header: 'Concepto', key: 'concept', width: 40 },
            { header: 'Ingreso Bruto', key: 'gross_income', width: 15, style: { numFmt: '"$"#,##0' } },
            { header: 'IVA', key: 'iva_amount', width: 15, style: { numFmt: '"$"#,##0' } },
            { header: 'Ingreso Neto', key: 'net_income', width: 15, style: { numFmt: '"$"#,##0' } },
            { header: 'Egresos', key: 'expense', width: 15, style: { numFmt: '"$"#,##0' } },
        ];
        ledgerData.forEach(row => {
            worksheet.addRow({
                date: new Date(row.entry_date),
                concept: row.concept,
                gross_income: parseFloat(row.gross_income),
                iva_amount: parseFloat(row.iva_amount),
                net_income: parseFloat(row.net_income),
                expense: parseFloat(row.expense)
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=reporte-financiero.xlsx');
        const buffer = await workbook.xlsx.writeBuffer();
        res.send(buffer);
    } catch (error) {
        console.error("Error al generar el Excel:", error);
        res.status(500).json({ msg: 'Error al generar el reporte en Excel' });
    }
};

module.exports = { 
    getFinancialLedger, 
    createFinancialEntry, 
    exportLedgerToExcel 
};