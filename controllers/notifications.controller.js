const pool = require('../db/database');

const fetchAllNotifications = async () => {
    const notifications = [];

    // 1. BAJO STOCK - ahora se calcula sumando todos los lotes
    const [lowStockProducts] = await pool.query(`
        SELECT p.name, COALESCE(SUM(pb.current_quantity), 0) as total_stock
        FROM products p
        LEFT JOIN product_batches pb ON p.id = pb.product_id AND pb.current_quantity > 0
        WHERE p.is_active = TRUE
        GROUP BY p.id, p.name
        HAVING total_stock < 3
    `);
    lowStockProducts.forEach(p => {
        notifications.push({
            id: `stock-${p.name.replace(/\s/g, '-')}`,
            type: 'stock_alert',
            message: `Reponer stock de '${p.name}', quedan solo ${p.total_stock} unidades en total.`
        });
    });

    // 2. PLAN SEPARE VENCIDO
    const [overduePlans] = await pool.query(
        "SELECT id, customer_name FROM layaway_plans WHERE deadline < CURDATE() AND status = 'active'"
    );
    overduePlans.forEach(p => {
        notifications.push({
            id: `overdue-${p.id}`,
            type: 'payment_due',
            message: `¡El plan separe del cliente ${p.customer_name} está VENCIDO!`
        });
    });

    // 3. PLAN SEPARE PRÓXIMO A VENCER
    const [dueSoonPlans] = await pool.query(
        "SELECT id, customer_name, deadline FROM layaway_plans WHERE deadline BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 3 DAY) AND status = 'active'"
    );
    dueSoonPlans.forEach(p => {
        const formattedDate = new Date(p.deadline);
        formattedDate.setDate(formattedDate.getDate() + 1);
        notifications.push({
            id: `duesoon-${p.id}`,
            type: 'payment_soon',
            message: `El plazo de ${p.customer_name} vence pronto (${formattedDate.toLocaleDateString('es-CO', { day: 'numeric', month: 'long' })}).`
        });
    });

    // 4. CLIENTES INACTIVOS
    const [inactiveCustomers] = await pool.query(`
        SELECT 
            c.id, c.full_name,
            DATEDIFF(CURDATE(), MAX(s.created_at)) as days_since_last_purchase
        FROM customers c
        JOIN sales s ON c.id = s.customer_id
        GROUP BY c.id, c.full_name
        HAVING days_since_last_purchase > 30;
    `);
    inactiveCustomers.forEach(c => {
        notifications.push({
            id: `inactive-customer-${c.id}`,
            type: 'customer_alert',
            message: `El cliente '${c.full_name}' lleva ${c.days_since_last_purchase} días sin comprar. ¡Contáctalo!`
        });
    });

    // 5. NUEVO: LOTES CON STOCK BAJO (menos de 3 unidades en un lote específico)
    const [lowBatches] = await pool.query(`
        SELECT pb.batch_code, pb.current_quantity, p.name as product_name
        FROM product_batches pb
        JOIN products p ON pb.product_id = p.id
        WHERE pb.current_quantity > 0 AND pb.current_quantity < 3 AND p.is_active = TRUE
    `);
    lowBatches.forEach(b => {
        notifications.push({
            id: `batch-low-${b.batch_code}`,
            type: 'batch_alert',
            message: `Lote '${b.batch_code}' de '${b.product_name}' casi agotado (${b.current_quantity} uds).`
        });
    });

    return notifications;
};

const getNotifications = async (req, res) => {
    try {
        const notifications = await fetchAllNotifications();
        res.json(notifications);
    } catch (error) {
        console.error("Error al obtener las notificaciones:", error);
        res.status(500).json({ msg: 'Error al obtener las notificaciones' });
    }
};

const getNotificationStatus = async (req, res) => {
    try {
        const notifications = await fetchAllNotifications();
        res.json({ hasUnread: notifications.length > 0 });
    } catch (error) {
        console.error("Error al verificar estado de notificaciones:", error);
        res.status(500).json({ msg: 'Error al verificar estado de notificaciones' });
    }
};

const markNotificationsAsRead = (req, res) => {
    res.status(200).json({ msg: 'Notificaciones marcadas como leídas.' });
};

module.exports = {
    getNotifications,
    getNotificationStatus,
    markNotificationsAsRead
};
