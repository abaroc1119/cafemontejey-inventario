const pool = require('../db/database');

const getDashboardStats = async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const currentMonth = today.substring(0, 7); // YYYY-MM

        // ─── Contadores principales ───
        const [[{ productCount }]] = await pool.query(
            'SELECT COUNT(*) as productCount FROM products WHERE is_active = TRUE'
        );

        const [[{ salesCount }]] = await pool.query(
            'SELECT COUNT(*) as salesCount FROM sales'
        );

        const [[{ userCount }]] = await pool.query(
            'SELECT COUNT(*) as userCount FROM users WHERE is_active = TRUE AND deleted_at IS NULL'
        );

        const [[{ customerCount }]] = await pool.query(
            'SELECT COUNT(*) as customerCount FROM customers'
        );

        const [[{ activeBatchCount }]] = await pool.query(
            'SELECT COUNT(*) as activeBatchCount FROM product_batches WHERE current_quantity > 0'
        );

        // ─── Ventas del día ───
        const [[todayStats]] = await pool.query(`
            SELECT 
                COUNT(*) as sales_count,
                COALESCE(SUM(total_amount), 0) as revenue,
                COALESCE(SUM(iva_amount), 0) as iva_total
            FROM sales
            WHERE DATE(created_at) = ?
        `, [today]);

        // Ganancia del día
        const [[todayProfit]] = await pool.query(`
            SELECT COALESCE(SUM(sd.quantity * (sd.unit_price - sd.unit_cost)), 0) as profit
            FROM sale_details sd
            JOIN sales s ON sd.sale_id = s.id
            WHERE DATE(s.created_at) = ?
        `, [today]);

        // ─── Ventas del mes ───
        const [[monthStats]] = await pool.query(`
            SELECT 
                COUNT(*) as sales_count,
                COALESCE(SUM(total_amount), 0) as revenue,
                COALESCE(SUM(iva_amount), 0) as iva_total
            FROM sales
            WHERE DATE_FORMAT(created_at, '%Y-%m') = ?
        `, [currentMonth]);

        const [[monthProfit]] = await pool.query(`
            SELECT COALESCE(SUM(sd.quantity * (sd.unit_price - sd.unit_cost)), 0) as profit
            FROM sale_details sd
            JOIN sales s ON sd.sale_id = s.id
            WHERE DATE_FORMAT(s.created_at, '%Y-%m') = ?
        `, [currentMonth]);

        // ─── Productos más vendidos (Top 5) ───
        const [topProducts] = await pool.query(`
            SELECT 
                p.id, p.name, p.sku,
                SUM(sd.quantity) as total_sold,
                SUM(sd.quantity * sd.unit_price) as total_revenue,
                SUM(sd.quantity * (sd.unit_price - sd.unit_cost)) as total_profit,
                COALESCE((SELECT SUM(pb.current_quantity) FROM product_batches pb WHERE pb.product_id = p.id AND pb.current_quantity > 0), 0) as current_stock
            FROM sale_details sd
            JOIN products p ON sd.product_id = p.id
            GROUP BY p.id, p.name, p.sku
            ORDER BY total_sold DESC
            LIMIT 5
        `);

        // ─── Últimas 5 ventas ───
        const [recentSales] = await pool.query(`
            SELECT 
                s.id, s.total_amount, s.discount, s.iva_rate, s.iva_amount,
                s.payment_method, s.created_at,
                u.full_name as user_name,
                c.full_name as customer_name,
                (SELECT SUM(sd2.quantity) FROM sale_details sd2 WHERE sd2.sale_id = s.id) as total_items,
                (SELECT SUM(sd3.quantity * (sd3.unit_price - sd3.unit_cost)) FROM sale_details sd3 WHERE sd3.sale_id = s.id) as profit
            FROM sales s
            JOIN users u ON s.user_id = u.id
            LEFT JOIN customers c ON s.customer_id = c.id
            ORDER BY s.created_at DESC
            LIMIT 5
        `);

        // ─── Productos con stock bajo (menos de 5 unidades) ───
        const [lowStockProducts] = await pool.query(`
            SELECT 
                p.id, p.name, p.sku,
                COALESCE(SUM(pb.current_quantity), 0) as current_stock
            FROM products p
            LEFT JOIN product_batches pb ON p.id = pb.product_id AND pb.current_quantity > 0
            WHERE p.is_active = TRUE
            GROUP BY p.id, p.name, p.sku
            HAVING current_stock <= 5 AND current_stock >= 0
            ORDER BY current_stock ASC
            LIMIT 10
        `);

        // ─── Ventas por medio de pago (mes actual) ───
        const [paymentMethodStats] = await pool.query(`
            SELECT 
                COALESCE(payment_method, 'efectivo') as method,
                COUNT(*) as count,
                SUM(total_amount) as total
            FROM sales
            WHERE DATE_FORMAT(created_at, '%Y-%m') = ?
            GROUP BY payment_method
            ORDER BY total DESC
        `, [currentMonth]);

        // ─── Lotes verdes recientes ───
        const [recentGreenLots] = await pool.query(`
            SELECT 
                g.id, g.lot_code, g.green_quantity_kg, g.roasted_quantity_kg,
                g.distributed_kg, g.remaining_kg, g.status, g.entry_date,
                s.company_name as supplier_name
            FROM green_lot_entries g
            LEFT JOIN suppliers s ON g.supplier_id = s.id
            ORDER BY g.created_at DESC
            LIMIT 3
        `);

        res.json({
            // Contadores
            productCount,
            salesCount,
            userCount,
            customerCount,
            activeBatchCount,

            // Hoy
            today: {
                sales_count: todayStats.sales_count,
                revenue: parseFloat(todayStats.revenue),
                iva: parseFloat(todayStats.iva_total),
                profit: parseFloat(todayProfit.profit),
            },

            // Mes
            month: {
                sales_count: monthStats.sales_count,
                revenue: parseFloat(monthStats.revenue),
                iva: parseFloat(monthStats.iva_total),
                profit: parseFloat(monthProfit.profit),
            },

            // Tablas
            topProducts,
            recentSales,
            lowStockProducts,
            paymentMethodStats,
            recentGreenLots,
        });

    } catch (error) {
        console.error("Error fetching dashboard stats:", error);
        res.status(500).json({ msg: 'Error al obtener las estadísticas del dashboard' });
    }
};

module.exports = {
    getDashboardStats
};
