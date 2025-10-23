const pool = require('../db/database');

const getCategories = async (req, res) => {
    try {
        const [categories] = await pool.query('SELECT * FROM categories ORDER BY name ASC');
        res.json(categories);
    } catch (error) {
        console.error("Error al obtener categorías:", error);
        res.status(500).json({ msg: 'Error en el servidor al obtener categorías' });
    }
};

const getSubcategories = async (req, res) => {
    try {
        const { categoryId } = req.params;
        const [subcategories] = await pool.query(
            'SELECT * FROM subcategories WHERE category_id = ? ORDER BY name ASC',
            [categoryId]
        );
        res.json(subcategories);
    } catch (error) {
        console.error("Error al obtener subcategorías:", error);
        res.status(500).json({ msg: 'Error en el servidor al obtener subcategorías' });
    }
};

module.exports = {
    getCategories,
    getSubcategories,
};
