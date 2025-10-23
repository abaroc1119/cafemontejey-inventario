// Función para obtener la tasa de IVA actual
const getIvaRate = (req, res) => {
    try {
        // En este punto, el valor está "hardcodeado" para facilidad.
        // Si el día de mañana el IVA cambia al 20%, solo tienes que cambiar este número.
        // En una versión más avanzada, este valor podría venir de la base de datos.
        const ivaRate = 19.0; 

        res.json({
            rate: ivaRate
        });
    } catch (error) {
        console.error("Error al obtener la tasa de IVA:", error);
        res.status(500).json({ msg: 'Error interno del servidor.' });
    }
};

module.exports = {
    getIvaRate
};