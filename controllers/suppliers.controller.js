const pool = require('../db/database');
const { logAction } = require('../helpers/audit.helper');

const getSuppliers = async (req, res) => {
    try {
        const [suppliers] = await pool.query('SELECT * FROM suppliers ORDER BY company_name ASC');
        res.json(suppliers);
    } catch (error) {
        console.error("Error al obtener proveedores:", error);
        res.status(500).json({ msg: 'Error al obtener los proveedores' });
    }
};

const createSupplier = async (req, res) => {
    const { company_name, contact_person, contact_number, email, address, nit } = req.body;
    try {
        const [result] = await pool.query(
            'INSERT INTO suppliers (company_name, contact_person, contact_number, email, address, nit) VALUES (?, ?, ?, ?, ?, ?)',
            [company_name, contact_person, contact_number, email, address, nit]
        );
        await logAction(req.uid, `Creó el proveedor '${company_name}' (ID: ${result.insertId})`);
        const [newSupplier] = await pool.query('SELECT * FROM suppliers WHERE id = ?', [result.insertId]);
        res.status(201).json(newSupplier[0]);
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ msg: 'El NIT del proveedor ya existe.' });
        }
        res.status(500).json({ msg: 'Error al crear el proveedor', error });
    }
};

const updateSupplier = async (req, res) => {
    const { id } = req.params;
    const { company_name, contact_person, contact_number, email, address, nit } = req.body;
    try {
        await pool.query(
            'UPDATE suppliers SET company_name = ?, contact_person = ?, contact_number = ?, email = ?, address = ?, nit = ? WHERE id = ?',
            [company_name, contact_person, contact_number, email, address, nit, id]
        );
        const [updatedSupplier] = await pool.query('SELECT * FROM suppliers WHERE id = ?', [id]);
        await logAction(req.uid, `Actualizó el proveedor '${company_name}' (ID: ${id})`);
        res.json(updatedSupplier[0]);
    } catch (error) {
        res.status(500).json({ msg: 'Error al actualizar el proveedor', error });
    }
};

const deleteSupplier = async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM suppliers WHERE id = ?', [id]);
        await logAction(req.uid, `Eliminó el proveedor con ID: ${id}`);
        res.json({ msg: 'Proveedor eliminado' });
    } catch (error) {
        res.status(500).json({ msg: 'Error al eliminar el proveedor', error });
    }
};

module.exports = { getSuppliers, createSupplier, updateSupplier, deleteSupplier };