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
    
    // Parámetros de fecha para ventas
    let salesDateFilter = '';
    let salesDateParams = [];
    if (startDate && endDate) {
        salesDateFilter = 'WHERE s.created_at BETWEEN ? AND ?';
        salesDateParams = [`${startDate} 00:00:00`, `${endDate} 23:59:59`];
    }

    try {
        // ─── Entradas del ledger (paginadas) ───
        const entriesQuery = `
            SELECT
                fl.id, fl.entry_date, fl.concept,
                CASE 
                    WHEN fl.sale_id IS NOT NULL AND fl.layaway_plan_id IS NULL THEN fl.income + COALESCE(s.iva_amount, 0)
                    ELSE fl.income 
                END as gross_income,
                COALESCE(s.iva_amount, 0) as iva_amount,
                fl.income as net_income,
                fl.expense
            FROM financial_ledger fl
            LEFT JOIN sales s ON fl.sale_id = s.id
            ${whereClause}
            ORDER BY fl.entry_date DESC, fl.id DESC 
            LIMIT ? OFFSET ?
        `;
        const [entries] = await pool.query(entriesQuery, [...params, parseInt(limit), parseInt(offset)]);

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) as total FROM financial_ledger fl ${whereClause}`, params
        );
        
        // ─── Resumen del ledger ───
        const [[ledgerSummary]] = await pool.query(`
            SELECT
                COALESCE(SUM(fl.income), 0) as totalIncome,
                COALESCE(SUM(fl.expense), 0) as totalExpense
            FROM financial_ledger fl
            ${whereClause}
        `, params);

        // ─── IVA recaudado ───
        let ivaQuery = `SELECT COALESCE(SUM(iva_amount), 0) as totalIva FROM sales s`;
        if (startDate && endDate) {
            ivaQuery += ` WHERE s.created_at BETWEEN ? AND ?`;
        }
        const [[{ totalIva }]] = await pool.query(
            ivaQuery, 
            (startDate && endDate) ? [`${startDate} 00:00:00`, `${endDate} 23:59:59`] : []
        );

        // ─── Ganancia bruta real (desde sale_details) ───
        const [[profitData]] = await pool.query(`
            SELECT 
                COALESCE(SUM(sd.quantity), 0) as totalUnits,
                COALESCE(SUM(sd.quantity * sd.unit_price), 0) as totalSalesValue,
                COALESCE(SUM(sd.quantity * sd.unit_cost), 0) as totalCostOfGoods,
                COALESCE(SUM(sd.quantity * (sd.unit_price - sd.unit_cost)), 0) as grossProfit,
                COUNT(DISTINCT s.id) as totalSalesCount
            FROM sale_details sd
            JOIN sales s ON sd.sale_id = s.id
            ${salesDateFilter}
        `, salesDateParams);

        // ─── Desglose por producto ───
        const [productBreakdown] = await pool.query(`
            SELECT 
                p.name, p.sku,
                SUM(sd.quantity) as units_sold,
                SUM(sd.quantity * sd.unit_price) as revenue,
                SUM(sd.quantity * sd.unit_cost) as cost,
                SUM(sd.quantity * (sd.unit_price - sd.unit_cost)) as profit,
                CASE 
                    WHEN SUM(sd.quantity * sd.unit_price) > 0 
                    THEN ROUND(SUM(sd.quantity * (sd.unit_price - sd.unit_cost)) / SUM(sd.quantity * sd.unit_price) * 100, 1)
                    ELSE 0 
                END as margin_pct
            FROM sale_details sd
            JOIN sales s ON sd.sale_id = s.id
            JOIN products p ON sd.product_id = p.id
            ${salesDateFilter}
            GROUP BY p.id, p.name, p.sku
            ORDER BY revenue DESC
        `, salesDateParams);

        // ─── Desglose mensual ───
        const [monthlyBreakdown] = await pool.query(`
            SELECT 
                DATE_FORMAT(s.created_at, '%Y-%m') as month_key,
                DATE_FORMAT(s.created_at, '%M %Y') as month_label,
                COUNT(DISTINCT s.id) as sales_count,
                SUM(sd.quantity) as units_sold,
                SUM(sd.quantity * sd.unit_price) as revenue,
                SUM(sd.quantity * sd.unit_cost) as cost,
                SUM(sd.quantity * (sd.unit_price - sd.unit_cost)) as profit
            FROM sale_details sd
            JOIN sales s ON sd.sale_id = s.id
            ${salesDateFilter}
            GROUP BY month_key, month_label
            ORDER BY month_key ASC
        `, salesDateParams);

        res.json({
            entries,
            totalPages: Math.ceil(total / limit),
            currentPage: parseInt(page),
            summary: {
                // Ledger
                totalIncome: ledgerSummary.totalIncome || 0,
                totalExpense: ledgerSummary.totalExpense || 0,
                netBalance: (ledgerSummary.totalIncome || 0) - (ledgerSummary.totalExpense || 0),
                totalIvaCollected: totalIva || 0,
                // Ventas reales
                totalSalesCount: profitData.totalSalesCount || 0,
                totalUnits: profitData.totalUnits || 0,
                totalSalesValue: parseFloat(profitData.totalSalesValue) || 0,
                totalCostOfGoods: parseFloat(profitData.totalCostOfGoods) || 0,
                grossProfit: parseFloat(profitData.grossProfit) || 0,
                avgMargin: profitData.totalSalesValue > 0
                    ? Math.round((profitData.grossProfit / profitData.totalSalesValue) * 1000) / 10
                    : 0,
            },
            productBreakdown,
            monthlyBreakdown,
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
        res.status(500).json({ msg: 'No se pudo registrar el movimiento.' });
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
            { header: 'Concepto', key: 'concept', width: 50 },
            { header: 'Ingreso Bruto', key: 'gross_income', width: 18, style: { numFmt: '"$"#,##0' } },
            { header: 'IVA', key: 'iva_amount', width: 15, style: { numFmt: '"$"#,##0' } },
            { header: 'Ingreso Neto', key: 'net_income', width: 18, style: { numFmt: '"$"#,##0' } },
            { header: 'Egresos', key: 'expense', width: 18, style: { numFmt: '"$"#,##0' } },
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
