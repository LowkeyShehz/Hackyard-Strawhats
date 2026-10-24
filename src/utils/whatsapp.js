/**
 * Nirman Mitra — WhatsApp Business API Client
 * Sends text, image, audio, document messages via Meta Cloud API.
 * In demo mode: logs to console instead of calling real API.
 */

import crypto from 'crypto';
import axios from 'axios';
import config, { isDemoMode } from './config.js';

const API_BASE = config.whatsapp.apiBaseUrl;
const PHONE_NUMBER_ID = config.whatsapp.phoneNumberId;
const API_TOKEN = config.whatsapp.apiToken;

/** True when no real WhatsApp token is configured */
function noWhatsAppToken() {
  return !API_TOKEN || API_TOKEN === 'placeholder' || API_TOKEN.trim() === '';
}

/** Build WhatsApp API URL */
function apiUrl(path = 'messages') {
  return `${API_BASE}/${PHONE_NUMBER_ID}/${path}`;
}

/** Common headers for WhatsApp API */
function headers() {
  return {
    Authorization: `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Send a text message via WhatsApp
 * @param {string} phoneNumber - Recipient phone (international format, no +)
 * @param {string} text - Message body
 */
export async function sendTextMessage(phoneNumber, text) {
  const payload = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'text',
    text: { body: text },
  };

  if (isDemoMode() || noWhatsAppToken()) {
    console.log(`[WhatsApp STUB] Text → ${phoneNumber}: ${text}`);
    return { success: true, demo: true, messageId: `demo-${Date.now()}` };
  }

  try {
    const response = await axios.post(apiUrl(), payload, { headers: headers() });
    return { success: true, messageId: response.data.messages?.[0]?.id };
  } catch (err) {
    console.error('[WhatsApp] sendText failed:', err.response?.status, JSON.stringify(err.response?.data));
    throw err;
  }
}

/**
 * Send an audio message via WhatsApp
 * @param {string} phoneNumber
 * @param {string} audioUrl - Public URL or pre-signed S3 URL to audio file
 */
export async function sendAudioMessage(phoneNumber, audioUrl) {
  const payload = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'audio',
    audio: { link: audioUrl },
  };

  if (isDemoMode() || noWhatsAppToken()) {
    console.log(`[WhatsApp STUB] Audio → ${phoneNumber}: ${audioUrl}`);
    return { success: true, demo: true, messageId: `demo-${Date.now()}` };
  }

  try {
    const response = await axios.post(apiUrl(), payload, { headers: headers() });
    return { success: true, messageId: response.data.messages?.[0]?.id };
  } catch (err) {
    console.error('[WhatsApp] sendAudio failed:', err.response?.status, JSON.stringify(err.response?.data));
    throw err;
  }
}

/**
 * Send an image message via WhatsApp
 * @param {string} phoneNumber
 * @param {string} imageUrl - Public URL or pre-signed S3 URL
 * @param {string} [caption] - Optional image caption
 */
export async function sendImageMessage(phoneNumber, imageUrl, caption) {
  const payload = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'image',
    image: { link: imageUrl, ...(caption && { caption }) },
  };

  if (isDemoMode() || noWhatsAppToken()) {
    console.log(`[WhatsApp STUB] Image → ${phoneNumber}: ${imageUrl}`);
    return { success: true, demo: true, messageId: `demo-${Date.now()}` };
  }

  const response = await axios.post(apiUrl(), payload, { headers: headers() });
  return { success: true, messageId: response.data.messages?.[0]?.id };
}

/**
 * Send a document message via WhatsApp (used for certificates)
 * @param {string} phoneNumber
 * @param {string} docUrl
 * @param {string} filename
 * @param {string} [caption]
 */
export async function sendDocumentMessage(phoneNumber, docUrl, filename, caption) {
  const payload = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'document',
    document: {
      link: docUrl,
      filename,
      ...(caption && { caption }),
    },
  };

  if (isDemoMode() || noWhatsAppToken()) {
    console.log(`[WhatsApp STUB] Document → ${phoneNumber}: ${filename} (${docUrl})`);
    return { success: true, demo: true, messageId: `demo-${Date.now()}` };
  }

  try {
    const response = await axios.post(apiUrl(), payload, { headers: headers() });
    return { success: true, messageId: response.data.messages?.[0]?.id };
  } catch (err) {
    console.error('[WhatsApp] sendDocument failed:', err.response?.status, JSON.stringify(err.response?.data));
    throw err;
  }
}

/**
 * Send a template message via WhatsApp
 * @param {string} phoneNumber
 * @param {string} templateName
 * @param {string} languageCode
 */
export async function sendTemplateMessage(phoneNumber, templateName, languageCode = 'en') {
  const payload = {
    messaging_product: 'whatsapp',
    to: phoneNumber,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
    },
  };

  if (isDemoMode() || noWhatsAppToken()) {
    console.log(`[WhatsApp STUB] Template → ${phoneNumber}: ${templateName} (${languageCode})`);
    return { success: true, demo: true, messageId: `demo-${Date.now()}` };
  }

  try {
    const response = await axios.post(apiUrl(), payload, { headers: headers() });
    return { success: true, messageId: response.data.messages?.[0]?.id };
  } catch (err) {
    console.error('[WhatsApp] sendTemplateMessage failed:', err.response?.status, JSON.stringify(err.response?.data));
    throw err;
  }
}

/**
 * Send a location request message via WhatsApp
 * Shows a "Send Location" button — worker just taps it, no typing needed.
 * @param {string} phoneNumber
 * @param {string} text - Message body shown above the button
 */
export async function sendLocationRequest(phoneNumber, text) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phoneNumber,
    type: 'interactive',
    interactive: {
      type: 'location_request_message',
      body: { text },
      action: { name: 'send_location' },
    },
  };

  if (isDemoMode() || noWhatsAppToken()) {
    console.log(`[WhatsApp STUB] LocationRequest → ${phoneNumber}: ${text}`);
    return { success: true, demo: true, messageId: `demo-${Date.now()}` };
  }

  try {
    const response = await axios.post(apiUrl(), payload, { headers: headers() });
    return { success: true, messageId: response.data.messages?.[0]?.id };
  } catch (err) {
    console.error('[WhatsApp] sendLocationRequest failed:', err.response?.status, JSON.stringify(err.response?.data));
    throw err;
  }
}

/** Post an interactive message (list or reply buttons); logs instead of sending in demo mode */
async function sendInteractive(phoneNumber, interactive, label) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phoneNumber,
    type: 'interactive',
    interactive,
  };

  if (isDemoMode() || noWhatsAppToken()) {
    console.log(`[WhatsApp STUB] ${label} → ${phoneNumber}: ${interactive.body?.text}`);
    return { success: true, demo: true, messageId: `demo-${Date.now()}` };
  }

  try {
    const response = await axios.post(apiUrl(), payload, { headers: headers() });
    return { success: true, messageId: response.data.messages?.[0]?.id };
  } catch (err) {
    console.error(`[WhatsApp] ${label} failed:`, err.response?.status, JSON.stringify(err.response?.data));
    throw err;
  }
}

/**
 * Send a tap-able list menu. The worker's choice comes back as a list_reply whose id is the
 * row id, so routing does not depend on the (translated) row title.
 * @param {string} phoneNumber
 * @param {object} menu
 * @param {string} menu.body - Message text (max 1024 chars)
 * @param {string} menu.button - Label of the button that opens the list (max 20 chars)
 * @param {Array<{id: string, title: string, description?: string}>} menu.rows - Up to 10 rows (title max 24 chars)
 */
export async function sendListMenu(phoneNumber, { body, button, rows }) {
  return sendInteractive(phoneNumber, {
    type: 'list',
    body: { text: body },
    action: {
      button,
      sections: [{ title: 'Nirman Mitra', rows: rows.slice(0, 10) }],
    },
  }, 'sendListMenu');
}

/**
 * Send up to three reply buttons. The choice comes back as a button_reply with the button id.
 * @param {string} phoneNumber
 * @param {string} body - Message text
 * @param {Array<{id: string, title: string}>} buttons - Max 3, title max 20 chars
 */
export async function sendReplyButtons(phoneNumber, body, buttons) {
  return sendInteractive(phoneNumber, {
    type: 'button',
    body: { text: body },
    action: {
      buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
    },
  }, 'sendReplyButtons');
}

/**
 * Download media from WhatsApp by media ID
 * Used when workers send images/audio — fetch the binary content.
 * @param {string} mediaId - WhatsApp media ID from webhook payload
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
export async function downloadMedia(mediaId) {
  if (isDemoMode() || noWhatsAppToken()) {
    console.log(`[WhatsApp STUB] Download media: ${mediaId}`);
    // Return a unique placeholder buffer in demo mode based on mediaId
    return {
      buffer: Buffer.from(`demo-media-placeholder-${mediaId}`),
      contentType: 'application/octet-stream',
    };
  }

  try {
    // Step 1: Get media URL from WhatsApp
    const mediaInfo = await axios.get(`${API_BASE}/${mediaId}`, { headers: headers() });
    const mediaUrl = mediaInfo.data.url;

    // Step 2: Download the actual media binary
    const mediaResponse = await axios.get(mediaUrl, {
      headers: headers(),
      responseType: 'arraybuffer',
    });

    return {
      buffer: Buffer.from(mediaResponse.data),
      contentType: mediaResponse.headers['content-type'] || 'application/octet-stream',
    };
  } catch (err) {
    console.error('[WhatsApp] downloadMedia failed:', err.response?.status, JSON.stringify(err.response?.data));
    throw err;
  }
}

/**
 * Validate the X-Hub-Signature-256 header Meta sends with every webhook POST.
 * Signature = 'sha256=' + hex(HMAC-SHA256(appSecret, rawBody)).
 * @param {string} rawBody - Request body exactly as received
 * @param {string} signatureHeader - X-Hub-Signature-256 header value
 * @returns {boolean}
 */
export function validateMetaSignature(rawBody, signatureHeader) {
  const appSecret = config.whatsapp.appSecret;
  if (!appSecret || !signatureHeader) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Parse every message in an incoming WhatsApp webhook payload.
 * Meta may batch several messages (across entries and changes) into one POST; status
 * updates carry no messages and yield an empty array.
 * @param {object} body - Raw POST body from webhook
 * @returns {object[]} Parsed messages, in payload order
 */
export function parseWebhookMessages(body) {
  const parsed = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value;
      for (const message of value?.messages || []) {
        const contact = value.contacts?.find((c) => c.wa_id === message.from) || value.contacts?.[0];
        const result = parseMessage(message, contact);
        if (result) parsed.push(result);
      }
    }
  }
  return parsed;
}

/**
 * Parse the first message of an incoming WhatsApp webhook payload
 * @param {object} body - Raw POST body from webhook
 * @returns {object|null} Parsed message or null if not a valid message
 */
export function parseWebhookMessage(body) {
  return parseWebhookMessages(body)[0] || null;
}

/** Extract the essential fields of one message from Meta's nested structure */
function parseMessage(message, contact) {
  try {
    const parsed = {
      messageId: message.id,
      from: message.from, // phone number in international format
      timestamp: message.timestamp,
      type: message.type, // text, image, audio, location, document
      contactName: contact?.profile?.name || 'Unknown',
      isForwarded: message.context?.forwarded || false,
    };

    // Extract type-specific content
    switch (message.type) {
      case 'text':
        parsed.text = message.text?.body || '';
        break;
      case 'image':
        parsed.mediaId = message.image?.id;
        parsed.mimeType = message.image?.mime_type;
        parsed.caption = message.image?.caption;
        break;
      case 'audio':
        parsed.mediaId = message.audio?.id;
        parsed.mimeType = message.audio?.mime_type;
        parsed.isVoiceNote = message.audio?.voice || false;
        break;
      case 'location':
        parsed.latitude = message.location?.latitude;
        parsed.longitude = message.location?.longitude;
        parsed.locationName = message.location?.name;
        parsed.locationAddress = message.location?.address;
        break;
      case 'document':
        parsed.mediaId = message.document?.id;
        parsed.mimeType = message.document?.mime_type;
        parsed.filename = message.document?.filename;
        break;
      case 'interactive': {
        // A tapped reply button / list row reads like the worker typing its title
        const reply = message.interactive?.button_reply || message.interactive?.list_reply;
        if (reply) {
          parsed.type = 'text';
          parsed.text = reply.title || '';
          parsed.buttonId = reply.id;
        } else {
          parsed.raw = message;
        }
        break;
      }
      case 'button':
        // Quick-reply button on a template message
        parsed.type = 'text';
        parsed.text = message.button?.text || '';
        parsed.buttonId = message.button?.payload;
        break;
      default:
        parsed.raw = message;
    }

    return parsed;
  } catch (err) {
    console.error('Failed to parse WhatsApp webhook:', err.message);
    return null;
  }
}

export default {
  sendTextMessage,
  sendAudioMessage,
  sendImageMessage,
  sendDocumentMessage,
  sendTemplateMessage,
  sendLocationRequest,
  sendReplyButtons,
  downloadMedia,
  validateMetaSignature,
  parseWebhookMessage,
  parseWebhookMessages,
};
