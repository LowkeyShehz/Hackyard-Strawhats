/**
 * Nirman Mitra — Document Verifier Handler
 * Receives events from Step Functions or direct invocation.
 * Dispatches to document OCR + registration services based on task type.
 * Textract OCR + name cross-validation for identity documents.
 */

import config from '../utils/config.js';
import { downloadFromS3, deleteFromS3 } from '../utils/s3.js';
import {
  extractAadhaarFields,
  extractBankFields,
  verhoeffChecksum,
  assessDocumentQuality,
  crossValidateNames,
} from '../services/documentOcr.js';
import { handleSelfieCapture } from '../services/registration.js';
import { getAadhaarLast4 } from '../utils/aadhaar.js';
import { putItem, queryItems } from '../utils/dynamodb.js';
import { v4 as uuidv4 } from 'uuid';

export const handler = async (event) => {
  console.log('DocumentVerifier event:', JSON.stringify(event).substring(0, 500));

  const task = event.task;
  const workerId = event.workerId;

  if (!task || !workerId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing task or workerId' }),
    };
  }

  try {
    switch (task) {
      case 'aadhaar':
        return await processAadhaarDocument(event);

      case 'bank_passbook':
        return await processBankDocument(event);

      case 'selfie':
        return await processSelfieDocument(event);

      case 'cross_validate':
        return await processCrossValidation(event);

      case 'assess_quality':
        return await processQualityAssessment(event);

      default:
        return {
          statusCode: 400,
          body: JSON.stringify({ error: `Unknown task: ${task}` }),
        };
    }
  } catch (err) {
    console.error(`DocumentVerifier error (${task}):`, err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Document processing failed',
        task,
        message: err.message,
      }),
    };
  }
};

// ─────────────────────────────────────────────────────────
// Task: Aadhaar OCR + Validation + Encryption
// ─────────────────────────────────────────────────────────

async function processAadhaarDocument(event) {
  const { workerId, imageKey, bucket } = event;

  // Download image from S3, then delete it: the only Aadhaar data kept is the last 4 digits
  const imageBuffer = await downloadFromS3(
    bucket || config.buckets.mediaRaw,
    imageKey,
  );
  try {
    await deleteFromS3(bucket || config.buckets.mediaRaw, imageKey);
  } catch (err) {
    console.error('Failed to delete Aadhaar image after download:', err.message);
  }

  // Check quality
  const quality = await assessDocumentQuality(imageBuffer);
  if (quality < 50) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: false,
        reason: 'low_quality',
        quality,
        message: 'Image quality too low for OCR',
      }),
    };
  }

  // Extract fields
  const fields = await extractAadhaarFields(imageBuffer);

  // Validate Aadhaar number
  const isValid = fields.aadhaar_number ? verhoeffChecksum(fields.aadhaar_number) : false;
  if (!isValid) {
    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, reason: 'invalid_aadhaar_number', message: 'No valid Aadhaar number found' }),
    };
  }

  // Keep only the last 4 digits; the full number is never stored
  let last4 = '';
  if (fields.aadhaar_number) {
    last4 = getAadhaarLast4(fields.aadhaar_number);
  }

  // Store document record
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
      aadhaar_last4: last4,
    },
    ocr_confidence: fields.confidence,
    verhoeff_valid: isValid,
    created_at: new Date().toISOString(),
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      documentId: docId,
      fields: { name: fields.name, dob: fields.dob, gender: fields.gender, aadhaar_last4: last4 },
      confidence: fields.confidence,
      verhoeff_valid: isValid,
    }),
  };
}

// ─────────────────────────────────────────────────────────
// Task: Bank Passbook OCR
// ─────────────────────────────────────────────────────────

async function processBankDocument(event) {
  const { workerId, imageKey, bucket } = event;

  const imageBuffer = await downloadFromS3(
    bucket || config.buckets.mediaRaw,
    imageKey,
  );

  const fields = await extractBankFields(imageBuffer);

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
    s3_key: imageKey,
    created_at: new Date().toISOString(),
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      documentId: docId,
      fields: {
        account_holder_name: fields.account_holder_name,
        bank_name: fields.bank_name,
        ifsc_code: fields.ifsc_code,
      },
      confidence: fields.confidence,
    }),
  };
}

// ─────────────────────────────────────────────────────────
// Task: Selfie — delegated to registration service
// ─────────────────────────────────────────────────────────

async function processSelfieDocument(event) {
  const { workerId, imageKey, bucket } = event;

  const imageBuffer = await downloadFromS3(
    bucket || config.buckets.mediaRaw,
    imageKey,
  );

  const result = await handleSelfieCapture(workerId, imageBuffer, event.language || 'hi');

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: result.success,
      faceId: result.faceId,
    }),
  };
}

// ─────────────────────────────────────────────────────────
// Task: Cross-Validate Names Across Documents
// ─────────────────────────────────────────────────────────

async function processCrossValidation(event) {
  const { workerId } = event;

  // Get all documents for this worker
  const documents = await queryItems(
    config.tables.documents,
    'worker_id = :wid',
    { ':wid': workerId },
  );

  const aadhaarDoc = documents.find((d) => d.document_type === 'aadhaar');
  const bankDoc = documents.find((d) => d.document_type === 'bank_passbook');

  if (!aadhaarDoc || !bankDoc) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: false,
        reason: 'incomplete_documents',
        message: 'Need both Aadhaar and bank passbook for cross-validation',
      }),
    };
  }

  const name1 = aadhaarDoc.extracted_data?.name || '';
  const name2 = bankDoc.extracted_data?.account_holder_name || '';

  const result = await crossValidateNames(name1, name2);

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      crossValidation: result,
      aadhaarName: name1,
      bankName: name2,
    }),
  };
}

// ─────────────────────────────────────────────────────────
// Task: Quality Assessment
// ─────────────────────────────────────────────────────────

async function processQualityAssessment(event) {
  const { imageKey, bucket } = event;

  const imageBuffer = await downloadFromS3(
    bucket || config.buckets.mediaRaw,
    imageKey,
  );

  const quality = await assessDocumentQuality(imageBuffer);

  return {
    statusCode: 200,
    body: JSON.stringify({ quality, acceptable: quality >= 50 }),
  };
}
