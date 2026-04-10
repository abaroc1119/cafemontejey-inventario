const pool = require('../db/database');

const getMetrics = async (req, res) => {
    const { startDate, endDate } = req.query;

    try {
        let dateFilter = '';
        let dateFilterLedger = '';
        let dateParams = [];
        let dateParamsLedger = [];

        if (startDate && endDate) {
            dateFilter = 'WHERE s.created_at BETWEEN ? AND ?';
            dateFilterLedger = 'WHERE fl.entry_date BETWEEN ? AND ?';
            dateParams = [`${startDate} 00:00:00`, `${endDate} 23:59:59`];
            dateParamsLedger = [`${startDate}`, `${endDate}`];
        }

        // ─── Ingresos netos por ventas (sin IVA) ───
        const [[salesSummary]] = await pool.query(`
            SELECT 
                COUNT(*) as salesCount,
                COALESCE(SUM(total_amount), 0) as totalRevenue,
                COALESCE(SUM(total_amount - iva_amount), 0) as netRevenue,
                COALESCE(SUM(iva_amount), 0) as totalIva
            FROM sales s
            ${dateFilter}
        `, dateParams);

        // ─── Ganancia real: precio de venta - costo por unidad ───
        const [[profitData]] = await pool.query(`
            SELECT 
                COALESCE(SUM(sd.quantity * sd.unit_price), 0) as totalSalesValue,
                COALESCE(SUM(sd.quantity * sd.unit_cost), 0) as totalCostOfGoods,
                COALESCE(SUM(sd.quantity * (sd.unit_price - sd.unit_cost)), 0) as grossProfit
            FROM sale_details sd
            JOIN sales s ON sd.sale_id = s.id
            ${dateFilter}
        `, dateParams);

        // ─── Egresos operativos (del ledger, solo gastos que NO son compra de inventario) ───
        const [[expenseSummary]] = await pool.query(`
            SELECT 
                COALESCE(SUM(expense), 0) as totalExpenses
            FROM financial_ledger fl
            ${dateFilterLedger}
        `, dateParamsLedger);

        // ─── Ingresos por día (para gráfica) ───
        const [dailyRevenue] = await pool.query(`
            SELECT 
                DATE(s.created_at) as sale_date,
                SUM(s.total_amount - s.iva_amount) as daily_net_revenue,
                SUM(s.total_amount) as daily_gross_revenue,
                COUNT(*) as daily_sales_count
            FROM sales s
            ${dateFilter}
            GROUP BY DATE(s.created_at)
            ORDER BY sale_date ASC
        `, dateParams);

        // ─── Ranking de empleados ───
        const [employeeRanking] = await pool.query(`
            SELECT 
                u.full_name, 
                COUNT(s.id) as sales_count, 
                SUM(s.total_amount - s.iva_amount) as total_sold
            FROM sales s 
            JOIN users u ON s.user_id = u.id
            ${dateFilter}
            GROUP BY s.user_id 
            ORDER BY total_sold DESC
        `, dateParams);

        // ─── Top productos por cantidad vendida ───
        const [productRankingByQuantity] = await pool.query(`
            SELECT p.name, p.sku, SUM(sd.quantity) as total_quantity_sold
            FROM sale_details sd 
            JOIN sales s ON sd.sale_id = s.id 
            JOIN products p ON sd.product_id = p.id
            ${dateFilter}
            GROUP BY p.id, p.name, p.sku
            ORDER BY total_quantity_sold DESC 
            LIMIT 10
        `, dateParams);

        // ─── Top productos por ganancia ───
        const [mostProfitableProducts] = await pool.query(`
            SELECT p.name, p.sku, 
                   SUM((sd.unit_price - sd.unit_cost) * sd.quantity) as total_profit,
                   SUM(sd.quantity) as total_sold
            FROM sale_details sd 
            JOIN sales s ON sd.sale_id = s.id 
            JOIN products p ON sd.product_id = p.id
            ${dateFilter}
            GROUP BY p.id, p.name, p.sku
            HAVING total_profit > 0 
            ORDER BY total_profit DESC 
            LIMIT 10
        `, dateParams);

        // ─── Productos sin venta ───
        const [stagnantProducts] = await pool.query(`
            SELECT p.name, p.sku,
                   COALESCE(SUM(pb.current_quantity), 0) as stock,
                   p.price
            FROM products p 
            LEFT JOIN sale_details sd ON p.id = sd.product_id
            LEFT JOIN product_batches pb ON p.id = pb.product_id AND pb.current_quantity > 0
            WHERE sd.product_id IS NULL AND p.is_active = TRUE
            GROUP BY p.id, p.name, p.sku, p.price
        `);

        // ─── Ventas por medio de pago ───
        const [paymentBreakdown] = await pool.query(`
            SELECT 
                COALESCE(payment_method, 'efectivo') as method,
                COUNT(*) as count,
                SUM(total_amount) as total
            FROM sales s
            ${dateFilter}
            GROUP BY payment_method
            ORDER BY total DESC
        `, dateParams);

        // Ganancia neta = ganancia bruta de ventas (sin contar inversión en inventario)
        const grossProfit = parseFloat(profitData.grossProfit) || 0;
        const netRevenue = parseFloat(salesSummary.netRevenue) || 0;
        const totalIva = parseFloat(salesSummary.totalIva) || 0;

        res.json({
            // KPIs principales
            totalIncome: netRevenue,
            totalRevenue: parseFloat(salesSummary.totalRevenue) || 0,
            grossProfit: grossProfit,
            totalIvaCollected: totalIva,
            salesCount: salesSummary.salesCount || 0,
            totalCostOfGoods: parseFloat(profitData.totalCostOfGoods) || 0,
            totalExpenses: parseFloat(expenseSummary.totalExpenses) || 0,

            // Gráfica
            salesData: dailyRevenue,

            // Rankings
            employeeRanking,
            productRankingByQuantity,
            mostProfitableProducts,
            stagnantProducts,
            paymentBreakdown,
        });

    } catch (error) {
        console.error("Error al obtener las métricas:", error);
        res.status(500).json({ msg: 'Error al procesar las métricas' });
    }
};

module.exports = {
    getMetrics
};
