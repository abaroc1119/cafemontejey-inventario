const pool = require('../db/database');

const fetchAllNotifications = async () => {
    const notifications = [];

    // 1. Notificaciones de BAJO STOCK (sin cambios)
    const [lowStockProducts] = await pool.query('SELECT name, quantity FROM products WHERE quantity < 3 AND is_active = TRUE');
    lowStockProducts.forEach(p => {
        notifications.push({
            id: `stock-${p.name.replace(/\s/g, '-')}`,
            type: 'stock_alert',
            message: `Reponer stock de '${p.name}', quedan solo ${p.quantity} unidades.`
        });
    });

    // 2. Notificaciones de PLAN SEPARE VENCIDO (sin cambios)
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

    // 3. Notificaciones de PLAN SEPARE PRÓXIMO A VENCER (sin cambios)
    const [dueSoonPlans] = await pool.query(
        "SELECT id, customer_name, deadline FROM layaway_plans WHERE deadline BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 3 DAY) AND status = 'active'"
    );
    dueSoonPlans.forEach(p => {
        const formattedDate = new Date(p.deadline);
        formattedDate.setDate(formattedDate.getDate() + 1);
        notifications.push({
            id: `duesoon-${p.id}`,
            type: 'payment_soon',
            message: `El plazo de ${p.customer_name} vence pronto (${formattedDate.toLocaleDateString('es-CO', {day: 'numeric', month: 'long'})}).`
        });
    });

    // --- 4. NUEVA LÓGICA: Notificaciones de CLIENTES INACTIVOS ---
    const [inactiveCustomers] = await pool.query(`
        SELECT 
            c.id,
            c.full_name,
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