const nodemailer = require('nodemailer');

/**
 * Transporte SMTP real tomado del .env (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS).
 * Solo si NO hay SMTP configurado y NO estamos en producción se usa una cuenta de
 * prueba de Ethereal (los correos no llegan al destinatario real).
 */
let cachedTransporter = null;

const getTransporter = async () => {
    if (cachedTransporter) return cachedTransporter;

    if (process.env.SMTP_HOST) {
        const port = Number(process.env.SMTP_PORT) || 587;
        cachedTransporter = {
            isTest: false,
            transporter: nodemailer.createTransport({
                host: process.env.SMTP_HOST,
                port,
                secure: port === 465,
                auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
            }),
        };
        return cachedTransporter;
    }

    if (process.env.NODE_ENV === 'production') {
        throw new Error('SMTP no configurado (SMTP_HOST) en producción.');
    }

    const testAccount = await nodemailer.createTestAccount();
    cachedTransporter = {
        isTest: true,
        transporter: nodemailer.createTransport({
            host: 'smtp.ethereal.email',
            port: 587,
            secure: false,
            auth: { user: testAccount.user, pass: testAccount.pass },
        }),
    };
    return cachedTransporter;
};

const sendPasswordResetEmail = async (userEmail, token) => {
    try {
        const { transporter, isTest } = await getTransporter();

        // Use FRONTEND_URL env var if provided (e.g. https://inventario.cafemontejey.com)
        const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
        const resetLink = `${FRONTEND_URL.replace(/\/$/, '')}/reset-password/${encodeURIComponent(token)}`;

        const mailOptions = {
            from: process.env.MAIL_FROM || '"Café Montejey - Inventario" <no-reply@cafemontejey.com>',
            to: userEmail,
            subject: 'Recuperación de Contraseña',
            html: `
                <h1>Recuperación de Contraseña</h1>
                <p>Has solicitado restablecer tu contraseña.</p>
                <p>Haz clic en el siguiente enlace para continuar (expira en 15 minutos):</p>
                <a href="${resetLink}" style="background-color: #5D1227; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
                    Restablecer Contraseña
                </a>
                <p>Si no solicitaste este cambio, ignora este correo.</p>
            `,
        };

        const info = await transporter.sendMail(mailOptions);
        // Solo en modo prueba se muestra la vista previa; nunca en producción,
        // porque contiene un enlace de reseteo válido.
        if (isTest) {
            console.log('Correo de prueba (Ethereal). Vista previa: %s', nodemailer.getTestMessageUrl(info));
        }
    } catch (error) {
        console.error('Error al enviar correo de recuperación:', error.message);
        throw new Error('No se pudo enviar el correo de recuperación.');
    }
};

module.exports = {
    sendPasswordResetEmail
};
