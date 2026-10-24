/**
 * Nirman Mitra — Worker Consent (PRD FR-1)
 * Before any document, image or voice is collected, the worker gets a purpose notice in their
 * language with an "I agree" button. Agreeing stores a consent record on the worker (notice
 * version, language, timestamp, channel) and appends an audit entry.
 */

import config from '../utils/config.js';
import { updateItem } from '../utils/dynamodb.js';
import { sendReplyButtons, sendAudioMessage } from '../utils/whatsapp.js';
import { generateAndUploadVoice } from './voiceProcessor.js';
import { t, KN } from '../utils/i18n.js';
import { writeAudit, workerSubject } from './audit.js';

export const CONSENT_BUTTON_ID = 'consent_agree';

// Typed or spoken forms of "I agree", in addition to tapping the button
const AGREE_TEXT = /^\s*(i\s*agree|agree|yes|haan|ha|han|main\s+sahmat\s+hoon|sahmat|मैं\s+सहमत\s+हूँ|सहमत|ನಾನು\s+ಒಪ್ಪುತ್ತೇನೆ|ಒಪ್ಪುತ್ತೇನೆ|ಹೌದು)\s*[.!]?\s*$/i;

/** True when the worker has agreed to the current notice version */
export function hasConsent(worker) {
  return worker?.consent_version === config.consentNoticeVersion;
}

/** True when a message is the worker agreeing (button tap or typed "I agree") */
export function isConsentReply(message) {
  if (message.buttonId === CONSENT_BUTTON_ID) return true;
  return message.type === 'text' && AGREE_TEXT.test(message.text || '');
}

/** Purpose notice text in the worker's language */
export function consentNoticeText(language) {
  return t(language, {
    en: 'Nirman Mitra keeps proof of your work days so you can get welfare benefits.\n\n'
      + 'We use your name, last 4 Aadhaar digits, a selfie, your check-in location and voice notes only to verify your work.\n\n'
      + 'Tap "I agree" to start.',
    hi: 'Nirman Mitra aapke kaam ke dinon ka saboot rakhta hai, taaki aapko welfare labh mile.\n\n'
      + 'Aapka naam, Aadhaar ke aakhri 4 ank, selfie, check-in location aur voice note sirf kaam verify karne ke liye lete hain.\n\n'
      + 'Shuru karne ke liye "Main sahmat hoon" dabaiye.',
    kn: KN.consentNotice,
  });
}

/**
 * Send the purpose notice with the "I agree" button, then read it aloud for workers who
 * cannot read it. The voice note is best effort: the written notice and button always go first.
 * The recording is stored under a shared prefix, never the worker's, since nothing of theirs is kept before consent.
 */
export async function sendConsentNotice(phoneNumber, language) {
  const title = t(language, { en: 'I agree', hi: 'Main sahmat hoon', kn: KN.consentButton });
  const text = consentNoticeText(language);
  const sent = await sendReplyButtons(phoneNumber, text, [{ id: CONSENT_BUTTON_ID, title }]);
  try {
    const audioUrl = await generateAndUploadVoice('shared', text, language, 'consent-notice');
    if (audioUrl) await sendAudioMessage(phoneNumber, audioUrl);
  } catch (err) {
    console.warn('[Consent] Voice notice failed, text already sent:', err.message);
  }
  return sent;
}

/** Reply when a worker sends something before agreeing */
export function consentRequiredText(language) {
  return t(language, {
    en: 'Please tap "I agree" first. We do not save anything until you agree.',
    hi: 'Kripya pehle "Main sahmat hoon" dabaiye. Aapki sahmati ke bina hum kuch bhi save nahi karte.',
    kn: KN.consentRequired,
  });
}

/** Confirmation after the worker agrees */
export function consentThanksText(language) {
  return t(language, {
    en: 'Thank you. Your consent is recorded.',
    hi: 'Dhanyavaad. Aapki sahmati darj ho gayi hai.',
    kn: KN.consentThanks,
  });
}

/**
 * Store the consent record on the worker and append an audit entry.
 * @returns {Promise<object>} The consent record
 */
export async function recordConsent(workerId, language) {
  const record = {
    consent_version: config.consentNoticeVersion,
    consent_language: language,
    consent_at: new Date().toISOString(),
    consent_channel: 'whatsapp',
  };
  await updateItem(
    config.tables.workers,
    { worker_id: workerId },
    'SET consent_version = :v, consent_language = :l, consent_at = :at, consent_channel = :c',
    { ':v': record.consent_version, ':l': record.consent_language, ':at': record.consent_at, ':c': record.consent_channel },
  );
  await writeAudit({
    actor: `worker:${workerId}`,
    action: 'consent.given',
    subject: workerSubject(workerId),
    details: { notice_version: record.consent_version, language, channel: record.consent_channel },
  });
  return record;
}

export default {
  CONSENT_BUTTON_ID,
  hasConsent,
  isConsentReply,
  consentNoticeText,
  sendConsentNotice,
  consentRequiredText,
  consentThanksText,
  recordConsent,
};
