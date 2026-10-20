const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
require('dotenv').config();

// Sin JWT_SECRET el servidor arranca pero todo login falla; mejor fallar al inicio.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('FALTA JWT_SECRET (mínimo 32 caracteres) en el .env. El servidor no arranca.');
    process.exit(1);
}

const app = express();

// Si el API corre detrás de un proxy (Render, Railway, Nginx...), define
// TRUST_PROXY=1 para que el límite de intentos vea la IP real del cliente.
if (process.env.TRUST_PROXY) {
    app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
}

// CORS: solo los orígenes del frontend. CORS_ORIGINS admite varios separados por coma,
// p. ej. "https://inventario.cafemontejey.com,https://cafemontejey-inventario-qa.vercel.app".
const allowedOrigins = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);

app.use(cors({
    origin: (origin, cb) => {
        // Peticiones sin Origin (curl, health checks, servidor a servidor) no pasan por CORS.
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
    }
}));
// Aumentamos el límite del body para permitir el JSON de la importación
// histórica (40 filas, bastante amplio para futuros imports).
app.use(express.json({ limit: '10mb' }));
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

// --- RUTA DE LOTES ---
app.use('/api/batches', require('./routes/batches.routes'));

// --- RUTA DE LOTES VERDES (materia prima → derivados) ---
app.use('/api/green-lots', require('./routes/greenLots.routes'));

// --- NUEVOS MÓDULOS: vendedores, comisiones, reimportación histórica ---
app.use('/api/sellers', require('./routes/sellers.routes'));
app.use('/api/commissions', require('./routes/commissions.routes'));
app.use('/api/historical-import', require('./routes/historicalImport.routes'));

// Iniciar el servidor
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
