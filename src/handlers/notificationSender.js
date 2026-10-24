/**
 * Nirman Mitra — Notification Sender Handler
 * Polly TTS + WhatsApp message delivery.
 * Neural TTS in the worker's preferred language.
 *
 * Receives: { workerId, messageText?, notificationType, language?, result?, error? }
 * Sends voice + text via WhatsApp in worker's preferred language.
 */

import config from '../utils/config.js';
import { getItem } from '../utils/dynamodb.js';
import { generateAndUploadVoice } from '../services/voiceProcessor.js';
import { sendTextMessage, sendAudioMessage } from '../utils/whatsapp.js';
import { t, KN } from '../utils/i18n.js';

export const handler = async (event) => {
  console.log('NotificationSender event:', JSON.stringify(event).substring(0, 500));

  const { workerId, notificationType, messageText, language, result, error } = event;

  if (!workerId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing workerId' }) };
  }

  try {
    // Get worker info for phone number and language preference
    const worker = await getItem(config.tables.workers, { worker_id: workerId });
    if (!worker) {
      console.error(`Worker not found: ${workerId}`);
      return { statusCode: 404, body: JSON.stringify({ error: 'Worker not found' }) };
    }

    const phoneNumber = worker.phone_number;
    const lang = language || worker.preferred_language || 'hi';
    let text = messageText;

    // Build notification message based on type
    if (!text) {
      text = buildNotificationMessage(notificationType, lang, worker, result, error);
    }

    // Generate Polly voice
    const audioUrl = await generateAndUploadVoice(workerId, text, lang, notificationType || 'notification');

    // Send via WhatsApp
    await sendTextMessage(phoneNumber, text);
    if (audioUrl) {
      await sendAudioMessage(phoneNumber, audioUrl);
    }

    console.log(`Notification sent to ${phoneNumber}: ${notificationType}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        notificationType,
        phoneNumber,
      }),
    };
  } catch (err) {
    console.error('NotificationSender error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Notification failed', message: err.message }),
    };
  }
};

// ─────────────────────────────────────────────────────────
// Notification Message Builder
// ─────────────────────────────────────────────────────────

function buildNotificationMessage(type, language, worker, _result, _error) {
  const name = worker.name || '';
  const daysLogged = worker.total_days_logged || 0;
  const daysRemaining = Math.max(0, (config.certificateThreshold || 90) - daysLogged);

  const messages = {
    // Registration flow
    aadhaar_processed: {
      hi: `${name}, aapka Aadhaar card verify ho gaya hai. Ab kripya apna selfie bhejiye.`,
      en: `${name}, your Aadhaar card has been verified. Please send a selfie now.`,
      kn: KN.notifyAadhaarProcessed(name),
    },
    selfie_processed: {
      hi: `${name}, aapka selfie save ho gaya. Ab kripya bank passbook ka photo bhejiye.`,
      en: `${name}, your selfie has been saved. Please send a photo of your bank passbook.`,
      kn: KN.notifySelfieProcessed(name),
    },
    passbook_processed: {
      hi: `${name}, aapka bank passbook verify ho gaya. Registration poora kar rahe hain...`,
      en: `${name}, your bank passbook has been verified. Finalizing registration...`,
      kn: KN.notifyPassbookProcessed(name),
    },
    registration_complete: {
      hi: `Badhai ho ${name}! Aapka registration poora ho gaya. Ab har din selfie aur voice note bhejkar attendance log karein.`,
      en: `Congratulations ${name}! Registration complete. Log daily attendance by sending a selfie and voice note.`,
      kn: KN.notifyRegistrationComplete(name),
    },

    // Attendance flow (Phase 3)
    attendance_confirmed: {
      hi: `${name}, aapki attendance log ho gayi! Din ${daysLogged} verified. ${daysRemaining} din aur baaki hain.`,
      en: `${name}, attendance logged! Day ${daysLogged} verified. ${daysRemaining} days remaining.`,
      kn: KN.notifyAttendanceConfirmed(name, daysLogged, daysRemaining),
    },
    attendance_rejected: {
      hi: `${name}, attendance verify nahi ho saki. Kripya clear selfie aur voice note ke saath dobara bhejiye.`,
      en: `${name}, attendance could not be verified. Please send again with a clear selfie and voice note.`,
      kn: KN.notifyAttendanceRejected(name),
    },
    attendance_pending: {
      hi: `${name}, aapki attendance admin review mein hai. Jaldi update milega.`,
      en: `${name}, your attendance is under admin review. You will receive an update soon.`,
      kn: KN.notifyAttendancePending(name),
    },
    attendance_duplicate: {
      hi: `${name}, aapki aaj ki attendance pehle se log ho chuki hai.`,
      en: `${name}, your attendance is already logged for today.`,
      kn: KN.notifyAttendanceDuplicate(name),
    },

    // Certificate (Phase 4)
    certificate_ready: {
      hi: `Badhai ho ${name}! Aapka certificate taiyar hai. Neeche link se download karein.`,
      en: `Congratulations ${name}! Your certificate is ready. Download from the link below.`,
      kn: KN.notifyCertificateReady(name),
    },

    // Errors
    error: {
      hi: `${name}, kuch problem ho gayi. Kripya thodi der baad dobara koshish karein.`,
      en: `${name}, something went wrong. Please try again after some time.`,
      kn: KN.notifyError(name),
    },
  };

  const msg = messages[type] || messages.error;
  return t(language, msg);
}
