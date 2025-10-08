const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// ------------------
// Variables de entorno
// ------------------
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'botpress_dinamicas';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// ------------------
// Estado temporal de usuarios
// ------------------
const userState = {};

// ------------------
// Boletas predefinidas
// ------------------
const boletasDisponibles = [
    { id: "1", title: "Boleta #1" },
    { id: "2", title: "Boleta #2" },
    { id: "3", title: "Boleta #3" },
    { id: "4", title: "Boleta #4" },
    { id: "5", title: "Boleta #5" },
];

// ------------------
// Enviar mensaje WhatsApp
// ------------------
async function enviarMensaje(phone_number_id, to, text) {
    try {
        await axios.post(
            `https://graph.facebook.com/v17.0/${phone_number_id}/messages`,
            {
                messaging_product: "whatsapp",
                to,
                text: { body: text },
            },
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                    "Content-Type": "application/json",
                },
            }
        );
    } catch (error) {
        console.error("Error enviando mensaje:", error.response ? error.response.data : error.message);
    }
}

// ------------------
// Enviar lista interactiva
// ------------------
async function sendInteractiveList(phone_number_id, to) {
    const data = {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
            type: "list",
            header: { type: "text", text: "🎟️ Boletas Dinamicas CC" },
            body: { text: "Selecciona tu boleta disponible:" },
            footer: { text: "Dinamicas CC" },
            action: { button: "Adquirir boleta", sections: [{ title: "Boletas disponibles", rows: boletasDisponibles }] },
        },
    };

    try {
        await axios.post(
            `https://graph.facebook.com/v17.0/${phone_number_id}/messages`,
            data,
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
        );
    } catch (error) {
        console.error("Error enviando lista:", error.response ? error.response.data : error.message);
    }
}

// ------------------
// Webhook GET (Verificación)
// ------------------
app.get("/webhook", (req, res) => {
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (token === VERIFY_TOKEN) return res.status(200).send(challenge);
    else return res.sendStatus(403);
});

// ------------------
// Webhook POST (Mensajes)
// ------------------
app.post("/webhook", async (req, res) => {
    const body = req.body;

    if (body.object === "whatsapp_business_account") {
        const changes = body.entry[0].changes[0].value;

        if (changes.messages && changes.messages.length > 0) {
            const message = changes.messages[0];
            const from = message.from;
            const phone_number_id = changes.metadata.phone_number_id;

            let text = message.text?.body?.toLowerCase() || "";
            let interactiveId =
                message.interactive?.button_reply?.id ||
                message.interactive?.list_reply?.id;

            // --- Lógica de estados ---
            if (text.includes("hola") || text.includes("boletas")) {
                await sendInteractiveList(phone_number_id, from);
                userState[from] = { esperandoBoleta: true };
            } 
            else if (userState[from]?.esperandoBoleta) {
                if (interactiveId) {
                    userState[from] = { esperandoNombre: true, numeroElegido: interactiveId };
                    await enviarMensaje(
                        phone_number_id,
                        from,
                        `🎟️ Excelente! Elegiste la boleta #${interactiveId}. ¿Cuál es tu nombre completo para registrar tu boleta?`
                    );
                }
            } 
            else if (userState[from]?.esperandoNombre) {
                const nombreCliente = message.text?.body?.trim();
                const numeroDeseado = userState[from].numeroElegido;

                const reply = `🎟️ Tu número ${numeroDeseado} ha sido registrado a nombre de ${nombreCliente}.
Realiza la transferencia del costo de la boleta ($60.000) a una de estas cuentas:

Bancolombia (Ahorros): 123456789 - Dinamicas CC
Davivienda (Corriente): 987654321 - Dinamicas CC

¡Muchísima suerte! 🍀`;

                delete userState[from];
                await enviarMensaje(phone_number_id, from, reply);
            } 
            else {
                await enviarMensaje(
                    phone_number_id,
                    from,
                    `Hola! Recibí tu mensaje: "${text}"`
                );
            }
        }
    }

    res.sendStatus(200);
});

// ------------------
// Iniciar servidor
// ------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));
