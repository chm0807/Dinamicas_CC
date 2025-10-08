const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// ------------------
// Variables de entorno
// ------------------
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'botpress_dinamicas';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME;

// ------------------
// Google Service Account (JSON string en variable)
// ------------------
const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

// ------------------
// Estado temporal de usuarios
// ------------------
const userState = {};

// ------------------
// Google Sheets Auth
// ------------------
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });

// ------------------
// Funciones Google Sheets
// ------------------
async function verificarNumero(numero) {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:B`,
    });

    const rows = res.data.values || [];
    for (let row of rows) {
        if (parseInt(row[0]) === numero) {
            return row[1].toLowerCase() === 'disponible';
        }
    }
    return false;
}

async function marcarVendida(numero, cliente) {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:B`,
    });

    const rows = res.data.values || [];
    let rowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
        if (parseInt(rows[i][0]) === numero) {
            rowIndex = i + 1;
            break;
        }
    }

    if (rowIndex !== -1) {
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!B${rowIndex}:C${rowIndex}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [['vendido', cliente]] },
        });
    }
}

async function getBoletasDisponibles() {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:B`,
    });

    const rows = res.data.values || [];
    const disponibles = [];
    for (let row of rows) {
        const numero = row[0];
        const estado = row[1].toLowerCase();
        if (estado === "disponible") {
            let title = `Boleta #${numero}`;
            if (title.length > 24) title = title.substring(0, 24);
            disponibles.push({ id: numero.toString(), title });
        }
    }
    return disponibles;
}

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
        console.error(
            "Error enviando mensaje:",
            error.response ? error.response.data : error.message
        );
    }
}

// ------------------
// Enviar lista interactiva
// ------------------
async function sendInteractiveList(phone_number_id, to) {
    const rows = await getBoletasDisponibles();

    if (rows.length === 0) {
        await enviarMensaje(phone_number_id, to, "😅 Lo siento, no hay boletas disponibles por ahora.");
        return;
    }

    const data = {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
            type: "list",
            header: { type: "text", text: "🎟️ Boletas Dinamicas CC" },
            body: { text: "Selecciona tu boleta disponible:" },
            footer: { text: "Dinamicas CC" },
            action: { button: "Adquirir boleta", sections: [{ title: "Boletas disponibles", rows }] },
        },
    };

    try {
        await axios.post(
            `https://graph.facebook.com/v17.0/${phone_number_id}/messages`,
            data,
            { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
        );
    } catch (error) {
        console.error(
            "Error enviando lista:",
            error.response ? error.response.data : error.message
        );
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
                    userState[from] = { esperandoNombre: true, numeroElegido: parseInt(interactiveId) };
                    await enviarMensaje(
                        phone_number_id,
                        from,
                        "🎟️ Excelente! ¿Cuál es tu nombre completo para registrar tu boleta?"
                    );
                }
            } 
            else if (userState[from]?.esperandoNombre) {
                const nombreCliente = message.text?.body?.trim();
                const numeroDeseado = userState[from].numeroElegido;

                const disponible = await verificarNumero(numeroDeseado);
                if (disponible) {
                    await marcarVendida(numeroDeseado, nombreCliente);
                    const reply = `🎟️ Tu número ${numeroDeseado} ha sido registrado a nombre de ${nombreCliente}.
Realiza la transferencia del costo de la boleta ($60.000) a una de estas cuentas:

Bancolombia (Ahorros): 123456789 - Dinamicas CC
Davivienda (Corriente): 987654321 - Dinamicas CC

¡Muchísima suerte! 🍀`;
                    delete userState[from];
                    await enviarMensaje(phone_number_id, from, reply);
                } else {
                    await enviarMensaje(
                        phone_number_id,
                        from,
                        `Lo sentimos 😅, el número ${numeroDeseado} ya no está disponible. Elige otro número.`
                    );
                    delete userState[from];
                }
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
