const pool = require('../db/database');
const { logAction } = require('../helpers/audit.helper');

const getCustomers = async (req, res) => {
    const { page = 1, limit = 15, search = '' } = req.query;
    const offset = (page - 1) * limit;

    try {
        const searchTerm = `%${search}%`;
        
        // --- CONSULTA CORREGIDA ---
        const [customers] = await pool.query(
            `SELECT c.*, DATEDIFF(CURDATE(), last_sale.last_sale_date) as days_since_last_purchase
             FROM customers c
             LEFT JOIN (
                SELECT customer_id, MAX(created_at) as last_sale_date
                FROM sales
                WHERE customer_id IS NOT NULL
                GROUP BY customer_id
             ) as last_sale ON c.id = last_sale.customer_id
             WHERE (c.full_name LIKE ? OR c.id_document LIKE ? OR c.contact LIKE ?)
             ORDER BY c.full_name ASC 
             LIMIT ? OFFSET ?`,
            [searchTerm, searchTerm, searchTerm, parseInt(limit), parseInt(offset)]
        );

        const [[{ total }]] = await pool.query(
            'SELECT COUNT(id) as total FROM customers WHERE full_name LIKE ? OR id_document LIKE ? OR contact LIKE ?',
            [searchTerm, searchTerm, searchTerm]
        );

        res.json({
            customers,
            totalPages: Math.ceil(total / limit),
            currentPage: parseInt(page)
        });
    } catch (error) {
        console.error("Error al obtener clientes:", error);
        res.status(500).json({ msg: 'Error al obtener los clientes' });
    }
};

// ... (El resto del código se mantiene igual, no necesita cambios)
const createCustomer = async (req, res) => {
    const { full_name, id_document, contact, email, address, city, notes } = req.body;
    try {
        const [result] = await pool.query(
            'INSERT INTO customers (full_name, id_document, contact, email, address, city, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [full_name, id_document, contact, email, address, city, notes]
        );
        const [newCustomer] = await pool.query('SELECT * FROM customers WHERE id = ?', [result.insertId]);
        
        await logAction(req.uid, `Creó al cliente '${full_name}' (ID: ${result.insertId})`);
        res.status(201).json(newCustomer[0]);
    } catch (error) {
        console.error("Error al crear cliente:", error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ msg: `Ya existe un cliente con el documento '${id_document}'.` });
        }
        res.status(500).json({ msg: 'Error al crear el cliente' });
    }
};

const updateCustomer = async (req, res) => {
    const { id } = req.params;
    const { full_name, id_document, contact, email, address, city, notes } = req.body;
    try {
        await pool.query(
            'UPDATE customers SET full_name = ?, id_document = ?, contact = ?, email = ?, address = ?, city = ?, notes = ? WHERE id = ?',
            [full_name, id_document, contact, email, address, city, notes, id]
        );
        const [updatedCustomer] = await pool.query('SELECT * FROM customers WHERE id = ?', [id]);

        await logAction(req.uid, `Actualizó al cliente '${full_name}' (ID: ${id})`);
        res.json(updatedCustomer[0]);
    } catch (error) {
        console.error("Error al actualizar cliente:", error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ msg: `Ya existe otro cliente con el documento '${id_document}'.` });
        }
        res.status(500).json({ msg: 'Error al actualizar el cliente' });
    }
};

const deleteCustomer = async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM customers WHERE id = ?', [id]);
        await logAction(req.uid, `Eliminó al cliente con ID: ${id}`);
        res.json({ msg: 'Cliente eliminado correctamente' });
    } catch (error) {
        console.error("Error al eliminar cliente:", error);
        res.status(500).json({ msg: 'Error al eliminar el cliente' });
    }
};

const bulkImportCustomers = async (req, res) => {
    const { customers } = req.body;
    if (!customers || !Array.isArray(customers) || customers.length === 0) {
        return res.status(400).json({ msg: 'No se proporcionaron clientes para importar.' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const query = `
            INSERT INTO customers (full_name, id_document, contact, email, address, city, notes) 
            VALUES ?
            ON DUPLICATE KEY UPDATE 
            full_name=VALUES(full_name), contact=VALUES(contact), email=VALUES(email), 
            address=VALUES(address), city=VALUES(city), notes=VALUES(notes);
        `;
        
        const values = customers.map(c => [
            c.NOMBRE, c.DOCUMENTO, c.TELEFONO, c.EMAIL, c.DIRECCION, c.CIUDAD, c.OBSERVACIONES
        ]);

        const [result] = await connection.query(query, [values]);
        
        await connection.commit();
        
        await logAction(req.uid, `Importó o actualizó ${result.affectedRows} clientes desde un archivo Excel.`);
        res.status(201).json({ msg: `${result.affectedRows} clientes han sido importados o actualizados exitosamente.` });

    } catch (error) {
        await connection.rollback();
        console.error('Error en la importación masiva de clientes:', error);
        res.status(500).json({ msg: 'Ocurrió un error durante la importación.' });
    } finally {
        connection.release();
    }
};

const searchCustomers = async (req, res) => {
    const { term } = req.params;
    try {
        const searchTerm = `%${term}%`;
        const [customers] = await pool.query(
            `SELECT id, full_name, id_document, contact FROM customers 
             WHERE full_name LIKE ? OR id_document LIKE ?
             LIMIT 5`,
            [searchTerm, searchTerm]
        );
        res.json(customers);
    } catch (error) {
        console.error("Error al buscar clientes:", error);
        res.status(500).json({ msg: 'Error al buscar clientes' });
    }
};

module.exports = {
    getCustomers,
    createCustomer,
    updateCustomer,
    deleteCustomer,
    bulkImportCustomers,
    searchCustomers
};