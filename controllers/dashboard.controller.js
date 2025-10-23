const pool = require('../db/database');

const getDashboardStats = async (req, res) => {
    try {
        // Conteo total de productos activos
        const [[{ productCount }]] = await pool.query('SELECT COUNT(*) as productCount FROM products WHERE is_active = TRUE');

        // Conteo total de ventas
        const [[{ salesCount }]] = await pool.query('SELECT COUNT(*) as salesCount FROM sales');

        // Conteo total de usuarios activos
        const [[{ userCount }]] = await pool.query('SELECT COUNT(*) as userCount FROM users WHERE is_active = TRUE');

        // Productos más vendidos (Top 5)
        const [topProducts] = await pool.query(`
            SELECT p.name, p.quantity as stock, SUM(sd.quantity) as totalSold
            FROM sale_details sd
            JOIN products p ON sd.product_id = p.id
            GROUP BY sd.product_id
            ORDER BY totalSold DESC
            LIMIT 5;
        `);

        // Últimas ventas (Top 5)
        const [recentSales] = await pool.query(`
            SELECT p.name as productName, s.created_at, (sd.quantity * sd.unit_price) as saleTotal
            FROM sale_details sd
            JOIN sales s ON sd.sale_id = s.id
            JOIN products p ON sd.product_id = p.id
            ORDER BY s.created_at DESC
            LIMIT 5;
        `);

        res.json({
            userCount,
            productCount,
            salesCount,
            topProducts,
            recentSales
        });

    } catch (error) {
        console.error("Error fetching dashboard stats:", error);
        res.status(500).json({ msg: 'Error al obtener las estadísticas del dashboard' });
    }
};

module.exports = {
    getDashboardStats
};