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
// Google Service Account
// ------------------
const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });

// ------------------
// Estado temporal de usuarios
// ------------------
const userState = {};

// ------------------
// Funciones Google Sheets
// ------------------
async function verificarNumero(numero) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:B`,
    });

    const rows = res.data.values || [];
    for (let row of rows) {
      const num = parseInt((row[0] || '').toString().trim());
      const estado = (row[1] || '').toString().toLowerCase().trim();
      if (num === numero) return estado === 'disponible';
    }
    return false;
  } catch (error) {
    console.error("❌ Error leyendo hoja:", error.response?.data || error.message);
    return false;
  }
}

async function marcarVendida(numero, cliente, nombre, telefono) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:D`,
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
      range: `${SHEET_NAME}!B${rowIndex}:D${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['vendido', nombre || '', telefono || '']] },
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
            rows: [{ id: "tres_de_oros", title: "Tres de Oros $60.000" }],
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
      const text = message.text?.body?.toLowerCase() || "";
      const interactiveId =
        message.interactive?.button_reply?.id ||
        message.interactive?.list_reply?.id;

      // Imagen (foto del pago)
      if (message.type === "image" && userState[from]?.esperandoPago) {
        await enviarMensaje(
          phone_number_id,
          from,
          "📸 ¡Gracias por tu compra! Hemos recibido tu comprobante. En un momento te enviaremos la foto de tu boleta. 🎟️"
        );
        delete userState[from];
        return res.sendStatus(200);
      }

      // Flujo principal
      if (text.includes("hola") || text.includes("boletas")) {
        await sendInteractiveList(phone_number_id, from);
        userState[from] = { esperandoBoleta: true };
      } 
      else if (userState[from]?.esperandoBoleta) {
        if (interactiveId === "tres_de_oros" || text.includes("tres de oros")) {
          await enviarMensaje(
            phone_number_id,
            from,
            "🎟️ Excelente elección! ¿Deseas una sola boleta o varias?"
          );
          userState[from] = { eligiendoCantidad: true };
        }
      }
      else if (userState[from]?.eligiendoCantidad) {
        if (text.includes("una")) {
          await enviarMensaje(phone_number_id, from, "Perfecto 🙌, ¿qué número deseas?");
          userState[from] = { esperandoNumero: true };
        } else if (text.includes("varias")) {
          await enviarMensaje(phone_number_id, from, "Genial 😎, envíame los números separados por comas (ej: 1, 2, 3)");
          userState[from] = { esperandoVariosNumeros: true };
        } else {
          await enviarMensaje(phone_number_id, from, "Por favor responde 'una' o 'varias'.");
        }
      }
      else if (userState[from]?.esperandoNumero) {
        const numeroDeseado = parseInt(text);
        if (isNaN(numeroDeseado)) {
          await enviarMensaje(phone_number_id, from, "Por favor ingresa un número válido.");
        } else {
          const disponible = await verificarNumero(numeroDeseado);
          if (disponible) {
            userState[from] = { esperandoNombre: true, numeroDeseado };
            await enviarMensaje(phone_number_id, from, `🎯 El número ${numeroDeseado} está disponible. ¿A nombre de quién deseas reservarlo?`);
          } else {
            await enviarMensaje(phone_number_id, from, `😅 El número ${numeroDeseado} ya fue vendido. Por favor elige otro.`);
          }
        }
      } 
      else if (userState[from]?.esperandoVariosNumeros) {
        const numeros = text.split(",").map(n => parseInt(n.trim())).filter(n => !isNaN(n));
        if (numeros.length === 0) {
          await enviarMensaje(phone_number_id, from, "Por favor ingresa al menos un número válido.");
        } else {
          let disponibles = [];
          let vendidos = [];
          for (const n of numeros) {
            const libre = await verificarNumero(n);
            if (libre) disponibles.push(n);
            else vendidos.push(n);
          }

          if (disponibles.length > 0) {
            userState[from] = { esperandoNombreVarios: true, disponibles };
            await enviarMensaje(phone_number_id, from, `✅ Los números ${disponibles.join(", ")} están disponibles. ¿A nombre de quién deseas reservarlos?`);
          } else {
            await enviarMensaje(phone_number_id, from, `😅 Todos los números ingresados ya fueron vendidos. Intenta con otros.`);
          }

          if (vendidos.length > 0) {
            await enviarMensaje(phone_number_id, from, `⚠️ Los siguientes números ya están vendidos: ${vendidos.join(", ")}`);
          }
        }
      }
      else if (userState[from]?.esperandoNombreVarios) {
        const nombre = text.trim();
        const { disponibles } = userState[from];
        for (const n of disponibles) {
          await marcarVendida(n, from, nombre, from);
        }
        await enviarMensaje(phone_number_id, from, `✅ Listo ${nombre}, tus números ${disponibles.join(", ")} han sido reservados.\n💰 Valor total: $${disponibles.length * 60000}\n\n🏦 *Bancolombia:* 123456789\n🏦 *Davivienda:* 987654321\n\nEnvíame la **foto del comprobante de pago** aquí 📸`);
        userState[from] = { esperandoPago: true };
      }
      else if (userState[from]?.esperandoNombre) {
        const nombreCliente = text.trim();
        userState[from] = { esperandoConfirmacion: true, numeroDeseado: userState[from].numeroDeseado, nombre: nombreCliente };
        await enviarMensaje(phone_number_id, from, `Perfecto ${nombreCliente}! ¿Confirmas tu reserva? (responde "sí" o "no")`);
      }
      else if (userState[from]?.esperandoConfirmacion) {
        if (text.includes("sí")) {
          const { numeroDeseado, nombre } = userState[from];
          await marcarVendida(numeroDeseado, from, nombre, from);
          await enviarMensaje(phone_number_id, from, `✅ Listo ${nombre}, tu número ${numeroDeseado} ha sido reservado.\n\nPor favor realiza el pago de $60.000 a una de las siguientes cuentas:\n\n🏦 **Bancolombia:** 123456789\n🏦 **Davivienda:** 987654321\n\nLuego envíame la **foto del comprobante de pago** aquí 📸`);
          userState[from] = { esperandoPago: true };
        } else if (text.includes("no")) {
          userState[from] = { esperandoNumero: true };
          await enviarMensaje(phone_number_id, from, "No hay problema 😄, dime otro número que desees.");
        } else {
          await enviarMensaje(phone_number_id, from, 'Por favor responde con "sí" o "no".');
        }
      } 
      else {
        await enviarMensaje(phone_number_id, from, `👋 ¡Hola! Recibí tu mensaje: "${text}". Si deseas participar en nuestras rifas, escribe "hola" o "boletas" 🎟️`);
      }
    }
  }

  res.sendStatus(200);
});

// ------------------
// Iniciar servidor
// ------------------
const PORT = process.env.PORT || 8080; 
app.listen(PORT, () => console.log(`🚀 Bot corriendo en puerto ${PORT}`));
