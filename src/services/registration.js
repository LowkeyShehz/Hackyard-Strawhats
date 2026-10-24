/**
 * Nirman Mitra — Registration Service
 * Core business logic for worker onboarding via WhatsApp.
 * Voice-first registration with Aadhaar OCR, selfie, bank passbook.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  RekognitionClient,
  IndexFacesCommand,
  CreateCollectionCommand,
  DeleteFacesCommand,
} from '@aws-sdk/client-rekognition';
import config, { isDemoMode } from '../utils/config.js';
import { putItem, getItem, updateItem, getWorkerByPhone, saveConversationState } from '../utils/dynamodb.js';
import { uploadWorkerMedia, uploadToS3, enrolledSelfieKey } from '../utils/s3.js';
import { getAadhaarLast4 } from '../utils/aadhaar.js';
import {
  detectLanguage,
  transcribeVoice,
  generateAndUploadVoice,
  getGreetingMessage,
  getStepPrompt,
} from './voiceProcessor.js';
import { withRetry } from '../utils/retryHelper.js';
import { t, KN } from '../utils/i18n.js';
import {
  extractAadhaarFields,
  extractBankFields,
  verhoeffChecksum,
  assessDocumentQuality,
  crossValidateNames,
} from './documentOcr.js';

const IS_DEMO = isDemoMode();
const rekognitionClient = IS_DEMO ? null : new RekognitionClient({ region: config.aws.region });
const COLLECTION_ID = config.rekognitionCollectionId;

// Failed Aadhaar photos allowed before the worker is flagged for an admin
const MAX_AADHAAR_ATTEMPTS = 3;

// ─────────────────────────────────────────────────────────
// Collection Initialization (one-time)
// ─────────────────────────────────────────────────────────

let collectionReady = false;

async function ensureCollection() {
  if (collectionReady || IS_DEMO) { collectionReady = true; return; }
  try {
    await rekognitionClient.send(
      new CreateCollectionCommand({ CollectionId: COLLECTION_ID }),
    );
    console.log(`Created Rekognition collection: ${COLLECTION_ID}`);
  } catch (err) {
    if (err.name === 'ResourceAlreadyExistsException' || err.Code === 'ResourceAlreadyExistsException') {
      // Collection exists — OK
    } else {
      console.error('Failed to create Rekognition collection:', err.message);
      throw err;
    }
  }
  collectionReady = true;
}

// ─────────────────────────────────────────────────────────
// Step 1: Handle Greeting (New Worker)
// ─────────────────────────────────────────────────────────

/**
 * Handle a new worker's first message.
 * Detects language, checks for duplicates, creates worker record.
 * @param {string} phoneNumber - International phone number
 * @param {string} messageText - First message content (e.g., "Hi", "Namaste")
 * @param {object} [options]
 * @param {boolean} [options.awaitConsent] - Start at the consent step; no greeting is generated
 * @returns {Promise<{workerId: string, language: string, isExisting: boolean, responseText: string|null, audioUrl: string|null}>}
 */
export async function handleGreeting(phoneNumber, messageText, { awaitConsent = false } = {}) {
  // Detect language from greeting
  const language = await detectLanguage(messageText || 'Hi');

  // Check for existing worker (duplicate detection via PhoneNumberIndex GSI)
  const existing = await getWorkerByPhone(phoneNumber);
  if (existing) {
    const responseText = t(language, {
      en: `Hello ${existing.name || ''}! You are already registered. Send a selfie and voice note to log attendance.`,
      hi: `Namaskar ${existing.name || ''}! Aap pehle se registered hain. Attendance log karne ke liye selfie aur voice note bhejiye.`,
      kn: KN.alreadyRegistered(existing.name || ''),
    });
    const audioUrl = await generateAndUploadVoice(existing.worker_id, responseText, language, 'already-registered');
    return {
      workerId: existing.worker_id,
      language,
      isExisting: true,
      responseText,
      audioUrl,
    };
  }

  // Create new worker record
  const workerId = uuidv4();
  const now = new Date().toISOString();

  await putItem(config.tables.workers, {
    worker_id: workerId,
    phone_number: phoneNumber,
    preferred_language: language,
    profile_status: 'onboarding',
    registration_started: now,
    total_days_logged: 0,
    created_at: now,
    updated_at: now,
  });

  // Create conversation state. One row per worker (session_id = workerId), shared with the
  // attendance flow, so a stale onboarding row can never shadow a later check-in step.
  const sessionId = workerId;
  await saveConversationState(workerId, sessionId, {
    current_step: awaitConsent ? 'awaiting_consent' : 'awaiting_name',
    preferred_language: language,
    retry_count: 0,
  });

  if (awaitConsent) {
    return { workerId, language, isExisting: false, sessionId, responseText: null, audioUrl: null };
  }

  // Generate greeting voice response
  const responseText = getGreetingMessage(language);
  const audioUrl = await generateAndUploadVoice(workerId, responseText, language, 'greeting');

  return {
    workerId,
    language,
    isExisting: false,
    sessionId,
    responseText,
    audioUrl,
  };
}

// ─────────────────────────────────────────────────────────
// Step 2: Handle Name Capture
// ─────────────────────────────────────────────────────────

/**
 * Capture worker's name from voice note or text message.
 * @param {string} workerId
 * @param {Buffer|null} audioBuffer - Voice note buffer (if audio message)
 * @param {string|null} textMessage - Text message (if text)
 * @param {string} language
 * @returns {Promise<{name: string, responseText: string, audioUrl: string|null, nextStep: string}>}
 */
export async function handleNameCapture(workerId, audioBuffer, textMessage, language = 'hi') {
  let name;

  if (audioBuffer && audioBuffer.length > 100) {
    // Transcribe voice note
    name = await transcribeVoice(audioBuffer, language, workerId);
  } else if (textMessage) {
    name = textMessage.trim();
  } else {
    // No valid input — ask again
    const responseText = getStepPrompt('awaiting_name', language);
    const audioUrl = await generateAndUploadVoice(workerId, responseText, language, 'name-retry');
    return { name: null, responseText, audioUrl, nextStep: 'awaiting_name' };
  }

  // Clean up the name
  // Allow Unicode letters (Hindi, Tamil, etc.) + spaces + dots
  name = stripNameLeadIns(name.replace(/[^\p{L}\p{M}\s.]/gu, '').trim());
  if (!isPlausibleName(name)) {
    const responseText = getStepPrompt('awaiting_name', language);
    const audioUrl = await generateAndUploadVoice(workerId, responseText, language, 'name-retry');
    return { name: null, responseText, audioUrl, nextStep: 'awaiting_name' };
  }

  // Update worker record with name
  await updateItem(
    config.tables.workers,
    { worker_id: workerId },
    'SET #n = :name, updated_at = :ts',
    { ':name': name, ':ts': new Date().toISOString() },
    { '#n': 'name' },
  );

  // Move to next step
  const responseText = t(language, {
    en: `Thank you, ${name}! Now please send a photo of your Aadhaar card.`,
    hi: `Dhanyavaad, ${name}! Ab kripya apne Aadhaar card ka photo bhejiye.`,
    kn: KN.nameThanks(name),
  });
  const audioUrl = await generateAndUploadVoice(workerId, responseText, language, 'name-confirmed');

  return { name, responseText, audioUrl, nextStep: 'awaiting_aadhaar' };
}

// "mera naam Ram Kumar hai" / "my name is Ram" / "main Ram hoon" → the name alone
const NAME_LEAD_IN = /^(?:(?:mera|meraa|my|मेरा)\s+(?:naam|name|नाम)(?:\s+(?:is|hai|है))?|(?:naam|name|नाम)(?:\s+(?:is|hai|है))?|i\s+am|im|main|mai|मैं)\s+/iu;
const NAME_TRAILER = /\s+(?:hai|hoon|hun|hu|है|हूँ|हूं|हू)$/iu;
// A voice answer often runs on: "Rajesh and I have been working..." keeps only "Rajesh"
const NAME_RUN_ON = /\s+(?:and|aur|or|but|from|i|main|mai|मैं|और|ಮತ್ತು|ನಾನು)\s.*$/iu;
const MAX_NAME_WORDS = 4;
const MAX_NAME_LENGTH = 40;

/** Strip common spoken lead-ins, trailing "hai"/"hoon" and any run-on sentence from a captured name */
export function stripNameLeadIns(text) {
  return String(text || '').trim()
    .replace(NAME_LEAD_IN, '')
    .replace(NAME_RUN_ON, '')
    .replace(NAME_TRAILER, '')
    .trim();
}

/** A sentence left over after cleaning is not a name; ask again rather than store it */
function isPlausibleName(name) {
  return name.length >= 2 && name.length <= MAX_NAME_LENGTH && name.split(/\s+/).length <= MAX_NAME_WORDS;
}

// ─────────────────────────────────────────────────────────
// Step 3: Handle Aadhaar Upload
// ─────────────────────────────────────────────────────────

/**
 * A failed Aadhaar photo: re-prompt, or flag for an admin once MAX_AADHAAR_ATTEMPTS photos
 * have failed. retryCount is the number of earlier failed photos.
 */
async function aadhaarAttemptFailed(workerId, language, retryCount, responseText, label) {
  if (retryCount + 1 >= MAX_AADHAAR_ATTEMPTS) {
    await updateItem(
      config.tables.workers,
      { worker_id: workerId },
      'SET admin_flag = :flag, admin_flag_reason = :reason, updated_at = :ts',
      {
        ':flag': true,
        ':reason': `Aadhaar could not be read after ${MAX_AADHAAR_ATTEMPTS} attempts`,
        ':ts': new Date().toISOString(),
      },
    );
    const flaggedText = t(language, {
      en: 'We could not read your Aadhaar card. An admin will review your case and message you here.',
      hi: 'Aapka Aadhaar card padha nahi ja saka. Admin aapki madad karenge aur yahin message karenge.',
      kn: KN.aadhaarFlagged,
    });
    const audioUrl = await generateAndUploadVoice(workerId, flaggedText, language, 'aadhaar-admin-flag');
    return { success: false, extractedFields: null, responseText: flaggedText, audioUrl, nextStep: 'admin_flagged' };
  }

  const audioUrl = await generateAndUploadVoice(workerId, responseText, language, label);
  return { success: false, extractedFields: null, responseText, audioUrl, nextStep: 'awaiting_aadhaar' };
}

/**
 * Process Aadhaar card photo: OCR → validate → encrypt → store.
 * Textract extracts → Verhoeff validates → only last 4 digits stored (full number discarded).
 * @param {string} workerId
 * @param {Buffer} imageBuffer
 * @param {string} language
 * @param {number} retryCount - Current retry count (max 3)
 * @returns {Promise<{success: boolean, extractedFields: object|null, responseText: string, audioUrl: string|null, nextStep: string}>}
 */
export async function handleAadhaarUpload(workerId, imageBuffer, language = 'hi', retryCount = 0) {
  // OCR runs on the in-memory buffer: the card image is never uploaded or stored
  let quality;
  let fields = null;
  try {
    quality = await assessDocumentQuality(imageBuffer);
    if (quality >= 50) fields = await extractAadhaarFields(imageBuffer);
  } catch (err) {
    // A Textract outage is not the worker's fault: no retry is consumed
    console.error('Aadhaar OCR service error:', err.name, err.message);
    const responseText = t(language, {
      en: 'We are having a temporary problem reading documents. Please send the Aadhaar photo again in a few minutes.',
      hi: 'Abhi document padhne mein thodi takleef hai. Kripya kuch minute baad Aadhaar ka photo dobara bhejiye.',
      kn: KN.aadhaarServiceError,
    });
    const audioUrl = await generateAndUploadVoice(workerId, responseText, language, 'aadhaar-service-error');
    return { success: false, extractedFields: null, responseText, audioUrl, nextStep: 'awaiting_aadhaar', consumesRetry: false };
  }

  if (quality < 50) {
    return aadhaarAttemptFailed(workerId, language, retryCount, getStepPrompt('retry_image', language), 'aadhaar-retry');
  }

  // extractAadhaarFields only returns a number that passes Verhoeff; check again before trusting it
  if (!fields.aadhaar_number || !verhoeffChecksum(fields.aadhaar_number)) {
    const responseText = t(language, {
      en: 'We could not find a valid 12-digit Aadhaar number in the photo. Please send a clear photo of the side with your Aadhaar number.',
      hi: 'Photo mein sahi 12 ank ka Aadhaar number nahi mila. Kripya Aadhaar number wali taraf ka saaf photo bhejiye.',
      kn: KN.aadhaarInvalid,
    });
    return aadhaarAttemptFailed(workerId, language, retryCount, responseText, 'aadhaar-invalid');
  }

  // Keep only the last 4 digits; the full number is never stored
  const aadhaarLast4 = getAadhaarLast4(fields.aadhaar_number);

  // Store in Documents table
  const docId = uuidv4();
  await putItem(config.tables.documents, {
    worker_id: workerId,
    document_id: docId,
    document_type: 'aadhaar',
    extracted_data: {
      name: fields.name,
      dob: fields.dob,
      address: fields.address,
      gender: fields.gender,
      aadhaar_last4: aadhaarLast4,
    },
    ocr_confidence: fields.confidence,
    verhoeff_valid: true,
    created_at: new Date().toISOString(),
  });

  // Update Workers table with Aadhaar info (only last 4)
  await updateItem(
    config.tables.workers,
    { worker_id: workerId },
    'SET aadhaar_last4 = :last4, aadhaar_name = :name, updated_at = :ts',
    {
      ':last4': aadhaarLast4,
      ':name': fields.name,
      ':ts': new Date().toISOString(),
    },
  );

  // Success response — move to selfie step
  const responseText = t(language, {
    en: `Aadhaar verified (****${aadhaarLast4})! Now please send a clear selfie photo.`,
    hi: `Aadhaar verified (****${aadhaarLast4})! Ab kripya apna ek selfie photo bhejiye.`,
    kn: KN.aadhaarVerified(aadhaarLast4),
  });
  const audioUrl = await generateAndUploadVoice(workerId, responseText, language, 'aadhaar-verified');

  return {
    success: true,
    extractedFields: { ...fields, aadhaar_number: undefined }, // never return full Aadhaar
    responseText,
    audioUrl,
    nextStep: 'awaiting_selfie',
  };
}

// ─────────────────────────────────────────────────────────
// Step 4: Handle Selfie Capture
// ─────────────────────────────────────────────────────────

/**
 * Process worker selfie: Rekognition IndexFaces → store face vector (NOT raw image).
 * Store the face index ID; the enrollment selfie is kept for 1:1 comparison.
 * @param {string} workerId
 * @param {Buffer} imageBuffer
 * @param {string} language
 * @returns {Promise<{success: boolean, faceId: string|null, responseText: string, audioUrl: string|null, nextStep: string}>}
 */
export async function handleSelfieCapture(workerId, imageBuffer, language = 'hi') {
  await ensureCollection();

  // Upload to S3 (raw — will be deleted by 90d lifecycle)
  await uploadWorkerMedia(workerId, 'selfie', imageBuffer, 'image/jpeg');

  try {
    let faceId;

    if (IS_DEMO) {
      // Demo: simulate successful face indexing
      faceId = `demo-face-${workerId}-${Date.now()}`;
      console.log(`[Registration DEMO] Simulated face index: ${faceId}`);
    } else {
      // Index face in Rekognition collection
      const indexResult = await withRetry(
        () => rekognitionClient.send(
          new IndexFacesCommand({
            CollectionId: COLLECTION_ID,
            Image: { Bytes: imageBuffer },
            ExternalImageId: workerId,
            MaxFaces: 1,
            DetectionAttributes: ['ALL'],
            QualityFilter: 'AUTO',
          }),
        ),
        { label: 'Rekognition:IndexFaces' },
      );

      const faceRecords = indexResult.FaceRecords || [];
      const unindexedFaces = indexResult.UnindexedFaces || [];

      // Reject the selfie; any face already indexed from it is removed from the collection
      const rejectSelfie = async (en, hi, kn, label) => {
        await deleteIndexedFaces(faceRecords.map((r) => r.Face?.FaceId).filter(Boolean));
        const responseText = t(language, { en, hi, kn });
        const audioUrl = await generateAndUploadVoice(workerId, responseText, language, label);
        return { success: false, faceId: null, responseText, audioUrl, nextStep: 'awaiting_selfie' };
      };

      // MaxFaces 1 indexes the largest face and reports the rest as EXCEEDS_MAX_FACES
      if (faceRecords.length > 1 || unindexedFaces.some((f) => f.Reasons?.includes('EXCEEDS_MAX_FACES'))) {
        return rejectSelfie(
          'More than one face is in the photo. Please send a selfie with only your face.',
          'Photo mein ek se zyada chehre hain. Kripya sirf apne chehre wala selfie bhejiye.',
          KN.selfieMultipleFaces,
          'selfie-multiple-faces',
        );
      }

      const quality = faceRecords[0]?.FaceDetail?.Quality;
      // No face indexed but one was detected: QualityFilter dropped it as too dark / blurry
      if ((faceRecords.length === 0 && unindexedFaces.length > 0)
        || (quality && (quality.Brightness < 30 || quality.Sharpness < 30))) {
        return rejectSelfie(
          'The selfie quality is low. Please take another photo in good lighting.',
          'Selfie ki quality kam hai. Kripya achchi roshni mein dobara photo lein.',
          KN.selfieLowQuality,
          'selfie-quality',
        );
      }

      if (faceRecords.length === 0) {
        return rejectSelfie(
          'No face detected. Please send a clear selfie showing your face.',
          'Chehra dikhai nahi diya. Kripya apna chehra dikhate hue ek clear selfie bhejiye.',
          KN.selfieNoFace,
          'selfie-retry',
        );
      }

      faceId = faceRecords[0].Face.FaceId;
    }

    // Stable reference copy for 1:1 comparison at every check-in (not subject to raw-media expiry)
    await uploadToS3(
      config.buckets.mediaRaw,
      enrolledSelfieKey(workerId),
      imageBuffer,
      'image/jpeg',
      { worker_id: workerId, media_type: 'enrolled-selfie' },
    );

    // Store face ID in Workers table
    await updateItem(
      config.tables.workers,
      { worker_id: workerId },
      'SET face_vector = :faceId, updated_at = :ts',
      { ':faceId': faceId, ':ts': new Date().toISOString() },
    );

    // Move to location step
    const responseText = t(language, {
      en: 'Selfie saved! Now share your work site location.',
      hi: 'Selfie save ho gaya! Ab apne kaam ki jagah ka location share karein.',
      kn: KN.selfieSaved,
    });
    const audioUrl = await generateAndUploadVoice(workerId, responseText, language, 'selfie-saved');

    return { success: true, faceId, responseText, audioUrl, nextStep: 'awaiting_registration_location' };
  } catch (err) {
    console.error('Selfie processing failed:', err.message);
    const responseText = getStepPrompt('error', language);
    const audioUrl = await generateAndUploadVoice(workerId, responseText, language, 'selfie-error');
    return { success: false, faceId: null, responseText, audioUrl, nextStep: 'awaiting_selfie' };
  }
}

/** Remove faces from the collection (best effort: a leftover face only wastes an index slot) */
async function deleteIndexedFaces(faceIds) {
  if (IS_DEMO || faceIds.length === 0) return;
  try {
    await rekognitionClient.send(new DeleteFacesCommand({ CollectionId: COLLECTION_ID, FaceIds: faceIds }));
  } catch (err) {
    console.warn('[Registration] DeleteFaces failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────
// Step 5: Handle Bank Passbook
// ─────────────────────────────────────────────────────────

/**
 * Process bank passbook photo: OCR → cross-validate names → store.
 * Names are compared by exact match (not sent to any LLM — PII).
 * @param {string} workerId
 * @param {Buffer} imageBuffer
 * @param {string} language
 * @returns {Promise<{success: boolean, crossValidation: object|null, responseText: string, audioUrl: string|null, nextStep: string}>}
 */
export async function handleBankPassbook(workerId, imageBuffer, language = 'hi') {
  // Upload to S3
  await uploadWorkerMedia(workerId, 'passbook', imageBuffer, 'image/jpeg');

  // Extract fields with Textract
  const fields = await extractBankFields(imageBuffer);

  // Store in Documents table
  const docId = uuidv4();
  await putItem(config.tables.documents, {
    worker_id: workerId,
    document_id: docId,
    document_type: 'bank_passbook',
    extracted_data: {
      account_holder_name: fields.account_holder_name,
      account_number: fields.account_number ? `****${fields.account_number.slice(-4)}` : '',
      ifsc_code: fields.ifsc_code,
      bank_name: fields.bank_name,
    },
    ocr_confidence: fields.confidence,
    s3_key: `workers/${workerId}/passbook-${Date.now()}.jpg`,
    created_at: new Date().toISOString(),
  });

  // Cross-validate: Aadhaar name vs bank passbook name
  const worker = await getItem(config.tables.workers, { worker_id: workerId });
  const aadhaarName = worker?.aadhaar_name || '';
  const bankName = fields.account_holder_name || '';

  let crossValidation = null;
  if (aadhaarName && bankName) {
    crossValidation = await crossValidateNames(aadhaarName, bankName);

    // Update worker with cross-validation result
    await updateItem(
      config.tables.workers,
      { worker_id: workerId },
      'SET documents_cross_validated = :cv, cross_validation_result = :result, bank_name = :bn, updated_at = :ts',
      {
        ':cv': crossValidation.match,
        ':result': crossValidation,
        ':bn': bankName,
        ':ts': new Date().toISOString(),
      },
    );

    if (!crossValidation.match) {
      // Names don't match — inform worker but still proceed
      const responseText = t(language, {
        en: `Note: The name on your Aadhaar ("${aadhaarName}") differs from your passbook ("${bankName}"). We will proceed, but an admin may verify this. Finalizing your registration...`,
        hi: `Dhyan dein: Aapke Aadhaar ("${aadhaarName}") aur passbook ("${bankName}") mein naam alag hai. Hum aage badhenge, lekin admin verify kar sakte hain. Registration poora kar rahe hain...`,
        kn: KN.nameMismatch(aadhaarName, bankName),
      });
      const audioUrl = await generateAndUploadVoice(workerId, responseText, language, 'name-mismatch');
      return { success: true, crossValidation, responseText, audioUrl, nextStep: 'finalizing' };
    }
  }

  // Names match or no names to compare — finalize
  const responseText = t(language, {
    en: 'Bank passbook verified! Finalizing your registration...',
    hi: 'Bank passbook verified! Aapka registration poora kar rahe hain...',
    kn: KN.passbookVerified,
  });
  const audioUrl = await generateAndUploadVoice(workerId, responseText, language, 'passbook-verified');

  return { success: true, crossValidation, responseText, audioUrl, nextStep: 'finalizing' };
}

// ─────────────────────────────────────────────────────────
// Step 6: Finalize Registration
// ─────────────────────────────────────────────────────────

/**
 * Finalize worker registration: set profile_status to 'active'.
 * All verified → profile_status = 'active' → Polly confirmation
 * @param {string} workerId
 * @param {string} language
 * @returns {Promise<{success: boolean, responseText: string, audioUrl: string|null}>}
 */
export async function finalizeRegistration(workerId, language = 'hi') {
  const now = new Date().toISOString();

  // Get worker name for greeting
  const worker = await getItem(config.tables.workers, { worker_id: workerId });
  const workerName = worker?.name || '';

  // Set initial reminder time for tomorrow 18:00 IST (12:30 UTC)
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(12, 30, 0, 0);

  // Update profile status
  await updateItem(
    config.tables.workers,
    { worker_id: workerId },
    'SET profile_status = :status, registration_completed = :ts, updated_at = :ts2, next_reminder_time = :nt, last_checkin_date = :ld',
    { ':status': 'active', ':ts': now, ':ts2': now, ':nt': tomorrow.toISOString(), ':ld': '1970-01-01' },
  );

  // Clear the onboarding step so the next message starts the attendance flow cleanly
  await saveConversationState(workerId, workerId, {
    current_step: 'active',
    preferred_language: language,
  });

  // Generate completion message
  const responseText = t(language, {
    en: `Congratulations ${workerName}! Your registration is complete. You can now log your daily attendance by sending a selfie and voice note.`,
    hi: `Badhai ho ${workerName}! Aapka registration poora ho gaya. Ab aap har din selfie aur voice note bhejkar apni attendance log kar sakte hain.`,
    kn: KN.registrationComplete(workerName),
  });
  const audioUrl = await generateAndUploadVoice(workerId, responseText, language, 'registration-complete');

  return { success: true, responseText, audioUrl };
}

export default {
  handleGreeting,
  handleNameCapture,
  handleAadhaarUpload,
  handleSelfieCapture,
  handleBankPassbook,
  finalizeRegistration,
};
