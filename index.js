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
    range: `${SHEET_NAME}!A:C`,
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
    range: `${SHEET_NAME}!A:C`,
  });

  const rows = res.data.values || [];
  let rowIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (parseInt(rows[i][0]) === numero) {
      rowIndex = i + 1; // Google Sheets empieza en 1
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
  const data = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "🎟️ Dinamicas CC - Rifas Tres de Oros ♣️" },
      body: {
        text: `🎉 ¡Hola! Qué alegría verte 😍
En Rifas Tres de Oros tenemos boleta única: Apuesta tu suerte♣️
🏍️ 2 motos Boxer CT 125
🚙 1 Subaru Forester
🔖 5 millones en oro
🎄 Gran parranda navideña
💰 Valor: $60.000
Selecciona la boleta para asegurar tu oportunidad ✨`,
      },
      footer: { text: "Dinamicas CC" },
      action: {
        button: "Adquirir boleta",
        sections: [
          {
            title: "Boleta",
            rows: [
              { id: "tres_de_oros", title: "Tres de Oros $60.000" } // ≤24 caracteres
            ],
          },
        ],
      },
    },
  };

  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/${phone_number_id}/messages`,
      data,
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
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

      // Texto normal
      let text = message.text?.body?.toLowerCase() || "";
      // Respuesta interactiva (lista/botón)
      let interactiveId =
        message.interactive?.button_reply?.id ||
        message.interactive?.list_reply?.id;

      // --- Lógica de estados ---
      if (text.includes("hola") || text.includes("boletas")) {
        await sendInteractiveList(phone_number_id, from);
        userState[from] = { esperandoBoleta: true };
      } 
      else if (userState[from]?.esperandoBoleta) {
        if (interactiveId === "tres_de_oros" || text.includes("tres de oros")) {
          await enviarMensaje(
            phone_number_id,
            from,
            "🎟️ Excelente elección! Ahora cuéntame, ¿qué número deseas?"
          );
          userState[from] = { esperandoNumero: true };
        }
      } 
      else if (userState[from]?.esperandoNumero) {
        const numeroDeseado = parseInt(text);
        if (isNaN(numeroDeseado)) {
          await enviarMensaje(
            phone_number_id,
            from,
            "Por favor ingresa un número válido, debe ser de 4 cifras."
          );
        } else {
          const disponible = await verificarNumero(numeroDeseado);
          if (disponible) {
            const reply = `🎟️ Tu número ${numeroDeseado} está disponible.
Realiza la transferencia del costo de la boleta, recuerda que tiene un costo de: $60.000 a una de estas cuentas:

Bancolombia (Ahorros): 123456789 - Dinamicas CC
Davivienda (Corriente): 987654321 - Dinamicas CC

¡Muchísima suerte! 🍀`;

            await marcarVendida(numeroDeseado, from);
            delete userState[from];
            await enviarMensaje(phone_number_id, from, reply);
          } else {
            await enviarMensaje(
              phone_number_id,
              from,
              `Lo sentimos 😅, el número ${numeroDeseado} ya no está disponible. Elige otro número.`
            );
          }
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
