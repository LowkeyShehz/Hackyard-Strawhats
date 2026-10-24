/**
 * Nirman Mitra — Message Handler (WhatsApp Webhook)
 * Central router: receives all WhatsApp messages and routes to appropriate flows.
 * GET  /webhook/whatsapp → Meta webhook verification (hub.challenge)
 * POST /webhook/whatsapp → incoming messages, authenticated via X-Hub-Signature-256
 *
 * Routing logic:
 * 1. New worker (no phone match) → Registration flow
 * 2. Onboarding worker → Route by conversation state step
 * 3. Active worker → Attendance check-in (Triple Verification) / progress queries
 */

import crypto from 'crypto';
import { LexRuntimeV2Client, RecognizeTextCommand } from '@aws-sdk/client-lex-runtime-v2';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import config, { apiResponse, isDemoMode, istDate } from '../utils/config.js';
import {
  getWorkerByPhone,
  getConversationState,
  saveConversationState,
  updateItem,
  queryItems,
  getItem,
  getWorkerAttendanceLogs,
} from '../utils/dynamodb.js';
import {
  parseWebhookMessages,
  validateMetaSignature,
  downloadMedia,
  sendTextMessage,
  sendAudioMessage,
  sendDocumentMessage,
  sendImageMessage,
  sendLocationRequest,
  sendListMenu,
  sendReplyButtons,
} from '../utils/whatsapp.js';
import { uploadWorkerMedia, generatePresignedUrl } from '../utils/s3.js';
import { putItemIfAbsent } from '../services/conditionalWrite.js';
import {
  hasConsent,
  isConsentReply,
  sendConsentNotice,
  consentRequiredText,
  consentThanksText,
  recordConsent,
} from '../services/consent.js';
import {
  handleGreeting,
  handleNameCapture,
  handleAadhaarUpload,
  handleSelfieCapture,
  finalizeRegistration,
} from '../services/registration.js';
import {
  transcribeVoice,
  parseLanguageSwitch,
  generateAndUploadVoice,
  getGreetingMessage,
  getStepPrompt,
} from '../services/voiceProcessor.js';
import { complete } from '../providers/llm.js';
import { withRetry } from '../utils/retryHelper.js';
import { t, KN, languageName } from '../utils/i18n.js';
import { handler as attendanceHandler } from './attendanceProcessor.js';
import { handler as certificateHandler } from './certificateGenerator.js';

// Optional Lex V2 intent layer (used only when LEX_BOT_ID is configured)
const lexClient = new LexRuntimeV2Client({ region: config.aws.region });
const lambdaClient = new LambdaClient({ region: config.aws.region });
const LEX_BOT_ID = process.env.LEX_BOT_ID || '';
const LEX_BOT_ALIAS_ID = process.env.LEX_BOT_ALIAS_ID || '';
const LEX_LOCALE = process.env.LEX_LOCALE_ID || 'en_US';

const ASYNC_EVENT_SOURCE = 'nirman-mitra.webhook';

export const handler = async (event) => {
  // Second half of an async webhook: the verified payload, re-invoked by the first half below
  if (event?.source === ASYNC_EVENT_SOURCE) {
    const results = await handleIncomingMessages(event.payload);
    console.log('Webhook results (async):', results.map((r) => r.body).join(' '));
    return { status: 'processed' };
  }

  const method = event.httpMethod || event.requestContext?.http?.method;

  try {
    if (method === 'GET') {
      return handleWebhookVerification(event);
    }

    if (method === 'POST') {
      const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body || '', 'base64').toString('utf8')
        : event.body || '';

      if (!validateMetaSignature(rawBody, getHeader(event, 'x-hub-signature-256'))) {
        console.warn('Rejected webhook POST — invalid signature');
        return apiResponse(403, { error: 'Invalid signature' });
      }

      const payload = JSON.parse(rawBody);

      // Meta expects a quick 200 and API Gateway stops waiting at 29 s, while transcription and
      // certificate generation can take longer. So acknowledge now and process in a second,
      // asynchronous invocation of this function. Duplicate message ids are skipped downstream.
      if (config.asyncWebhook) {
        await lambdaClient.send(new InvokeCommand({
          FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({ source: ASYNC_EVENT_SOURCE, payload })),
        }));
        return apiResponse(200, { status: 'received' });
      }

      const results = await handleIncomingMessages(payload);
      console.log('Webhook results:', results.map((r) => r.body).join(' '));
      return apiResponse(200, { status: 'received' });
    }

    return apiResponse(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('MessageHandler error:', err);
    // Acknowledge so Meta does not keep retrying the same delivery
    return apiResponse(200, { status: 'error_logged' });
  }
};

// ─────────────────────────────────────────────────────────
// GET — WhatsApp Webhook Verification
// ─────────────────────────────────────────────────────────

function handleWebhookVerification(event) {
  const params = event.queryStringParameters || {};
  const mode = params['hub.mode'];
  const token = params['hub.verify_token'];
  const challenge = params['hub.challenge'];

  if (mode === 'subscribe' && config.whatsapp.verifyToken && token === config.whatsapp.verifyToken) {
    console.log('Webhook verification successful');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: challenge,
    };
  }

  console.warn('Webhook verification failed — token mismatch');
  return apiResponse(403, { error: 'Verification failed' });
}

function getHeader(event, name) {
  const headers = event.headers || {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : '';
}

// ─────────────────────────────────────────────────────────
// POST — Incoming WhatsApp Message
// ─────────────────────────────────────────────────────────

// Message types a worker sends on purpose. Reactions, stickers, "unsupported" and system
// messages are ignored: they must not register a worker or advance a flow.
const USER_CONTENT_TYPES = new Set(['text', 'image', 'audio', 'video', 'document', 'location', 'interactive']);

// Processed WhatsApp message ids are remembered this long, covering Meta's redelivery window
const DEDUP_TTL_SECONDS = 2 * 24 * 60 * 60;
// Selfie, location and voice note must all arrive within this window
const CHECKIN_WINDOW_MS = 10 * 60 * 1000;

/** One-time two-digit number the worker must say in the check-in voice note */
function newPasscode() {
  return Math.floor(Math.random() * 90) + 10;
}

const VOICE_PROMPT_OPENINGS = {
  location: { en: 'Location received! ', hi: 'Location mil gaya! ', kn: 'ಸ್ಥಳ ಸ್ವೀಕರಿಸಲಾಗಿದೆ! ' },
  selfie: { en: 'Selfie received! ', hi: 'Selfie mil gaya! ', kn: 'ಸೆಲ್ಫಿ ಸ್ವೀಕರಿಸಲಾಗಿದೆ! ' },
};

/**
 * The check-in voice request, always with the one-time number. Skipping is still accepted
 * (it goes to review) but is not advertised, since only a spoken note can auto-approve.
 */
function voicePromptText(language, passcode, opening) {
  const lead = opening ? t(language, opening) : '';
  return lead + t(language, {
    en: `Now hold the mic button and tell us:\n• What work did you do today?\n• Which floor or area?\n• Please say the number "${passcode}"\n\nExample: "Today I did painting on 3rd floor, ${passcode}"`,
    hi: `Ab mic button dabake bataiye:\n• Aaj kya kaam kiya?\n• Kaun si jagah pe?\n• Kripya number "${passcode}" boliye\n\nJaise: "Aaj maine 3rd floor pe painting ka kaam kiya, ${passcode}"`,
    kn: `ಈಗ ಮೈಕ್ ಬಟನ್ ಒತ್ತಿ ಹಿಡಿದು ಹೇಳಿ:\n• ಇಂದು ನೀವು ಯಾವ ಕೆಲಸ ಮಾಡಿದ್ದೀರಿ?\n• ಯಾವ ಮಹಡಿ ಅಥವಾ ಪ್ರದೇಶ?\n• ದಯವಿಟ್ಟು "${passcode}" ಸಂಖ್ಯೆಯನ್ನು ಹೇಳಿ\n\nಉದಾಹರಣೆಗೆ: "ಇಂದು ನಾನು 3ನೇ ಮಹಡಿಯಲ್ಲಿ ಪೇಂಟಿಂಗ್ ಮಾಡಿದ್ದೇನೆ, ${passcode}"`,
  });
}

/** Handle every message in a webhook payload (Meta may batch several into one POST) */
async function handleIncomingMessages(body) {
  const messages = parseWebhookMessages(body);
  if (messages.length === 0) {
    // Not a message event (could be status update) — acknowledge
    return [apiResponse(200, { status: 'not_a_message' })];
  }

  const results = [];
  for (const message of messages) {
    try {
      results.push(await handleIncomingMessage(message));
    } catch (err) {
      // One failing message must not stop the rest of the batch
      console.error(`Error handling message ${message.messageId}:`, err);
      results.push(apiResponse(200, { status: 'error', error: err.message }));
    }
  }
  return results;
}

/**
 * Record a message id; false if it was already processed. Meta redelivers a message when it
 * does not get a timely 200, and the second delivery must not run the flow again.
 */
async function markMessageProcessed(messageId) {
  if (!messageId) return true;
  return putItemIfAbsent(
    config.tables.conversation,
    {
      worker_id: `msg#${messageId}`,
      session_id: 'dedup',
      ttl: Math.floor(Date.now() / 1000) + DEDUP_TTL_SECONDS,
      created_at: new Date().toISOString(),
    },
    { worker_id: `msg#${messageId}`, session_id: 'dedup' },
  );
}

async function handleIncomingMessage(message) {
  if (!USER_CONTENT_TYPES.has(message.type)) {
    console.log(`Ignoring ${message.type} message from ${message.from}`);
    return apiResponse(200, { status: 'ignored_message_type', type: message.type });
  }

  if (!(await markMessageProcessed(message.messageId))) {
    console.log(`Ignoring redelivered message ${message.messageId}`);
    return apiResponse(200, { status: 'duplicate_message' });
  }

  console.log(`Incoming ${message.type} from ${message.from}:`, JSON.stringify(message).substring(0, 200));

  const phoneNumber = message.from;

  // Look up worker by phone number
  const existingWorker = await getWorkerByPhone(phoneNumber);
  const language = existingWorker?.preferred_language || 'hi';

  // --- ANTI-FRAUD CHECKS (Phase 1) ---
  if (message.isForwarded) {
    console.warn(`[Anti-Fraud] Blocked forwarded message from ${phoneNumber}`);
    const text = t(language, {
      en: 'Please record a new photo/voice note directly in this chat. Forwarded messages are not accepted.',
      hi: 'Kripya is chat mein seedhe naya photo ya voice note record karein. Forward kiye gaye message manya nahi hain.',
      kn: KN.antiFraudForwarded || 'ದಯವಿಟ್ಟು ಹೊಸ ಫೋಟೋ/ವಾಯ್ಸ್ ನೋಟ್ ಕಳುಹಿಸಿ. ಫಾರ್ವರ್ಡ್ ಮಾಡಿದ ಸಂದೇಶಗಳನ್ನು ಸ್ವೀಕರಿಸಲಾಗುವುದಿಲ್ಲ.',
    });
    await sendTextMessage(phoneNumber, text);
    return apiResponse(200, { status: 'rejected_forwarded' });
  }

  if (message.type === 'location' && (message.locationName || message.locationAddress)) {
    console.warn(`[Anti-Fraud] Blocked dropped pin from ${phoneNumber}`);
    const text = t(language, {
      en: 'Please share your live "Current Location", not a dropped pin.',
      hi: 'Kripya apna live "Current Location" share karein, dropped pin nahi.',
      kn: KN.antiFraudDroppedPin || 'ದಯವಿಟ್ಟು ನಿಮ್ಮ ಲೈವ್ "ಕರೆಂಟ್ ಲೊಕೇಶನ್" ಶೇರ್ ಮಾಡಿ.',
    });
    await sendTextMessage(phoneNumber, text);
    return apiResponse(200, { status: 'rejected_dropped_pin' });
  }

  if (message.type === 'audio' && !message.isVoiceNote) {
    console.warn(`[Anti-Fraud] Blocked audio file upload from ${phoneNumber}`);
    const text = t(language, {
      en: 'Please hold the microphone button to record a voice note. Audio file uploads are not accepted.',
      hi: 'Kripya voice note record karne ke liye mic button dabakar rakhein. Audio file accept nahi hoti.',
      kn: KN.antiFraudAudioFile || 'ದಯವಿಟ್ಟು ಮೈಕ್ರೊಫೋನ್ ಬಟನ್ ಹಿಡಿದು ವಾಯ್ಸ್ ನೋಟ್ ರೆಕಾರ್ಡ್ ಮಾಡಿ.',
    });
    await sendTextMessage(phoneNumber, text);
    return apiResponse(200, { status: 'rejected_audio_file' });
  }
  // -----------------------------------

  if (!existingWorker) {
    // New worker — start registration
    return await handleNewWorker(phoneNumber, message);
  }

  // Existing worker — route based on profile status
  const { profile_status, worker_id: workerId } = existingWorker;

  // "English" / "Hindi" / "ಕನ್ನಡ" switches language at any step
  const switchTo = message.type === 'text'
    ? LANGUAGE_BUTTONS[message.buttonId] || parseLanguageSwitch(message.text)
    : null;

  // No documents, images or voice are collected until the worker agrees to the purpose notice
  if (!hasConsent(existingWorker)) {
    return await handleConsentGate(existingWorker, message, switchTo);
  }

  if (switchTo) {
    return await handleLanguageSwitch(workerId, existingWorker, message, switchTo);
  }

  if (profile_status === 'onboarding') {
    return await handleOnboardingWorker(workerId, existingWorker, message);
  }

  if (profile_status === 'active') {
    return await handleActiveWorker(workerId, existingWorker, message);
  }

  // Unknown status
  return apiResponse(200, { status: 'unknown_profile_status' });
}

// ─────────────────────────────────────────────────────────
// Route: New Worker (Registration Start)
// ─────────────────────────────────────────────────────────

async function handleNewWorker(phoneNumber, message) {
  const textContent = message.text || message.caption || '';

  // Only the phone number and detected language are stored; the purpose notice comes first
  const result = await handleGreeting(phoneNumber, textContent, { awaitConsent: true });

  if (!result.isExisting) {
    await sendConsentNotice(phoneNumber, result.language);
    return apiResponse(200, { status: 'consent_requested', workerId: result.workerId });
  }

  // Send response via WhatsApp
  await sendTextMessage(phoneNumber, result.responseText);
  if (result.audioUrl) {
    await sendAudioMessage(phoneNumber, result.audioUrl);
  }

  return apiResponse(200, {
    status: 'greeting_sent',
    workerId: result.workerId,
    isExisting: result.isExisting,
  });
}

// ─────────────────────────────────────────────────────────
// Consent gate (PRD FR-1): nothing is collected before "I agree"
// ─────────────────────────────────────────────────────────

// A regional greeting before consent picks the notice language, as it does for a new number.
// English greetings ("hi") keep the saved language, since Hindi speakers type them too.
const GREETING_LANGUAGES = [
  ['kn', /^\s*(namaskara|ನಮಸ್ಕಾರ)/iu],
  ['hi', /^\s*(namaste|namaskar|नमस्ते|नमस्कार)/iu],
];

function greetingLanguage(text) {
  return GREETING_LANGUAGES.find(([, pattern]) => pattern.test(text || ''))?.[0] || null;
}

async function handleConsentGate(worker, message, explicitSwitch) {
  const phoneNumber = message.from;
  const workerId = worker.worker_id;
  let language = worker.preferred_language || 'hi';
  const switchTo = explicitSwitch || (message.type === 'text' ? greetingLanguage(message.text) : null);

  if (switchTo && switchTo !== language) {
    language = switchTo;
    await updateItem(
      config.tables.workers,
      { worker_id: workerId },
      'SET preferred_language = :lang, updated_at = :ts',
      { ':lang': language, ':ts': new Date().toISOString() },
    );
  }

  if (!switchTo && isConsentReply(message)) {
    await recordConsent(workerId, language);
    await sendTextMessage(phoneNumber, consentThanksText(language));

    // Continue where the worker is: a new worker starts registration with the name step
    if (worker.profile_status === 'onboarding') {
      const state = await getConversationState(workerId);
      const step = !state?.current_step || state.current_step === 'awaiting_consent' ? 'awaiting_name' : state.current_step;
      await saveConversationState(workerId, workerId, {
        ...(state || {}),
        current_step: step,
        preferred_language: language,
        retry_count: state?.retry_count || 0,
      });
      const next = step === 'awaiting_name' ? getGreetingMessage(language) : onboardingStepReminder(step, language);
      if (next) await sendTextAndVoice(phoneNumber, workerId, next, language, 'consent-next');
    } else {
      await sendTextMessage(phoneNumber, t(language, {
        en: 'You can continue: send a selfie to log today\'s attendance.',
        hi: 'Ab aap aage badh sakte hain: aaj ki attendance ke liye selfie bhejiye.',
        kn: KN.consentContinueActive,
      }));
    }
    return apiResponse(200, { status: 'consent_recorded', workerId });
  }

  // Anything else (a photo, a voice note, text) is not stored: explain, then show the notice
  if (!switchTo && message.type !== 'text') {
    await sendTextMessage(phoneNumber, consentRequiredText(language));
  }
  await sendConsentNotice(phoneNumber, language);
  return apiResponse(200, { status: 'consent_requested', workerId });
}

// ─────────────────────────────────────────────────────────
// Language Switch (any step)
// ─────────────────────────────────────────────────────────

async function handleLanguageSwitch(workerId, worker, message, language) {
  await updateItem(
    config.tables.workers,
    { worker_id: workerId },
    'SET preferred_language = :lang, updated_at = :ts',
    { ':lang': language, ':ts': new Date().toISOString() },
  );

  let responseText = t(language, {
    en: 'Language changed to English.',
    hi: 'Bhasha badal di gayi hai.',
    kn: KN.languageChanged,
  });

  // Remind an onboarding worker what the current step expects
  if (worker.profile_status === 'onboarding') {
    const state = await getConversationState(workerId);
    const step = worker.admin_flag ? 'admin_flagged' : state?.current_step || 'awaiting_name';
    const reminder = onboardingStepReminder(step, language);
    if (reminder) responseText += `\n\n${reminder}`;
  }

  await sendTextAndVoice(message.from, workerId, responseText, language, 'language-changed');
  return apiResponse(200, { status: 'language_changed', workerId, language });
}

/** What an onboarding step is waiting for, as a short prompt */
function onboardingStepReminder(step, language) {
  switch (step) {
    case 'awaiting_name':
      return getStepPrompt('awaiting_name', language);
    case 'awaiting_aadhaar':
      return t(language, { en: 'Please send a photo of your Aadhaar card.', hi: 'Kripya apne Aadhaar card ka photo bhejiye.', kn: KN.aadhaarReminder });
    case 'awaiting_selfie':
      return t(language, { en: 'Please send a selfie photo.', hi: 'Kripya apna selfie photo bhejiye.', kn: KN.selfieReminder });
    case 'awaiting_registration_location':
      return t(language, {
        en: 'Please share your work site location using the button, or send "ok" to skip.',
        hi: 'Kripya apne kaam ki jagah ka location share karein, ya "ok" bhejiye skip karne ke liye.',
        kn: KN.registrationLocationReminder,
      });
    case 'admin_flagged':
      return adminFlaggedText(language);
    default:
      return null;
  }
}

function adminFlaggedText(language) {
  return t(language, {
    en: 'Your document is with an admin for review. We will message you here once it is checked.',
    hi: 'Aapka document admin ke paas review ke liye hai. Check hone par hum aapko yahin message karenge.',
    kn: KN.adminFlagged,
  });
}

// ─────────────────────────────────────────────────────────
// Route: Onboarding Worker (In-Progress Registration)
// ─────────────────────────────────────────────────────────

async function handleOnboardingWorker(workerId, worker, message) {
  const phoneNumber = message.from;
  const language = worker.preferred_language || 'hi';

  // Get current conversation state. A worker flagged for an admin stays flagged even after
  // the conversation row expires, instead of restarting registration.
  const state = await getConversationState(workerId);
  const currentStep = worker.admin_flag ? 'admin_flagged' : state?.current_step || 'awaiting_name';
  const retryCount = state?.retry_count || 0;
  const sessionId = worker.worker_id;

  console.log(`Onboarding step for ${workerId}: ${currentStep}, message type: ${message.type}`);

  let result;

  try {
    switch (currentStep) {
      case 'awaiting_name':
        result = await processNameStep(workerId, message, language);
        break;

      case 'awaiting_aadhaar':
        result = await processAadhaarStep(workerId, message, language, retryCount);
        break;

      case 'awaiting_selfie':
        result = await processSelfieStep(workerId, message, language);
        break;

      case 'awaiting_registration_location':
        result = await processRegistrationLocationStep(workerId, message, language);
        break;

      case 'finalizing':
        result = await finalizeRegistration(workerId, language);
        result.nextStep = 'completed';
        break;

      case 'admin_flagged':
        result = { responseText: adminFlaggedText(language), nextStep: 'admin_flagged', consumesRetry: false };
        break;

      default:
        result = {
          responseText: t(language, {
            en: 'Please send your name to continue registration.',
            hi: 'Kripya apna naam bhejiye registration jari rakhne ke liye.',
            kn: KN.sendNameToContinue,
          }),
          nextStep: 'awaiting_name',
        };
    }

    // If next step is registration location, send the location request button
    if (result.nextStep === 'awaiting_registration_location') {
      await sendTextMessage(phoneNumber, result.responseText);
      if (result.audioUrl) {
        await sendAudioMessage(phoneNumber, result.audioUrl);
      }
      // Send location request button
      try {
        const locText = t(language, {
          en: 'Tap the button below to share your work site location.',
          hi: 'Apne kaam ki jagah ka location share karne ke liye neeche button dabayein.',
          kn: KN.registrationLocationButton,
        });
        await sendLocationRequest(phoneNumber, locText);
      } catch (err) {
        console.warn('[Registration] Location request button failed:', err.message);
      }

      await saveConversationState(workerId, sessionId, {
        current_step: 'awaiting_registration_location',
        preferred_language: language,
        retry_count: 0,
      });

      return apiResponse(200, {
        status: 'onboarding_step_processed',
        step: currentStep,
        nextStep: 'awaiting_registration_location',
      });
    }

    // If next step is finalizing, auto-chain immediately (don't wait for another message)
    if (result.nextStep === 'finalizing') {
      await sendTextMessage(phoneNumber, result.responseText);
      if (result.audioUrl) {
        await sendAudioMessage(phoneNumber, result.audioUrl);
      }

      // Auto-finalize
      const finalResult = await finalizeRegistration(workerId, language);
      await sendTextMessage(phoneNumber, finalResult.responseText);
      if (finalResult.audioUrl) {
        await sendAudioMessage(phoneNumber, finalResult.audioUrl);
      }

      return apiResponse(200, {
        status: 'onboarding_complete',
        step: 'finalizing',
        nextStep: 'completed',
      });
    }

    // Update conversation state with next step. Staying on a step counts as a retry unless the
    // step says otherwise (wrong message type, service outage).
    if (result.nextStep && result.nextStep !== 'completed') {
      let nextRetryCount = 0;
      if (result.nextStep === currentStep) {
        nextRetryCount = result.consumesRetry === false ? retryCount : retryCount + 1;
      }
      await saveConversationState(workerId, sessionId, {
        current_step: result.nextStep,
        preferred_language: language,
        retry_count: nextRetryCount,
      });
    }

    // Send response
    await sendTextMessage(phoneNumber, result.responseText);
    if (result.audioUrl) {
      await sendAudioMessage(phoneNumber, result.audioUrl);
    }

    return apiResponse(200, {
      status: 'onboarding_step_processed',
      step: currentStep,
      nextStep: result.nextStep,
    });
  } catch (err) {
    console.error(`Error in onboarding step ${currentStep}:`, err);

    const errorText = t(language, {
      en: 'Something went wrong. Please try again.',
      hi: 'Kuch problem ho gayi. Kripya dobara koshish karein.',
      kn: KN.tryAgain,
    });
    await sendTextMessage(phoneNumber, errorText);

    return apiResponse(200, { status: 'error', step: currentStep, error: err.message });
  }
}

// ─────────────────────────────────────────────────────────
// Step Processors
// ─────────────────────────────────────────────────────────

// A bare greeting at the name step is not a name (e.g. the worker never got the greeting and
// says hello again)
const GREETING_ONLY = /^(?:hi+|hello|helo|hey|hlo|namaste|namaskar|namaskara|namaskaram|vanakkam|good morning|नमस्ते|नमस्कार|ನಮಸ್ಕಾರ)[\s!.]*$/iu;

async function processNameStep(workerId, message, language) {
  let audioBuffer = null;
  let textMessage = null;

  if (message.type === 'text' && GREETING_ONLY.test((message.text || '').trim())) {
    return { responseText: getGreetingMessage(language), nextStep: 'awaiting_name', consumesRetry: false };
  }

  if (message.type === 'audio') {
    const media = await downloadMedia(message.mediaId);
    audioBuffer = media.buffer;
  } else if (message.type === 'text') {
    textMessage = message.text;
  } else {
    // Unsupported type for this step
    return {
      responseText: t(language, {
        en: 'Please say or type your name.',
        hi: 'Kripya apna naam boliye ya type kariye.',
        kn: KN.sayName,
      }),
      nextStep: 'awaiting_name',
    };
  }

  return handleNameCapture(workerId, audioBuffer, textMessage, language);
}

async function processAadhaarStep(workerId, message, language, retryCount) {
  if (message.type !== 'image') {
    // Only a failed photo counts against the Aadhaar attempts
    return {
      responseText: t(language, {
        en: 'Please send a photo of your Aadhaar card.',
        hi: 'Kripya apne Aadhaar card ka photo bhejiye.',
        kn: KN.aadhaarReminder,
      }),
      nextStep: 'awaiting_aadhaar',
      consumesRetry: false,
    };
  }

  const media = await downloadMedia(message.mediaId);
  return handleAadhaarUpload(workerId, media.buffer, language, retryCount);
}

async function processSelfieStep(workerId, message, language) {
  if (message.type !== 'image') {
    return {
      responseText: t(language, {
        en: 'Please send a selfie photo.',
        hi: 'Kripya apna selfie photo bhejiye.',
        kn: KN.selfieReminder,
      }),
      nextStep: 'awaiting_selfie',
    };
  }

  const media = await downloadMedia(message.mediaId);
  return handleSelfieCapture(workerId, media.buffer, language);
}

async function processRegistrationLocationStep(workerId, message, language) {
  if (message.type === 'location') {
    // Store the worker's site location
    await updateItem(
      config.tables.workers,
      { worker_id: workerId },
      'SET registration_location = :loc, updated_at = :ts',
      {
        ':loc': {
          latitude: message.latitude,
          longitude: message.longitude,
        },
        ':ts': new Date().toISOString(),
      },
    );

    const responseText = t(language, {
      en: 'Location saved! Finalizing your registration...',
      hi: 'Location save ho gaya! Aapka registration poora kar rahe hain...',
      kn: KN.registrationLocationSaved,
    });
    const audioUrl = await generateAndUploadVoice(workerId, responseText, language, 'location-saved');
    return { responseText, audioUrl, nextStep: 'finalizing' };
  }

  // If they send text "skip" or "ok", skip location
  if (message.type === 'text') {
    const lower = (message.text || '').toLowerCase().trim();
    if (/\b(ok|skip|done|haan|bas)\b/.test(lower)) {
      const responseText = t(language, {
        en: 'Location skipped. Finalizing your registration...',
        hi: 'Location skip kiya. Aapka registration poora kar rahe hain...',
        kn: KN.registrationLocationSkipped,
      });
      return { responseText, audioUrl: null, nextStep: 'finalizing' };
    }
  }

  // Not a location message — re-prompt
  const responseText = t(language, {
    en: 'Please share your work site location using the button, or send "ok" to skip.',
    hi: 'Kripya apne kaam ki jagah ka location share karein, ya "ok" bhejiye skip karne ke liye.',
    kn: KN.registrationLocationReminder,
  });
  return { responseText, audioUrl: null, nextStep: 'awaiting_registration_location' };
}

// ─────────────────────────────────────────────────────────
// Route: Active Worker — Attendance Check-In & Queries
// ─────────────────────────────────────────────────────────

async function handleActiveWorker(workerId, worker, message) {
  const phoneNumber = message.from;
  const language = worker.preferred_language || 'hi';

  // Check attendance flow state first
  let state = await getConversationState(workerId);

  // A check-in must be finished within CHECKIN_WINDOW_MS of the selfie, so a selfie taken
  // at home cannot be paired with a location shared at the site hours later
  if (state?.pending_selfie_key && state.pending_selfie_at && Date.now() - state.pending_selfie_at > CHECKIN_WINDOW_MS) {
    state = { current_step: 'active', preferred_language: language };
    await saveConversationState(workerId, workerId, state);
    const continuesCheckin = message.type === 'location' || message.type === 'audio'
      || (message.type === 'text' && !(message.buttonId && BUTTON_INTENTS[message.buttonId]));
    if (continuesCheckin) {
      await sendTextMessage(phoneNumber, t(language, {
        en: 'Your check-in expired because the selfie is more than 10 minutes old. Please send a fresh selfie to start again.',
        hi: 'Aapka check-in samay khatam ho gaya, selfie 10 minute se purani hai. Kripya nayi selfie bhejkar dobara shuru karein.',
        kn: KN.checkinExpired,
      }));
      return apiResponse(200, { status: 'checkin_expired', workerId });
    }
  }
  const attendanceStep = state?.current_step;

  // Text messages — check if we're in attendance flow first
  if (message.type === 'text') {
    // Menu and language taps are commands, never the answer to a check-in step
    if (message.buttonId && BUTTON_INTENTS[message.buttonId]) {
      return await handleActiveWorkerText(workerId, worker, message);
    }
    // If awaiting voice, "ok"/"done"/"skip"/any short text skips voice and processes attendance
    if (attendanceStep === 'awaiting_voice' && state?.pending_selfie_key) {
      const lower = (message.text || '').toLowerCase().trim();
      if (lower.length < 20 || /\b(ok|done|skip|haan|ha|theek|bas)\b/.test(lower)) {
        return await processFullAttendance(workerId, worker, language, state, null, 'none');
      }
      // Longer text is kept as the work description, but only a spoken note can auto-approve
      return await processFullAttendance(workerId, worker, language, state, message.text, 'text');
    }
    // If awaiting location, "skip" skips GPS
    if (attendanceStep === 'awaiting_location' && state?.pending_selfie_key) {
      const lower = (message.text || '').toLowerCase().trim();
      if (/\b(ok|skip|done|haan|bas)\b/.test(lower)) {
        // Skip location, go to voice request (a skipped location goes to review)
        const passcode = newPasscode();
        await saveConversationState(workerId, workerId, {
          ...state,
          current_step: 'awaiting_voice',
          pending_latitude: null,
          pending_longitude: null,
          passcode,
        });
        await sendTextMessage(phoneNumber, voicePromptText(language, passcode, null));
        return apiResponse(200, { status: 'location_skipped_awaiting_voice', workerId });
      }
    }
    return await handleActiveWorkerText(workerId, worker, message);
  }

  // Image: selfie for attendance — store it and request location
  if (message.type === 'image') {
    if (attendanceStep === 'awaiting_location' || attendanceStep === 'awaiting_voice') {
      // Worker sent another selfie — restart attendance flow
    }
    return await handleSelfiePendingLocation(workerId, worker, message, language);
  }

  // Location message: store GPS, then ask for voice note
  if (message.type === 'location') {
    // Accept location if we have a pending selfie (in awaiting_location OR awaiting_voice state)
    if (state?.pending_selfie_key && (attendanceStep === 'awaiting_location' || attendanceStep === 'awaiting_voice')) {
      const passcode = newPasscode();

      // Store location, move to voice step
      await saveConversationState(workerId, workerId, {
        ...state,
        current_step: 'awaiting_voice',
        pending_latitude: message.latitude,
        pending_longitude: message.longitude,
        passcode,
      });
      await sendTextMessage(phoneNumber, voicePromptText(language, passcode, VOICE_PROMPT_OPENINGS.location));
      return apiResponse(200, { status: 'location_stored_awaiting_voice', workerId });
    }
    // Location without prior selfie
    const responseText = t(language, {
      en: 'Location received! Now send a selfie to start attendance.',
      hi: 'Location mil gaya! Ab selfie bhejiye attendance shuru karne ke liye.',
      kn: KN.locationNoSelfie,
    });
    await sendTextMessage(phoneNumber, responseText);
    return apiResponse(200, { status: 'location_received_no_selfie', workerId });
  }

  // Audio: if awaiting voice for attendance, use it. Otherwise voice AI conversation.
  if (message.type === 'audio') {
    if (attendanceStep === 'awaiting_voice' && state?.pending_selfie_key) {
      // Transcribe and process attendance
      try {
        const media = await downloadMedia(message.mediaId);
        const transcription = await transcribeVoice(media.buffer, language, workerId);
        console.log(`[Attendance Voice] Worker ${workerId}: "${transcription}"`);
        return await processFullAttendance(workerId, worker, language, state, transcription || null);
      } catch (err) {
        console.warn('[Attendance Voice] Transcription failed, processing without:', err.message);
        return await processFullAttendance(workerId, worker, language, state, null);
      }
    }
    return await handleVoiceConversation(workerId, worker, message, language);
  }

  const responseText = t(language, {
    en: 'Send a selfie + voice note to log attendance, or type "progress" to check your status.',
    hi: 'Attendance ke liye selfie + voice note bhejiye, ya "progress" type karein apna status dekhne ke liye.',
    kn: KN.activeGuidance,
  });
  await sendTextMessage(phoneNumber, responseText);
  return apiResponse(200, { status: 'guidance_sent', workerId });
}

// ─────────────────────────────────────────────────────────
// Active Worker: Text Message Handler (Intent Detection)
// ─────────────────────────────────────────────────────────

async function handleActiveWorkerText(workerId, worker, message) {
  const phoneNumber = message.from;
  const language = worker.preferred_language || 'hi';
  const text = (message.text || '').trim();

  // A tapped menu row or button carries its id; route by id so translated titles never matter
  const tapped = message.buttonId && BUTTON_INTENTS[message.buttonId];
  if (tapped) {
    return await executeIntent({ ...tapped, confidence: 100, source: 'button', transcript: text }, workerId, worker, phoneNumber, language);
  }

  // Detect intent and execute
  const intent = await detectIntent(text, language);
  return await executeIntent(intent, workerId, worker, phoneNumber, language);
}

// ─────────────────────────────────────────────────────────
// Voice Conversational AI
// Step 1: Transcribe the voice note
// Step 2: Detect intent (keywords, optional Lex, then LLM)
// Layer 3: Polly TTS response in preferred language
// ─────────────────────────────────────────────────────────

async function handleVoiceConversation(workerId, worker, message, language) {
  const phoneNumber = message.from;

  try {
    // Step 1: Download and transcribe the voice note
    const media = await downloadMedia(message.mediaId);
    const transcription = await transcribeVoice(media.buffer, language, workerId);

    console.log(`[VoiceAI] Worker ${workerId} said: "${transcription}"`);

    if (!transcription || transcription.length < 2) {
      const responseText = t(language, {
        en: 'I could not understand the voice note. Please try again in a quieter place, or type your question.',
        hi: 'Voice note samajh nahi aaya. Kripya shant jagah se dobara boliye, ya apna sawaal type kariye.',
        kn: KN.voiceUnclear,
      });
      await sendTextAndVoice(phoneNumber, workerId, responseText, language, 'voice-retry');
      return apiResponse(200, { status: 'voice_unclear', workerId });
    }

    // Step 2: Detect intent from transcription
    const intent = await detectIntent(transcription, language);

    console.log(`[VoiceAI] Detected intent: ${intent.type} (confidence: ${intent.confidence})`);

    // Step 3: Execute intent and get response
    const result = await executeIntent(intent, workerId, worker, phoneNumber, language);

    return result;
  } catch (err) {
    console.error('[VoiceAI] Error:', err.message);
    const errorText = t(language, {
      en: 'Something went wrong. Please try again or type your question.',
      hi: 'Kuch problem ho gayi. Dobara koshish kariye ya apna sawaal type kariye.',
      kn: KN.voiceError,
    });
    await sendTextMessage(phoneNumber, errorText);
    return apiResponse(200, { status: 'voice_error', workerId, error: err.message });
  }
}

// ─────────────────────────────────────────────────────────
// Intent Detection
// Layer 1: Lex V2 (optional; structured intents, confidence ≥ 70%)
// Layer 2: LLM NLU (free-form, when Lex is absent or < 70%)
// Layer 0: Fast keyword matching (no API call needed)
// ─────────────────────────────────────────────────────────

// Lex intent → our internal intent mapping
const LEX_INTENT_MAP = {
  CheckProgress: 'check_progress',
  LogAttendance: 'log_attendance',
  RequestCertificate: 'request_certificate',
  GetHelp: 'help',
  Greeting: 'greeting',
  FallbackIntent: null, // Lex doesn't know → go to the LLM
};

const LLM_INTENTS = new Set([
  'check_progress', 'request_certificate', 'log_attendance', 'help', 'greeting',
  'today_status', 'my_days', 'change_language', 'menu',
]);

// Self-service menu rows and language buttons: id → intent
const BUTTON_INTENTS = {
  menu_today: { type: 'today_status' },
  menu_days: { type: 'my_days' },
  menu_progress: { type: 'check_progress' },
  menu_card: { type: 'request_certificate' },
  menu_checkin: { type: 'log_attendance' },
  menu_language: { type: 'change_language' },
  menu_help: { type: 'help' },
};

// Language picker buttons → language code (handled by the any-step language switch)
const LANGUAGE_BUTTONS = { lang_kn: 'kn', lang_hi: 'hi', lang_en: 'en' };
const DEMO_INTENTS = new Set(['demo_fail', 'demo_certificate']);

function isDemoPhone(phoneNumber) {
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  return Boolean(digits) && config.demoPhoneNumbers.includes(digits);
}

// Checked in order: certificate before progress, as for the romanized keywords
const KANNADA_INTENT_KEYWORDS = [
  ['menu', /^ಮೆನು$/u],
  ['today_status', /ಇಂದಿನ ಹಾಜರಿ|^ಇಂದು$|^ಇವತ್ತು$/u],
  ['my_days', /ನನ್ನ ದಿನ/u],
  ['change_language', /ಭಾಷೆ/u],
  ['request_certificate', /ಸರ್ಟಿಫಿಕೇಟ್|ಪ್ರಮಾಣ ?ಪತ್ರ|ಕಾರ್ಡ್/u],
  ['check_progress', /ಪ್ರಗತಿ|ಪ್ರೋಗ್ರೆಸ್|ಎಷ್ಟು ದಿನ|ಸ್ಟೇಟಸ್/u],
  ['log_attendance', /ಹಾಜರಿ|ಸೆಲ್ಫಿ/u],
  ['help', /ಸಹಾಯ|ಹೆಲ್ಪ್/u],
  ['greeting', /ನಮಸ್ಕಾರ|ಹಲೋ/u],
];

async function detectIntent(text, language) {
  const lower = (text || '').toLowerCase();

  // Layer 0: Fast keyword matching (no API call needed for obvious intents)
  // Demo triggers for showcasing review queue and certificate flow
  if (/\b(test review|demo fail|demo review)\b/.test(lower)) {
    return { type: 'demo_fail', confidence: 99, source: 'keyword', transcript: text };
  }
  if (/\b(test certificate|demo certificate|demo cert)\b/.test(lower)) {
    return { type: 'demo_certificate', confidence: 99, source: 'keyword', transcript: text };
  }

  // Self-service commands (short phrases, so work descriptions like "aaj maine plaster kiya" don't match)
  const phrase = lower.replace(/[?!.]+$/, '').trim();
  if (/^(menu|options|मेनू)$/.test(phrase)) {
    return { type: 'menu', confidence: 99, source: 'keyword', transcript: text };
  }
  if (/^(aaj|today|aaj ki haziri|aaj ka status|today status|aaj haziri|आज|आज की हाज़िरी|आज की हाजिरी)$/.test(phrase)) {
    return { type: 'today_status', confidence: 95, source: 'keyword', transcript: text };
  }
  if (/\b(mere din|my days|history|din dikhao|mera record|my record|meri haziri)\b|मेरे दिन/.test(lower)) {
    return { type: 'my_days', confidence: 95, source: 'keyword', transcript: text };
  }
  if (/\b(language|bhasha|bhaasha)\b|भाषा/.test(lower)) {
    return { type: 'change_language', confidence: 95, source: 'keyword', transcript: text };
  }

  // Certificate before progress: "certificate status" / "certificate kab milega" is about the certificate
  if (/\b(certificate|praman|patra|download|sanad|card)\b/.test(lower)) {
    return { type: 'request_certificate', confidence: 95, source: 'keyword', transcript: text };
  }
  // Only explicit day-count phrases: a bare "din" ("aaj ka din accha tha") is not a progress query
  if (/\b(progress|status|update|kitne din|din kitne|how many days|(?:days|din) (?:left|remaining|baaki|baki|bache|hue|logged))\b/.test(lower)) {
    return { type: 'check_progress', confidence: 95, source: 'keyword', transcript: text };
  }
  if (/\b(attendance|haziri|check.?in|selfie|log)\b/.test(lower)) {
    return { type: 'log_attendance', confidence: 90, source: 'keyword', transcript: text };
  }
  if (/\b(help|madad|sahayata|kya kar|how|kaise)\b/.test(lower)) {
    return { type: 'help', confidence: 90, source: 'keyword', transcript: text };
  }
  if (/\b(hello|hi|namaskar|namaste|good morning|suprabhat)\b/.test(lower)) {
    return { type: 'greeting', confidence: 95, source: 'keyword', transcript: text };
  }

  // Kannada-script keywords (\b does not work next to non-ASCII letters)
  const kannada = KANNADA_INTENT_KEYWORDS.find(([, re]) => re.test(text || ''));
  if (kannada) {
    return { type: kannada[0], confidence: 90, source: 'keyword', transcript: text };
  }

  // Layer 1: Lex V2 — structured intent recognition (if bot is configured)
  if (LEX_BOT_ID && LEX_BOT_ALIAS_ID) {
    try {
      const lexResult = await withRetry(
        () => lexClient.send(
          new RecognizeTextCommand({
            botId: LEX_BOT_ID,
            botAliasId: LEX_BOT_ALIAS_ID,
            localeId: LEX_LOCALE,
            sessionId: `worker-${Date.now()}`,
            text,
          }),
        ),
        { label: 'LexV2:RecognizeText' },
      );

      const lexIntent = lexResult.interpretations?.[0];
      const lexConfidence = Math.round(
        (lexIntent?.nluConfidence?.score || 0) * 100,
      );
      const lexIntentName = lexIntent?.intent?.name;
      const mappedIntent = LEX_INTENT_MAP[lexIntentName];

      console.log(`[LexV2] Intent: ${lexIntentName}, Confidence: ${lexConfidence}%`);

      // Use Lex result if confidence >= 70% and we have a valid mapping
      if (mappedIntent && lexConfidence >= 70) {
        return {
          type: mappedIntent,
          confidence: lexConfidence,
          source: 'lex',
          transcript: text,
        };
      }

      // Lex < 70% or FallbackIntent → fall through to the LLM (Layer 2)
      console.log(`[LexV2] Low confidence (${lexConfidence}%), falling back to LLM NLU`);
    } catch (err) {
      console.warn('[LexV2] Failed, falling back to LLM NLU:', err.message);
    }
  }

  // Layer 2: LLM NLU for ambiguous or complex queries
  try {
    const prompt = `You are the voice assistant for Nirman Mitra, a construction worker welfare platform. A worker sent a voice message. Classify their intent.

Worker said: "${text}"
Language: ${languageName(language)}

Possible intents:
- check_progress: Worker wants to know how many days logged, remaining days, or percentage
- request_certificate: Worker wants their certificate, download link, or asks about eligibility
- log_attendance: Worker wants to mark today's attendance
- help: Worker is confused, asking what they can do, or needs guidance
- greeting: Worker is just saying hello
- today_status: Worker asks whether today's attendance is done or verified
- my_days: Worker wants to see the list or history of days they worked
- change_language: Worker wants replies in a different language
- menu: Worker wants to see the options or menu
- other: Anything else (describe briefly)

Respond in EXACTLY this JSON format (no markdown):
{"intent": "check_progress", "confidence": 85, "detail": "brief explanation"}`;

    const response = await complete({
      prompt,
      json: true,
      maxTokens: 100,
      cacheTtlSeconds: 3600,
    });

    const jsonStr = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result = JSON.parse(jsonStr);

    // Only public intents may come from the LLM; anything else (including the demo intents) is help
    const intentType = LLM_INTENTS.has(result.intent) ? result.intent : 'help';

    return {
      type: intentType,
      confidence: Math.min(100, Math.max(0, Number(result.confidence) || 70)),
      detail: result.detail || '',
      source: 'llm',
      transcript: text,
    };
  } catch (err) {
    console.warn('[IntentDetection] LLM NLU failed, defaulting to help:', err.message);
    return { type: 'help', confidence: 50, source: 'fallback', transcript: text };
  }
}

// ─────────────────────────────────────────────────────────
// Intent Executor — routes detected intent to actions
// ─────────────────────────────────────────────────────────

async function executeIntent(intent, workerId, worker, phoneNumber, language) {
  const daysLogged = worker.total_days_logged || 0;
  const threshold = config.certificateThreshold;
  const daysRemaining = Math.max(0, threshold - daysLogged);
  const pct = Math.round((daysLogged / threshold) * 100);
  const name = worker.name || '';

  // Demo shortcuts write attendance and issue certificates, so only team numbers may use them
  if (DEMO_INTENTS.has(intent.type) && !isDemoPhone(phoneNumber)) {
    console.warn(`[Intent] Demo intent ${intent.type} blocked for non-team number`);
    intent = { ...intent, type: 'help' };
  }

  switch (intent.type) {
    case 'demo_fail': {
      // Create a low-confidence attendance entry for review queue demo. It goes on the most recent
      // IST date without a log (conditional write), so a real log is never overwritten.
      const timestamp = new Date().toISOString();
      const demoLog = {
        worker_id: workerId,
        timestamp,
        site_id: 'SITE-DEMO-001',
        site_name: 'Greenfield Metro Station',
        verification_status: 'pending_review',
        confidence: 52,
        face_confidence: 48,
        geo_confidence: 65,
        voice_confidence: 40,
        geo_location: { latitude: 'recorded', longitude: 'recorded', distance_meters: 380 },
        voice_details: { activity: 'unclear audio', location_mention: null, is_work_related: false },
        flagged_reason: 'Low face confidence: 48% | Voice note not work-related',
        is_off_hours: false,
        created_at: timestamp,
      };
      let logDate = null;
      for (let daysAgo = 0; daysAgo < 30 && !logDate; daysAgo++) {
        const date = istDate(Date.now() - daysAgo * 86400000);
        const written = await putItemIfAbsent(
          config.tables.attendance,
          { ...demoLog, log_date: date },
          { worker_id: workerId, log_date: date },
        );
        if (written) logDate = date;
      }
      const responseText = t(language, {
        en: 'Attendance submitted for admin review due to low confidence. Check the admin dashboard review queue.',
        hi: 'Attendance admin review ke liye bhej di gayi — confidence kam thi. Admin dashboard pe review queue dekhiye.',
        kn: KN.demoFail,
      });
      await sendTextMessage(phoneNumber, responseText);
      return apiResponse(200, { status: 'demo_fail_created', workerId, logDate });
    }

    case 'demo_certificate': {
      // Fast-track certificate for demo: eligibility counts verified logs, so fill past dates that
      // have no log yet with approved demo logs (real logs are never overwritten), then generate
      const { putItem } = await import('../utils/dynamodb.js');
      const existingLogs = await queryItems(config.tables.attendance, 'worker_id = :wid', { ':wid': workerId });
      const takenDates = new Set(existingLogs.map((l) => l.log_date));
      let verified = existingLogs.filter(
        (l) => l.verification_status === 'auto_approved' || l.verification_status === 'approved',
      ).length;
      for (let daysAgo = 1; verified < config.certificateThreshold; daysAgo++) {
        const logDate = istDate(Date.now() - daysAgo * 86400000);
        if (takenDates.has(logDate)) continue;
        await putItem(config.tables.attendance, {
          worker_id: workerId,
          log_date: logDate,
          timestamp: new Date().toISOString(),
          verification_status: 'approved',
          site_id: 'SITE-DEMO-001',
          site_name: 'Demo Construction Site',
          admin_action: 'demo',
          admin_justification: 'Demo certificate shortcut',
        });
        verified++;
      }
      await updateItem(
        config.tables.workers,
        { worker_id: workerId },
        'SET total_days_logged = :days',
        { ':days': verified },
      );
      const certText = t(language, {
        en: `Demo mode: Set your days to ${config.certificateThreshold}. Generating certificate now...`,
        hi: `Demo mode: Aapke din ${config.certificateThreshold} set kiye. Certificate bana rahe hain...`,
        kn: KN.demoCertificate(config.certificateThreshold),
      });
      await sendTextMessage(phoneNumber, certText);
      await triggerCertificateGeneration(workerId, phoneNumber, language);
      return apiResponse(200, { status: 'demo_certificate_triggered', workerId });
    }

    case 'check_progress': {
      const responseText = t(language, {
        en: `${name}, you have logged ${daysLogged} of ${threshold} days (${pct}%). ${daysRemaining > 0 ? `${daysRemaining} days remaining.` : 'You are eligible for your certificate!'}`,
        hi: `${name}, aapne ${threshold} mein se ${daysLogged} din log kiye hain (${pct}%). ${daysRemaining > 0 ? `${daysRemaining} din aur baaki hain.` : 'Aap certificate ke liye eligible hain!'}`,
        kn: KN.progress(name, daysLogged, threshold, pct, daysRemaining),
      });
      await sendTextAndVoice(phoneNumber, workerId, responseText, language, 'progress');
      return apiResponse(200, { status: 'progress_sent', workerId, intent: intent.type, daysLogged, daysRemaining });
    }

    case 'request_certificate': {
      // Asking again after the certificate was issued re-sends the same PDF
      const existingCert = await findLatestCertificate(workerId);
      if (existingCert) {
        await sendCertificateDocument(phoneNumber, existingCert, language);
        if (existingCert.credential_jwt && existingCert.qr_s3_key) {
          await sendCredentialQr(phoneNumber, existingCert.qr_s3_key, language);
        }
        return apiResponse(200, { status: 'certificate_resent', workerId, intent: intent.type });
      }
      if (daysLogged < threshold) {
        const responseText = t(language, {
          en: `${name}, you need ${daysRemaining} more days to be eligible for a certificate. Keep logging attendance daily!`,
          hi: `${name}, certificate ke liye ${daysRemaining} din aur chahiye. Har din attendance log karte rahiye!`,
          kn: KN.certificateNotReady(name, daysRemaining),
        });
        await sendTextAndVoice(phoneNumber, workerId, responseText, language, 'cert-not-ready');
        return apiResponse(200, { status: 'certificate_not_eligible', workerId, intent: intent.type });
      }
      // Eligible — trigger certificate
      await triggerCertificateGeneration(workerId, phoneNumber, language);
      return apiResponse(200, { status: 'certificate_triggered', workerId, intent: intent.type });
    }

    case 'log_attendance': {
      const responseText = t(language, {
        en: 'To log attendance:\n1. Send a selfie photo\n2. Share your location (tap the button)\n3. Send a voice note about your work\n\nStart by sending a selfie!',
        hi: 'Attendance ke liye:\n1. Selfie photo bhejiye\n2. Location share karein (button dabayein)\n3. Kaam ka voice note bhejiye\n\nPehle selfie bhejiye!',
        kn: KN.logAttendanceGuide,
      });
      await sendTextAndVoice(phoneNumber, workerId, responseText, language, 'attendance-guide');
      return apiResponse(200, { status: 'attendance_guidance_sent', workerId, intent: intent.type });
    }

    case 'greeting': {
      const responseText = t(language, {
        en: `Hello ${name}! I am Nirman Mitra, your digital work companion. You have ${daysLogged} days logged. Send a selfie to log attendance, or ask me about your progress.`,
        hi: `Namaskar ${name}! Main Nirman Mitra hoon, aapka digital saathi. Aapke ${daysLogged} din log hain. Attendance ke liye selfie bhejiye, ya apna progress poochiye.`,
        kn: KN.greetingActive(name, daysLogged),
      });
      await sendTextAndVoice(phoneNumber, workerId, responseText, language, 'greeting');
      return apiResponse(200, { status: 'greeting_sent', workerId, intent: intent.type });
    }

    case 'menu': {
      await sendSelfServiceMenu(phoneNumber, language);
      return apiResponse(200, { status: 'menu_sent', workerId, intent: intent.type });
    }

    case 'today_status': {
      const log = await getItem(config.tables.attendance, { worker_id: workerId, log_date: istDate() });
      const status = log?.verification_status;
      const site = log?.site_name && log.site_name !== 'Unknown Site' ? log.site_name : '';
      let responseText;
      if (status === 'auto_approved' || status === 'approved') {
        responseText = t(language, {
          en: `Today's attendance is verified ✅${site ? ` (${site})` : ''}`,
          hi: `Aaj ki haziri verify ho gayi ✅${site ? ` (${site})` : ''}`,
          kn: KN.todayVerified(site),
        });
      } else if (status === 'pending_review') {
        responseText = t(language, {
          en: "Today's attendance is under admin review ⏳. We will let you know soon.",
          hi: 'Aaj ki haziri admin review mein hai ⏳. Jaldi batayenge.',
          kn: KN.todayPending,
        });
      } else if (status === 'rejected') {
        responseText = t(language, {
          en: "Today's attendance could not be verified ❌. Please send a selfie again.",
          hi: 'Aaj ki haziri verify nahi ho saki ❌. Kripya dobara selfie bhejiye.',
          kn: KN.todayRejected,
        });
      } else {
        responseText = t(language, {
          en: 'No attendance yet today. Send a selfie to mark it.',
          hi: 'Aaj abhi haziri nahi lagi. Haziri ke liye selfie bhejiye.',
          kn: KN.todayNone,
        });
      }
      await sendTextAndVoice(phoneNumber, workerId, responseText, language, 'today-status');
      return apiResponse(200, { status: 'today_status_sent', workerId, intent: intent.type, attendance: status || 'none' });
    }

    case 'my_days': {
      const logs = await getWorkerAttendanceLogs(workerId);
      const verifiedDays = new Set(
        logs.filter((l) => l.verification_status === 'auto_approved' || l.verification_status === 'approved').map((l) => l.log_date),
      ).size;
      let responseText;
      if (logs.length === 0) {
        responseText = t(language, {
          en: 'No attendance yet. Send a selfie for your first day.',
          hi: 'Abhi tak koi haziri nahi. Pehle din ke liye selfie bhejiye.',
          kn: KN.myDaysEmpty,
        });
      } else {
        const icon = { auto_approved: '✅', approved: '✅', pending_review: '⏳', rejected: '❌' };
        const lines = [...logs]
          .sort((a, b) => String(b.log_date).localeCompare(String(a.log_date)))
          .slice(0, 7)
          .map((l) => {
            const [, mm, dd] = String(l.log_date).split('-');
            const site = l.site_name && l.site_name !== 'Unknown Site' ? ` · ${l.site_name}` : '';
            return `${icon[l.verification_status] || '•'} ${dd}/${mm}${site}`;
          });
        const header = t(language, {
          en: `${verifiedDays} of ${threshold} days verified. Recent attendance:`,
          hi: `${threshold} mein se ${verifiedDays} din verify hue. Haal ki haziri:`,
          kn: KN.myDaysHeader(verifiedDays, threshold),
        });
        responseText = `${header}\n${lines.join('\n')}`;
      }
      await sendTextMessage(phoneNumber, responseText);
      return apiResponse(200, { status: 'my_days_sent', workerId, intent: intent.type, verifiedDays });
    }

    case 'change_language': {
      await sendReplyButtons(phoneNumber, t(language, {
        en: 'Choose your language:',
        hi: 'Apni bhasha chuniye:',
        kn: KN.languagePrompt,
      }), [
        { id: 'lang_kn', title: 'ಕನ್ನಡ' },
        { id: 'lang_hi', title: 'हिन्दी' },
        { id: 'lang_en', title: 'English' },
      ]);
      return apiResponse(200, { status: 'language_prompt_sent', workerId, intent: intent.type });
    }

    case 'help':
    default: {
      const responseText = t(language, {
        en: `${name}, here is what I can do:\n• Send a selfie + voice note → Log attendance\n• Say "progress" → Check your days\n• Say "certificate" → Request certificate\n\nYou have ${daysLogged} days logged, ${daysRemaining} remaining.`,
        hi: `${name}, main yeh kar sakta hoon:\n• Selfie + voice note bhejiye → Attendance log\n• "Progress" boliye → Apne din dekhiye\n• "Certificate" boliye → Certificate maangiye\n\nAapke ${daysLogged} din log hain, ${daysRemaining} baaki.`,
        kn: KN.help(name, daysLogged, daysRemaining),
      });
      await sendTextAndVoice(phoneNumber, workerId, responseText, language, 'help');
      await sendSelfServiceMenu(phoneNumber, language);
      return apiResponse(200, { status: 'help_sent', workerId, intent: intent.type });
    }
  }
}

// ─────────────────────────────────────────────────────────
// Helper: Send text + Polly voice response
// ─────────────────────────────────────────────────────────

async function sendTextAndVoice(phoneNumber, workerId, text, language, label) {
  try {
    await sendTextMessage(phoneNumber, text);
  } catch (err) {
    console.error('[sendTextAndVoice] sendText failed:', err.response?.status, err.response?.data?.error?.message || err.message);
    return; // Don't attempt voice if text itself failed
  }
  try {
    const audioUrl = await generateAndUploadVoice(workerId, text, language, label);
    if (audioUrl) {
      await sendAudioMessage(phoneNumber, audioUrl);
    }
  } catch (err) {
    console.warn('[VoiceAI] Polly TTS failed, text already sent:', err.message);
  }
}

// ─────────────────────────────────────────────────────────
// Step 1: Worker sends selfie → store it, request location
// ─────────────────────────────────────────────────────────

async function handleSelfiePendingLocation(workerId, worker, message, language) {
  const phoneNumber = message.from;

  try {
    // Download media
    const media = await downloadMedia(message.mediaId);

    // ANTI-FRAUD: Duplicate Image Detection (Phase 2)
    const imageHash = crypto.createHash('sha256').update(media.buffer).digest('hex');
    const recentAttendance = await queryItems(config.tables.attendance, 'worker_id = :wid', { ':wid': workerId });
    if (recentAttendance.some(record => record.image_hash === imageHash)) {
      console.warn(`[Anti-Fraud] Duplicate selfie upload from ${phoneNumber}`);
      const text = t(language, {
        en: 'You have already used this photo for a previous check-in. Please take a fresh selfie today.',
        hi: 'Aapne yeh photo pehle ke attendance ke liye use kiya hai. Kripya aaj ka naya selfie lein.',
        kn: KN.antiFraudDuplicateSelfie || 'ನೀವು ಈ ಫೋಟೋವನ್ನು ಹಿಂದಿನ ಹಾಜರಾತಿಗೆ ಬಳಸಿದ್ದೀರಿ. ದಯವಿಟ್ಟು ಇಂದಿನ ಹೊಸ ಸೆಲ್ಫಿ ತೆಗೆದುಕೊಳ್ಳಿ.',
      });
      await sendTextMessage(phoneNumber, text);
      return apiResponse(200, { status: 'rejected_duplicate_selfie' });
    }

    // Upload selfie to S3
    const uploadResult = await uploadWorkerMedia(workerId, 'checkin-selfie', media.buffer, 'image/jpeg');

    // Save selfie key in conversation state — wait for location
    await saveConversationState(workerId, workerId, {
      current_step: 'awaiting_location',
      pending_selfie_key: uploadResult.key,
      pending_selfie_hash: imageHash,
      pending_selfie_at: Date.now(),
      pending_voice: message.caption || '',
      preferred_language: language,
    });

    // Send location request button
    const locationText = t(language, {
      en: 'Selfie received! Now share your location to complete attendance. Tap the button below.',
      hi: 'Selfie mil gaya! Ab apna location share karein attendance poora karne ke liye. Neeche button dabayein.',
      kn: KN.checkinLocationButton,
    });

    try {
      await sendLocationRequest(phoneNumber, locationText);
    } catch (err) {
      // If location_request_message not supported, skip to voice step
      console.warn('[Attendance] Location request failed, skipping to voice step:', err.message);
      const passcode = newPasscode();
      await saveConversationState(workerId, workerId, {
        current_step: 'awaiting_voice',
        pending_selfie_key: uploadResult.key,
        pending_selfie_hash: imageHash,
        pending_selfie_at: Date.now(),
        pending_latitude: null,
        pending_longitude: null,
        passcode,
        preferred_language: language,
      });
      await sendTextMessage(phoneNumber, voicePromptText(language, passcode, VOICE_PROMPT_OPENINGS.selfie));
    }

    return apiResponse(200, { status: 'selfie_stored_awaiting_location', workerId });
  } catch (err) {
    console.error('Selfie pending location error:', err);
    await sendTextMessage(phoneNumber, t(language, {
      en: 'Something went wrong. Please try sending your selfie again.',
      hi: 'Kuch problem ho gayi. Kripya dobara selfie bhejiye.',
      kn: KN.selfieErrorRetry,
    }));
    return apiResponse(200, { status: 'error', workerId, error: err.message });
  }
}

// ─────────────────────────────────────────────────────────
// Step 3: Process full attendance (selfie + location + voice)
// Called after all inputs collected (voice may be null/skipped)
// ─────────────────────────────────────────────────────────

/** voiceSource: 'audio' (a voice note), 'text' (typed instead) or 'none' (skipped); only audio can auto-approve */
async function processFullAttendance(workerId, worker, language, state, voiceTranscription, voiceSource = 'audio') {
  const phoneNumber = worker.phone_number;

  try {
    const selfieKey = state.pending_selfie_key;
    const latitude = state.pending_latitude || (isDemoMode() ? 28.6139 : null);
    const longitude = state.pending_longitude || (isDemoMode() ? 77.2090 : null);
    // A skipped or failed voice note stays empty so voice verification flags it
    const voice = voiceTranscription || null;

    // Clear the pending state
    await saveConversationState(workerId, workerId, {
      current_step: 'active',
      pending_selfie_key: null,
      pending_latitude: null,
      pending_longitude: null,
      preferred_language: language,
    });

    // Run Triple Verification — all three in parallel
    const [faceResult, geoResult, voiceResult] = await Promise.all([
      attendanceHandler({ task: 'face_verify', workerId, selfieKey, bucket: config.buckets.mediaRaw }),
      attendanceHandler({ task: 'geo_verify', workerId, latitude, longitude }),
      attendanceHandler({ task: 'voice_verify', workerId, voiceTranscription: voice, language, passcode: state.passcode || null }),
    ]);

    const decision = await attendanceHandler({
      task: 'merge_decision',
      workerId,
      faceResult,
      geoResult,
      voiceResult,
      imageHash: state.pending_selfie_hash || null,
      voiceSource: voiceTranscription ? voiceSource : 'none',
      language,
    });

    // Reply with text + Polly voice, always including days logged / remaining
    const daysLogged = decision.totalDaysLogged ?? (worker.total_days_logged || 0);
    const daysRemaining = Math.max(0, decision.daysRemaining ?? (config.certificateThreshold - daysLogged));
    const progress = t(language, {
      en: ` ${daysLogged} days logged, ${daysRemaining} days remaining.`,
      hi: ` ${daysLogged} din log hue, ${daysRemaining} din aur baaki.`,
      kn: KN.progressSuffix(daysLogged, daysRemaining),
    });

    let responseText;
    let label;
    if (decision.status === 'duplicate') {
      label = 'attendance-duplicate';
      responseText = t(language, {
        en: 'Your attendance is already logged for today.',
        hi: 'Aapki aaj ki attendance pehle se log ho chuki hai.',
        kn: KN.attendanceDuplicate,
      }) + progress;
    } else if (decision.status === 'auto_approved') {
      label = 'attendance-confirmed';
      responseText = t(language, {
        en: `Attendance verified! Day ${daysLogged} logged. ${daysRemaining} days remaining.${decision.certificateEligible ? ' Certificate eligible!' : ''}`,
        hi: `Attendance verified! Din ${daysLogged} log hua. ${daysRemaining} din aur baaki.${decision.certificateEligible ? ' Certificate ke liye eligible!' : ''}`,
        kn: KN.attendanceVerified(daysLogged, daysRemaining, decision.certificateEligible),
      });
    } else if (decision.status === 'pending_review') {
      label = 'attendance-pending';
      responseText = t(language, {
        en: 'Attendance submitted for admin review. You will be notified once reviewed.',
        hi: 'Attendance admin review ke liye bhej di gayi hai. Review hone par aapko bataya jayega.',
        kn: KN.attendancePending,
      }) + progress;
    } else {
      label = 'attendance-rejected';
      responseText = t(language, {
        en: 'Attendance could not be verified. Please try again.',
        hi: 'Attendance verify nahi ho saki. Kripya dobara koshish karein.',
        kn: KN.attendanceRejected,
      }) + progress;
    }

    await sendTextAndVoice(phoneNumber, workerId, responseText, language, label);

    if (decision.status === 'auto_approved' && decision.certificateEligible) {
      await triggerCertificateGeneration(workerId, phoneNumber, language);
    }

    return apiResponse(200, {
      status: 'attendance_processed',
      workerId,
      verificationStatus: decision.status,
      confidence: decision.confidence,
      gpsUsed: Boolean(state.pending_latitude),
      voiceUsed: Boolean(voiceTranscription),
    });
  } catch (err) {
    console.error('Full attendance processing error:', err);
    await sendTextMessage(phoneNumber, t(language, {
      en: 'Something went wrong with attendance. Please try again.',
      hi: 'Attendance mein kuch problem ho gayi. Kripya dobara koshish karein.',
      kn: KN.attendanceError,
    }));
    return apiResponse(200, { status: 'error', workerId, error: err.message });
  }
}

// ─────────────────────────────────────────────────────────
// Certificate Generation Trigger
// ─────────────────────────────────────────────────────────

async function triggerCertificateGeneration(workerId, phoneNumber, language) {
  try {
    console.log(`Triggering certificate generation for ${workerId}`);

    const result = await certificateHandler({ task: 'generate', workerId, language });

    if (result.success) {
      const certText = t(language, {
        en: `Congratulations! Your Smart Certificate is ready! BOCW Ref: ${result.bocwReference}. The certificate PDF is attached below.`,
        hi: `Badhai ho! Aapka Smart Certificate taiyar hai! BOCW Ref: ${result.bocwReference}. Certificate ka PDF neeche bheja gaya hai.`,
        kn: KN.certificateReady(result.bocwReference),
      });
      await sendTextAndVoice(phoneNumber, workerId, certText, language, 'certificate-ready');
      await sendCertificateDocument(phoneNumber, {
        certificate_id: result.certificateId,
        bocw_reference: result.bocwReference,
        pdf_s3_key: result.pdfS3Key,
      }, language);
      if (result.signedCredential && result.qrS3Key) {
        await sendCredentialQr(phoneNumber, result.qrS3Key, language);
      }
    } else {
      console.log(`Certificate not generated for ${workerId}: ${result.reason || result.error}`);
    }
  } catch (err) {
    console.error('Certificate generation failed:', err.message);
    // Non-blocking: attendance is already logged, certificate can be retried
  }
}

/** Tap-able self-service menu; each row id maps to an intent in BUTTON_INTENTS */
async function sendSelfServiceMenu(phoneNumber, language = 'hi') {
  const rows = [
    ['menu_today', "Today's attendance", 'Aaj ki haziri', KN.menuRows.today],
    ['menu_days', 'My work days', 'Mere din', KN.menuRows.days],
    ['menu_progress', 'My progress', 'Mera progress', KN.menuRows.progress],
    ['menu_card', 'My certificate', 'Mera certificate', KN.menuRows.card],
    ['menu_checkin', 'Mark attendance', 'Haziri lagao', KN.menuRows.checkin],
    ['menu_language', 'Change language', 'Bhasha badlo', KN.menuRows.language],
    ['menu_help', 'Help', 'Madad', KN.menuRows.help],
  ].map(([id, en, hi, kn]) => ({ id, title: t(language, { en, hi, kn }) }));
  try {
    await sendListMenu(phoneNumber, {
      body: t(language, {
        en: 'What do you need? Tap the button below to choose.',
        hi: 'Aapko kya chahiye? Neeche button dabakar chuniye.',
        kn: KN.menuBody,
      }),
      button: t(language, { en: 'Options', hi: 'Vikalp', kn: KN.menuButton }),
      rows,
    });
  } catch (err) {
    console.warn('[Menu] List message failed:', err.message);
  }
}

/** Send the signed-credential QR as an image the worker can show a welfare board officer */
async function sendCredentialQr(phoneNumber, qrS3Key, language = 'hi') {
  const url = await generatePresignedUrl(config.buckets.certificates, qrS3Key, 900);
  const caption = t(language, {
    en: 'Show this QR code to the welfare board officer. They scan it to verify your work days.',
    hi: 'Yeh QR code welfare board officer ko dikhaiye. Woh ise scan karke aapke kaam ke din verify karenge.',
    kn: KN.credentialQrCaption,
  });
  await sendImageMessage(phoneNumber, url, caption);
}

/** Most recently issued certificate of a worker, or null */
async function findLatestCertificate(workerId) {
  const certs = await queryItems(config.tables.certificates, 'worker_id = :wid', { ':wid': workerId });
  const issued = certs.filter((c) => c.pdf_s3_key);
  issued.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return issued[0] || null;
}

/**
 * Send a certificate PDF as a WhatsApp document. The pre-signed link is created right before
 * sending (WhatsApp fetches it immediately), so no long-lived link is ever handed out.
 */
async function sendCertificateDocument(phoneNumber, cert, language = 'hi') {
  const url = await generatePresignedUrl(config.buckets.certificates, cert.pdf_s3_key, 900);
  const caption = t(language, {
    hi: `Nirman Mitra Smart Certificate${cert.bocw_reference ? ` (BOCW Ref: ${cert.bocw_reference})` : ''}`,
    kn: KN.certificateCaption(cert.bocw_reference),
  });
  await sendDocumentMessage(phoneNumber, url, `Nirman-Mitra-Certificate-${cert.certificate_id}.pdf`, caption);
}
