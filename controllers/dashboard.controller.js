const pool = require('../db/database');

const getDashboardStats = async (req, res) => {
    try {
        // Conteo total de productos activos con stock
        const [[{ productCount }]] = await pool.query(
            `SELECT COUNT(DISTINCT p.id) as productCount 
             FROM products p 
             LEFT JOIN product_batches pb ON p.id = pb.product_id AND pb.current_quantity > 0
             WHERE p.is_active = TRUE`
        );

        // Conteo total de ventas
        const [[{ salesCount }]] = await pool.query('SELECT COUNT(*) as salesCount FROM sales');

        // Conteo total de usuarios activos
        const [[{ userCount }]] = await pool.query('SELECT COUNT(*) as userCount FROM users WHERE is_active = TRUE');

        // Productos más vendidos (Top 5)
        const [topProducts] = await pool.query(`
            SELECT p.name, 
                   COALESCE(SUM(pb.current_quantity), 0) as stock, 
                   SUM(sd.quantity) as totalSold
            FROM sale_details sd
            JOIN products p ON sd.product_id = p.id
            LEFT JOIN product_batches pb ON p.id = pb.product_id AND pb.current_quantity > 0
            GROUP BY p.id, p.name
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

        // Total de lotes activos (con stock > 0)
        const [[{ activeBatchCount }]] = await pool.query(
            'SELECT COUNT(*) as activeBatchCount FROM product_batches WHERE current_quantity > 0'
        );

        res.json({
            userCount,
            productCount,
            salesCount,
            activeBatchCount,
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
