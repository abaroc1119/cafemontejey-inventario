const pool = require('../db/database');

const getMetrics = async (req, res) => {
    const { startDate, endDate } = req.query;

    try {
        let dateParams = [];
        if (startDate && endDate) {
            dateParams = [`${startDate} 00:00:00`, `${endDate} 23:59:59`];
        }

        const [[financialSummary]] = await pool.query(
            `SELECT 
                SUM(income) as totalIncome,
                SUM(expense) as totalExpense
            FROM financial_ledger 
            ${dateParams.length > 0 ? 'WHERE entry_date BETWEEN ? AND ?' : ''}`,
            dateParams
        );

        const [[{ salesCount }]] = await pool.query(
            `SELECT COUNT(*) as salesCount FROM sales ${dateParams.length > 0 ? 'WHERE created_at BETWEEN ? AND ?' : ''}`,
            dateParams
        );

        const [incomeData] = await pool.query(
            `SELECT 
                DATE(entry_date) as sale_date,
                SUM(income) as daily_total
            FROM financial_ledger
            ${dateParams.length > 0 ? 'WHERE entry_date BETWEEN ? AND ?' : ''}
            GROUP BY sale_date
            ORDER BY sale_date ASC;`,
            dateParams
        );

        const [employeeRanking] = await pool.query(
            `SELECT 
                u.full_name, 
                COUNT(s.id) as sales_count, 
                SUM(s.total_amount - s.iva_amount) as total_sold
            FROM sales s JOIN users u ON s.user_id = u.id
            ${dateParams.length > 0 ? 'WHERE s.created_at BETWEEN ? AND ?' : ''} 
            GROUP BY s.user_id 
            ORDER BY total_sold DESC;`,
            dateParams
        );

        const [productRankingByQuantity] = await pool.query(
            `SELECT p.name, SUM(sd.quantity) as total_quantity_sold
            FROM sale_details sd JOIN sales s ON sd.sale_id = s.id JOIN products p ON sd.product_id = p.id
            ${dateParams.length > 0 ? 'WHERE s.created_at BETWEEN ? AND ?' : ''} GROUP BY sd.product_id ORDER BY total_quantity_sold DESC LIMIT 10;`,
            dateParams
        );

        const [mostProfitableProducts] = await pool.query(
            `SELECT p.name, SUM((sd.unit_price - sd.unit_cost) * sd.quantity) as total_profit
            FROM sale_details sd JOIN sales s ON sd.sale_id = s.id JOIN products p ON sd.product_id = p.id
            ${dateParams.length > 0 ? 'WHERE s.created_at BETWEEN ? AND ?' : ''} GROUP BY sd.product_id HAVING total_profit > 0 ORDER BY total_profit DESC LIMIT 10;`,
            dateParams
        );

        // Productos estancados: activos que NUNCA se han vendido
        const [stagnantProducts] = await pool.query(
            `SELECT p.name, 
                    COALESCE(SUM(pb.current_quantity), 0) as stock,
                    CASE WHEN SUM(pb.current_quantity) > 0 
                         THEN ROUND(SUM(pb.current_quantity * pb.cost_per_unit) / SUM(pb.current_quantity), 2)
                         ELSE 0 END as cost,
                    p.price
            FROM products p 
            LEFT JOIN sale_details sd ON p.id = sd.product_id
            LEFT JOIN product_batches pb ON p.id = pb.product_id AND pb.current_quantity > 0
            WHERE sd.product_id IS NULL AND p.is_active = TRUE
            GROUP BY p.id, p.name, p.price;`
        );

        const [[{ totalIva }]] = await pool.query(
            `SELECT SUM(iva_amount) as totalIva FROM sales s ${dateParams.length > 0 ? 'WHERE s.created_at BETWEEN ? AND ?' : ''}`,
            dateParams
        );

        const totalIncome = financialSummary.totalIncome || 0;
        const totalExpense = financialSummary.totalExpense || 0;
        const netProfit = totalIncome - totalExpense;

        res.json({
            totalIncome: totalIncome,
            salesCount: salesCount || 0,
            grossProfit: netProfit,
            totalIvaCollected: totalIva || 0,
            salesData: incomeData,
            employeeRanking,
            productRankingByQuantity,
            mostProfitableProducts,
            stagnantProducts
        });

    } catch (error) {
        console.error("Error al obtener las métricas:", error);
        res.status(500).json({ msg: 'Error al procesar las métricas' });
    }
};

module.exports = {
    getMetrics
};
