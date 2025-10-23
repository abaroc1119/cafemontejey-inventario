const pool = require('../db/database');
const { logAction } = require('../helpers/audit.helper');

const getProducts = async (req, res) => {
    const { search = '', page = 1, limit = 15 } = req.query;
    const offset = (page - 1) * limit;

    try {
        const searchTerm = `%${search}%`;
        
        // --- CONSULTA CORREGIDA ---
        // Se ha reescrito la consulta SQL para eliminar caracteres invisibles
        // que causaban el error de sintaxis en MySQL.
        const [products] = await pool.query(
            `SELECT p.*, c.name as category_name 
             FROM products p
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE p.is_active = TRUE AND (p.name LIKE ? OR p.sku LIKE ?) 
             ORDER BY p.name ASC 
             LIMIT ? OFFSET ?`,
            [searchTerm, searchTerm, parseInt(limit), parseInt(offset)]
        );

        const [[{ total }]] = await pool.query(
            'SELECT COUNT(p.id) as total FROM products p WHERE p.is_active = TRUE AND (p.name LIKE ? OR p.sku LIKE ?)',
            [searchTerm, searchTerm]
        );

        res.json({
            products,
            totalPages: Math.ceil(total / limit),
            currentPage: parseInt(page)
        });
    } catch (error) {
        console.error("Error al obtener productos:", error);
        res.status(500).json({ msg: 'Error al obtener los productos', error });
    }
};

// ... (El resto del código se mantiene igual, no necesita cambios)
const getProductById = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await pool.query(
            `SELECT p.*, c.name as category_name 
             FROM products p
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE p.id = ?`, 
            [id]
        );
        if (rows.length <= 0) {
            return res.status(404).json({ msg: 'Producto no encontrado' });
        }
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ msg: 'Error al obtener el producto', error });
    }
};

const getProductBySku = async (req, res) => {
    const { sku } = req.params;
    try {
        const [rows] = await pool.query('SELECT * FROM products WHERE sku = ? AND is_active = TRUE', [sku]);
        
        if (rows.length <= 0) {
            return res.status(404).json({ msg: 'Producto no encontrado, está inactivo o sin stock.' });
        }

        const productFromDB = rows[0];
        const productToSend = {
            id: productFromDB.id,
            name: productFromDB.name,
            sku: productFromDB.sku,
            description: productFromDB.description,
            category_id: productFromDB.category_id,
            quantity: productFromDB.quantity,
            price: productFromDB.price,
            cost: productFromDB.cost,
            attributes: productFromDB.attributes || {}
        };

        res.json(productToSend); 

    } catch (error) {
        console.error("Error en getProductBySku:", error);
        res.status(500).json({ msg: 'Ocurrió un error interno al buscar el producto.' });
    }
};

const createProduct = async (req, res) => {
    const { name, sku, description, category_id, quantity, price, cost, attributes } = req.body;
    
    try {
        const [existingRows] = await pool.query('SELECT id, is_active FROM products WHERE sku = ?', [sku]);

        if (existingRows.length > 0) {
            const existingProduct = existingRows[0];
            if (existingProduct.is_active) {
                return res.status(400).json({ msg: `Ya existe un producto activo con el SKU '${sku}'.` });
            }

            await pool.query(
                `UPDATE products SET name = ?, description = ?, category_id = ?, quantity = ?, price = ?, cost = ?, attributes = ?, is_active = TRUE WHERE id = ?`,
                [name, description, category_id, quantity, price, cost, JSON.stringify(attributes || {}), existingProduct.id]
            );
            
            await logAction(req.uid, `Reactivó y actualizó el producto '${name}' (ID: ${existingProduct.id})`);
            const [updatedProduct] = await pool.query('SELECT * FROM products WHERE id = ?', [existingProduct.id]);
            return res.status(200).json(updatedProduct[0]);
        }

        const [result] = await pool.query(
            'INSERT INTO products (name, sku, description, category_id, quantity, price, cost, attributes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [name, sku, description, category_id, quantity, price, cost, JSON.stringify(attributes || {})]
        );
        await logAction(req.uid, `Creó el producto '${name}' (SKU: ${sku}, ID: ${result.insertId})`);
        const [newProduct] = await pool.query('SELECT * FROM products WHERE id = ?', [result.insertId]);
        res.status(201).json(newProduct[0]);

    } catch (error) {
        console.error("Error al crear/actualizar producto:", error);
        res.status(500).json({ msg: 'Error al procesar la solicitud del producto', error });
    }
};

const updateProduct = async (req, res) => {
    const { id } = req.params;
    const { name, sku, description, category_id, quantity, price, cost, attributes } = req.body;
    try {
        await pool.query(
            `UPDATE products SET name = ?, sku = ?, description = ?, category_id = ?, quantity = ?, price = ?, cost = ?, attributes = ? WHERE id = ?`,
            [name, sku, description, category_id, quantity, price, cost, JSON.stringify(attributes || {}), id]
        );
        const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [id]);
        await logAction(req.uid, `Actualizó el producto '${name}' (ID: ${id})`);
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ msg: 'Error al actualizar el producto', error });
    }
};

const bulkImportProducts = async (req, res) => {
    const { products } = req.body;
    if (!products || !Array.isArray(products) || products.length === 0) {
        return res.status(400).json({ msg: 'No se proporcionaron productos válidos para importar.' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [categories] = await connection.query('SELECT id, name FROM categories');
        const categoriesMap = new Map(categories.map(cat => [cat.name.toUpperCase(), cat.id]));

        const commonColumns = ['NOMBRE', 'SKU', 'DESCRIPCION', 'CANTIDAD', 'PRECIO', 'COSTO', 'CATEGORIA'];

        const values = products.map(p => {
            const categoryId = categoriesMap.get(p.CATEGORIA?.toUpperCase());
            if (!categoryId) {
                throw new Error(`La categoría '${p.CATEGORIA}' no existe en la base de datos.`);
            }

            const attributes = {};
            for (const key in p) {
                if (!commonColumns.includes(key.toUpperCase())) {
                    attributes[key] = p[key];
                }
            }

            return [
                p.NOMBRE, p.SKU, p.DESCRIPCION || null, categoryId,
                p.CANTIDAD, p.PRECIO, p.COSTO, JSON.stringify(attributes)
            ];
        });
        
        const query = 'INSERT INTO products (name, sku, description, category_id, quantity, price, cost, attributes) VALUES ?';
        const [result] = await connection.query(query, [values]);
        
        await connection.commit();
        await logAction(req.uid, `Importó masivamente ${result.affectedRows} productos desde un archivo Excel.`);
        res.status(201).json({ msg: `${result.affectedRows} productos han sido importados exitosamente.` });

    } catch (error) {
        await connection.rollback();
        console.error('Error en la importación masiva:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ msg: 'El archivo contiene uno o más SKU que ya existen.' });
        }
        res.status(500).json({ msg: error.message || 'Ocurrió un error en el servidor durante la importación.' });
    } finally {
        connection.release();
    }
};

const deleteProduct = async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('UPDATE products SET is_active = FALSE WHERE id = ?', [id]);
        await logAction(req.uid, `Desactivó el producto con ID: ${id}`);
        res.json({ msg: 'Producto desactivado correctamente' });
    } catch (error) {
        console.error("Error al desactivar producto:", error);
        res.status(500).json({ msg: 'Error al desactivar el producto' });
    }
};

const searchProducts = async (req, res) => {
    const { term } = req.params;
    try {
        const searchTerm = `%${term}%`;
        const [products] = await pool.query(
            `SELECT * FROM products 
             WHERE is_active = TRUE AND quantity > 0 AND (name LIKE ? OR sku LIKE ?)
             LIMIT 10`,
            [searchTerm, searchTerm]
        );
        res.json(products);
    } catch (error) {
        console.error("Error al buscar productos para venta:", error);
        res.status(500).json({ msg: 'Error al buscar productos' });
    }
};

module.exports = {
    getProducts,
    getProductById,
    getProductBySku,
    createProduct,
    updateProduct,
    deleteProduct,
    bulkImportProducts,
    searchProducts
};