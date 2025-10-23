const nodemailer = require('nodemailer');

const sendPasswordResetEmail = async (userEmail, token) => {
    try {
        const testAccount = await nodemailer.createTestAccount();

        const transporter = nodemailer.createTransport({
            host: 'smtp.ethereal.email',
            port: 587,
            secure: false,
            auth: {
                user: testAccount.user,
                pass: testAccount.pass,
            },
        });

        const resetLink = `http://localhost:5173/reset-password/${token}`;

        const mailOptions = {
            from: '"GestioNexus" <soporte@gestioneexus.com>',
            to: userEmail,
            subject: 'Recuperación de Contraseña',
            html: `
                <h1>Recuperación de Contraseña</h1>
                <p>Has solicitado restablecer tu contraseña.</p>
                <p>Haz clic en el siguiente enlace para continuar (expira en 15 minutos):</p>
                <a href="${resetLink}" style="background-color: #5D1227; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
                    Restablecer Contraseña
                </a>
            `,
        };

        const info = await transporter.sendMail(mailOptions);
        console.log('Correo de prueba enviado. URL para previsualizarlo: %s', nodemailer.getTestMessageUrl(info));

    } catch (error) {
        console.error('Error al enviar correo de prueba:', error);
        throw new Error('No se pudo enviar el correo de recuperación.');
    }
};

module.exports = { 
    sendPasswordResetEmail 
};