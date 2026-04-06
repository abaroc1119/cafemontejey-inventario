const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
require('dotenv').config();

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));

// Rutas
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/users', require('./routes/users.routes'));
app.use('/api/products', require('./routes/products.routes'));
app.use('/api/sales', require('./routes/sales.routes'));
app.use('/api/layaway', require('./routes/layaway.routes'));
app.use('/api/dashboard', require('./routes/dashboard.routes'));
app.use('/api/reports', require('./routes/reports.routes'));
app.use('/api/logs', require('./routes/logs.routes'));
app.use('/api/suppliers', require('./routes/suppliers.routes'));
app.use('/api/notifications', require('./routes/notifications.routes'));
app.use('/api/metrics', require('./routes/metrics.routes'));
app.use('/api/categories', require('./routes/categories.routes'));
app.use('/api/customers', require('./routes/customers.routes'));
app.use('/api/config', require('./routes/config.routes'));

// --- NUEVA RUTA DE LOTES ---
app.use('/api/batches', require('./routes/batches.routes'));

// --- RUTA DE LOTES VERDES (materia prima → derivados) ---
app.use('/api/green-lots', require('./routes/greenLots.routes'));

// Iniciar el servidor
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
