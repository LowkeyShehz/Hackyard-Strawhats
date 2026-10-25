/**
 * Nirman Mitra — Document OCR Service
 * OCR + name cross-validation for identity documents: Aadhaar OCR, bank passbook OCR, name
 * cross-validation. config.ocrProvider picks the engine: 'bridge' (RapidOCR on the face + fraud
 * bridge, which reads cards far better; falls back to tesseract when the bridge fails),
 * 'tesseract' (tesseract.js in-process, English + Hindi) or 'textract' (AWS, form key-value
 * pairs). Plain-text engines get key-value pairs from "Key: value" lines; all feed the same
 * field extraction below. Card images go only to the bridge, which is our own server.
 */

import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { TextractClient, AnalyzeDocumentCommand } from '@aws-sdk/client-textract';
import config, { isDemoMode } from '../utils/config.js';
import { withRetry } from '../utils/retryHelper.js';

const IS_DEMO = isDemoMode();
const USE_BRIDGE = config.ocrProvider === 'bridge';
const USE_TESSERACT = config.ocrProvider === 'tesseract' || USE_BRIDGE;
const textractClient = IS_DEMO || USE_TESSERACT ? null : new TextractClient({ region: config.aws.region });

// ─────────────────────────────────────────────────────────
// OCR engines
// ─────────────────────────────────────────────────────────

let tesseractWorker = null;

/** One tesseract.js worker per process (English + Hindi, as printed on Aadhaar cards) */
async function defaultTesseractRecognize(imageBuffer) {
  if (!tesseractWorker) {
    tesseractWorker = (async () => {
      const { createWorker } = await import('tesseract.js');
      // Language data downloads once, then is cached next to the stored files (the Render disk).
      // tesseract.js does not create the folder and skips caching silently without it.
      const cachePath = path.join(config.storage.dir, 'tessdata');
      await fs.mkdir(cachePath, { recursive: true });
      return createWorker(['eng', 'hin'], 1, { cachePath });
    })().catch((err) => { tesseractWorker = null; throw err; });
  }
  const worker = await tesseractWorker;
  const { data } = await worker.recognize(imageBuffer);
  return { text: data.text || '', confidence: data.confidence || 0 };
}

/** Tesseract recogniser: (imageBuffer) => { text, confidence }. Replaceable in tests. */
export const tesseract = { recognize: defaultTesseractRecognize };

const OCR_BRIDGE_TIMEOUT_MS = 60000;

/** RapidOCR on the face + fraud bridge: (imageBuffer) => { text, confidence }. Replaceable in tests. */
async function bridgeRecognise(imageBuffer) {
  const res = await fetch(`${config.fraud.serviceUrl}/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.fraud.serviceToken}` },
    body: JSON.stringify({ image_b64: imageBuffer.toString('base64') }),
    signal: AbortSignal.timeout(OCR_BRIDGE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OCR bridge HTTP ${res.status}`);
  const data = await res.json();
  return { text: data.text || '', confidence: data.confidence || 0 };
}

// The same card is read twice per upload (quality check, then field extraction); on the bridge
// that is two slow round trips, so keep the last few results in memory for a minute. Text only,
// never the image.
const RECENT_TTL_MS = 60000;
const recentReads = new Map();

async function recogniseOnce(imageBuffer, label) {
  const key = USE_BRIDGE ? createHash('sha256').update(imageBuffer).digest('hex') : null;
  const hit = key && recentReads.get(key);
  if (hit && Date.now() - hit.at < RECENT_TTL_MS) return hit.result;

  let result;
  if (USE_BRIDGE) {
    try {
      result = await withRetry(() => bridgeRecognise(imageBuffer), { label: `OCRBridge:${label}`, maxRetries: 1 });
    } catch (err) {
      console.warn(`[DocumentOCR] Bridge OCR failed, using Tesseract: ${err.message}`);
    }
  }
  result ??= await withRetry(() => tesseract.recognize(imageBuffer), { label: `Tesseract:${label}` });

  if (key) {
    recentReads.set(key, { at: Date.now(), result });
    for (const [k, v] of recentReads) if (Date.now() - v.at >= RECENT_TTL_MS || recentReads.size > 8) recentReads.delete(k);
  }
  return result;
}

/**
 * Read a document image with the configured OCR engine.
 * @returns {Promise<{kvPairs: {key: string, value: string}[], allText: string, confidence: number}>}
 */
async function readDocument(imageBuffer, label) {
  if (USE_TESSERACT) {
    const { text, confidence } = await recogniseOnce(imageBuffer, label);
    const allText = text.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    return { kvPairs: kvPairsFromLines(allText), allText, confidence: Math.round(confidence) };
  }

  const textractResult = await withRetry(
    () => textractClient.send(
      new AnalyzeDocumentCommand({
        Document: { Bytes: imageBuffer },
        FeatureTypes: ['FORMS'],
      }),
    ),
    { label: `Textract:${label}` },
  );
  return {
    kvPairs: parseTextractForms(textractResult),
    allText: extractAllText(textractResult),
    confidence: calculateAverageConfidence(textractResult),
  };
}

/** "Key: value" lines as key-value pairs (what Textract FORMS returns, for plain OCR text) */
function kvPairsFromLines(text) {
  return text.split('\n')
    .map((line) => line.match(/^([^:：]{2,40})[:：]\s*(.+)$/))
    .filter(Boolean)
    .map(([, key, value]) => ({ key: key.toLowerCase().trim(), value: value.trim() }));
}

// ─────────────────────────────────────────────────────────
// Aadhaar OCR
// ─────────────────────────────────────────────────────────

/**
 * Extract fields from an Aadhaar card image
 * @param {Buffer} imageBuffer - JPEG/PNG image buffer
 * @returns {Promise<{name: string, dob: string, aadhaar_number: string, address: string, gender: string, confidence: number}>}
 */
export async function extractAadhaarFields(imageBuffer) {
  if (IS_DEMO) {
    console.log('[DocumentOCR DEMO] Returning mock Aadhaar fields');
    return {
      name: 'Demo Worker', dob: '01/01/1990', aadhaar_number: '283077653450',
      address: '123 Demo Street, Delhi', gender: 'Male', confidence: 85,
    };
  }

  const { kvPairs, allText, confidence } = await readDocument(imageBuffer, 'Aadhaar');
  // Counts only: the card text and number never go to the logs
  console.log(`[DocumentOCR] Aadhaar read: confidence ${confidence}, valid number ${extractAadhaarNumber(allText) ? 'found' : 'not found'}`);

  // Extract specific Aadhaar fields
  const fields = {
    name: findFieldValue(kvPairs, ['name', 'naam', 'नाम']) || extractNameFromText(allText),
    dob: findFieldValue(kvPairs, ['dob', 'date of birth', 'birth', 'जन्म तिथि', 'year of birth']) || extractDobFromText(allText),
    aadhaar_number: extractAadhaarNumber(allText),
    address: truncateBeforeAadhaarNumber(findFieldValue(kvPairs, ['address', 'पता']) || extractAddressFromText(allText)),
    gender: findFieldValue(kvPairs, ['gender', 'sex', 'लिंग']) || extractGenderFromText(allText),
    confidence,
  };

  return fields;
}

// ─────────────────────────────────────────────────────────
// Bank Passbook OCR
// ─────────────────────────────────────────────────────────

/**
 * Extract fields from a bank passbook image
 * @param {Buffer} imageBuffer
 * @returns {Promise<{account_holder_name: string, account_number: string, ifsc_code: string, bank_name: string, confidence: number}>}
 */
export async function extractBankFields(imageBuffer) {
  if (IS_DEMO) {
    console.log('[DocumentOCR DEMO] Returning mock bank fields');
    return {
      account_holder_name: 'Demo Worker', account_number: '12345678901234',
      ifsc_code: 'SBIN0001234', bank_name: 'State Bank of India', confidence: 82,
    };
  }

  const { kvPairs, allText, confidence } = await readDocument(imageBuffer, 'BankPassbook');

  const fields = {
    account_holder_name: findFieldValue(kvPairs, ['name', 'account holder', 'holder name', 'customer name']) || '',
    account_number: findFieldValue(kvPairs, ['account', 'a/c', 'account no', 'account number']) || extractAccountNumber(allText),
    ifsc_code: findFieldValue(kvPairs, ['ifsc', 'ifsc code', 'branch code']) || extractIfscCode(allText),
    bank_name: findFieldValue(kvPairs, ['bank', 'bank name']) || extractBankName(allText),
    confidence,
  };

  return fields;
}

// ─────────────────────────────────────────────────────────
// Verhoeff Checksum (Aadhaar Validation)
// ─────────────────────────────────────────────────────────

/**
 * Validate Aadhaar number using Verhoeff checksum algorithm
 * @param {string} aadhaarNumber - 12-digit number (may contain spaces/dashes)
 * @returns {boolean} true if valid
 */
export function verhoeffChecksum(aadhaarNumber) {
  const clean = aadhaarNumber.replace(/[\s-]/g, '');
  if (clean.length !== 12 || !/^\d{12}$/.test(clean)) return false;

  // Verhoeff multiplication table
  const d = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  ];

  // Verhoeff permutation table
  const p = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
  ];

  // Compute checksum
  let c = 0;
  const digits = clean.split('').map(Number).reverse();
  for (let i = 0; i < digits.length; i++) {
    c = d[c][p[i % 8][digits[i]]];
  }

  return c === 0;
}

// ─────────────────────────────────────────────────────────
// Document Quality Assessment
// ─────────────────────────────────────────────────────────

/**
 * Assess document image quality for OCR readability
 * Uses OCR confidence as a proxy for image quality.
 * OCR errors are thrown, not scored as 0: a service outage is not an unclear photo.
 * @param {Buffer} imageBuffer
 * @returns {Promise<number>} Quality score 0-100
 */
export async function assessDocumentQuality(imageBuffer) {
  if (IS_DEMO) {
    console.log('[DocumentOCR DEMO] Returning mock quality score');
    return 85;
  }

  return (await readDocument(imageBuffer, 'QualityAssess')).confidence;
}

// ─────────────────────────────────────────────────────────
// Name Cross-Validation
// ─────────────────────────────────────────────────────────

/**
 * Cross-validate names from two different documents
 * Handles transliteration, abbreviations, regional naming conventions.
 * @param {string} name1 - Name from document 1 (e.g., Aadhaar)
 * @param {string} name2 - Name from document 2 (e.g., bank passbook)
 * @returns {Promise<{match: boolean, confidence: number, reasoning: string}>}
 */
export async function crossValidateNames(name1, name2) {
  if (IS_DEMO) {
    const n1 = name1.toLowerCase().trim();
    const n2 = name2.toLowerCase().trim();
    const match = n1 === n2 || n1.includes(n2) || n2.includes(n1);
    console.log(`[DocumentOCR DEMO] Cross-validating: "${name1}" vs "${name2}" → ${match}`);
    return { match, confidence: match ? 90 : 60, reasoning: 'Demo mode comparison' };
  }

  const prompt = `You are an expert at matching Indian names across government identity documents. Construction workers often have name discrepancies between their Aadhaar card, labour card, and bank passbook due to:

1. **Transliteration differences**: Hindi to English spelling variations (e.g., "Sharma" vs "Sharme", "Rajesh" vs "Rajesh")
2. **Abbreviations**: "S. Kumar" vs "Suresh Kumar", "Mohd." vs "Mohammed"
3. **Regional naming conventions**: Father's name included/excluded, different name order
4. **Middle name presence/absence**: "Ram Kumar Singh" vs "Ram Singh"
5. **Honorifics**: "Shri Ram Kumar" vs "Ram Kumar"
6. **Common OCR errors**: "l" vs "I", "0" vs "O", similar characters

Compare these two names and determine if they belong to the same person:

Name from Document 1 (Aadhaar): "${name1}"
Name from Document 2 (Bank Passbook): "${name2}"

Respond in EXACTLY this JSON format (no markdown, no code blocks):
{"match": true/false, "confidence": 0-100, "reasoning": "brief explanation"}`;

  // Names are PII: this prompt is intentionally NOT sent to the external LLM
  // Until a PII-safe matcher exists, use exact matching.
  void prompt;
  {
    // Conservative fallback: exact match check
    const n1 = name1.toLowerCase().trim();
    const n2 = name2.toLowerCase().trim();
    const exactMatch = n1 === n2;
    return {
      match: exactMatch,
      confidence: exactMatch ? 90 : 30,
      reasoning: `Fallback to exact match: ${exactMatch ? 'names identical' : 'names differ'}`,
    };
  }
}

// ─────────────────────────────────────────────────────────
// Textract Response Parsers (Internal Helpers)
// ─────────────────────────────────────────────────────────

/** Parse Textract FORMS response into key-value pairs */
function parseTextractForms(textractResult) {
  const blocks = textractResult.Blocks || [];
  const keyMap = {};
  const valueMap = {};
  const blockMap = {};

  // Build block map
  for (const block of blocks) {
    blockMap[block.Id] = block;
    if (block.BlockType === 'KEY_VALUE_SET') {
      if (block.EntityTypes?.includes('KEY')) {
        keyMap[block.Id] = block;
      } else {
        valueMap[block.Id] = block;
      }
    }
  }

  // Extract key-value pairs
  const kvPairs = [];
  for (const keyId of Object.keys(keyMap)) {
    const keyBlock = keyMap[keyId];
    const keyText = getTextFromBlock(keyBlock, blockMap);

    // Find associated value block
    const valueRelation = keyBlock.Relationships?.find((r) => r.Type === 'VALUE');
    if (valueRelation) {
      for (const valueId of valueRelation.Ids) {
        const valueBlock = blockMap[valueId];
        if (valueBlock) {
          const valueText = getTextFromBlock(valueBlock, blockMap);
          kvPairs.push({
            key: keyText.toLowerCase().trim(),
            value: valueText.trim(),
            confidence: keyBlock.Confidence || 0,
          });
        }
      }
    }
  }

  return kvPairs;
}

/** Get text content from a Textract block by following CHILD relationships */
function getTextFromBlock(block, blockMap) {
  let text = '';
  const childRelation = block.Relationships?.find((r) => r.Type === 'CHILD');
  if (childRelation) {
    for (const childId of childRelation.Ids) {
      const child = blockMap[childId];
      if (child?.BlockType === 'WORD') {
        text += (text ? ' ' : '') + child.Text;
      }
    }
  }
  return text;
}

/** Extract all text lines from Textract result */
function extractAllText(textractResult) {
  const blocks = textractResult.Blocks || [];
  return blocks
    .filter((b) => b.BlockType === 'LINE')
    .map((b) => b.Text)
    .join('\n');
}

/** Find a value in parsed KV pairs by matching any of the given key names */
function findFieldValue(kvPairs, keyNames) {
  for (const kv of kvPairs) {
    for (const name of keyNames) {
      if (kv.key.includes(name.toLowerCase())) {
        return kv.value;
      }
    }
  }
  return '';
}

/** Calculate average confidence across all blocks */
function calculateAverageConfidence(textractResult) {
  const blocks = textractResult.Blocks || [];
  const confidences = blocks.filter((b) => b.Confidence != null).map((b) => b.Confidence);
  if (confidences.length === 0) return 0;
  return Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length);
}

// ─────────────────────────────────────────────────────────
// Text Extraction Helpers
// ─────────────────────────────────────────────────────────

// A digit run shaped like an Aadhaar number: XXXX XXXX XXXX, XXXX-XXXX-XXXX or XXXXXXXXXXXX
const AADHAAR_LIKE = /\d{4}[ -]?\d{4}[ -]?\d{4}/;

/**
 * Extract the 12-digit Aadhaar number from OCR text: the first candidate that passes the
 * Verhoeff checksum. Candidates that are part of a longer digit run (16-digit VIDs, timestamps,
 * phone + pin runs) and numbers starting with 0 or 1 (never issued) are skipped.
 * @returns {string} the number, or '' if no valid candidate was found
 */
export function extractAadhaarNumber(text) {
  // Groups are separated by a space or dash, never a line break (Textract lines are joined by
  // newlines). Not preceded by a digit or by a lone 4-digit group (a VID's tail); not followed by more digits.
  const candidates = String(text || '').matchAll(
    /(?<!\d)(?<!(?:^|\D)\d{4}[ -])([2-9]\d{3})[ -]?(\d{4})[ -]?(\d{4})(?![ -]?\d)/g,
  );
  for (const m of candidates) {
    const number = m[1] + m[2] + m[3];
    if (verhoeffChecksum(number)) return number;
  }
  return '';
}

/** Cut text at the first Aadhaar-like digit run, so a full number never lands in stored fields */
function truncateBeforeAadhaarNumber(text) {
  const match = String(text || '').match(AADHAAR_LIKE);
  if (!match) return text || '';
  return text.slice(0, match.index).replace(/[\s,:;-]+$/, '').trim();
}

/** Extract date of birth from text */
function extractDobFromText(text) {
  // Common formats: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY. A date next to a DOB label wins (OCR
  // often reads the O as a zero); otherwise the first date on a line that is not an issue date,
  // since the card also prints "Aadhaar No. Issued: 15/12/2011".
  const date = '(\\d{2}[/\\-.]\\d{2}[/\\-.]\\d{4})';
  const labelled = text.match(new RegExp(`(?:D[O0]B|date of birth)\\s*[:：]?\\s*${date}`, 'i'));
  if (labelled) return labelled[1];
  for (const line of text.split('\n')) {
    const match = line.match(/\b(\d{2}[/\-.]\d{2}[/\-.]\d{4})\b/);
    if (match && !/issue/i.test(line)) return match[1];
  }
  return '';
}

/** Extract name from Aadhaar text (heuristic: line after "Government of India") */
function extractNameFromText(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const isHeader = (line) => line.toLowerCase().includes('government of india') || line.includes('भारत सरकार');
  const isEnglishName = (line) => /^[a-zA-Z\s.]+$/.test(line);
  // Cards print both headers (Hindi, then English); the name follows the last of them
  const header = lines.findLastIndex(isHeader);
  // The English name is typically 1-2 lines after the header (a Hindi name line may come first)
  const afterHeader = header === -1 ? '' : lines.slice(header + 1, header + 3).find(isEnglishName);
  return afterHeader || nameFromAnyLine(lines);
}

// Words that appear on a card but are never a name
const NOT_A_NAME = /government|india|aadhaar|aadhar|authentication|verification|citizenship|birth|proof|identity|identification|authority|unique|male|female|address|\bdob\b|year|download|issued|enrol|\bvid\b|\bqr\b|\bxml\b|code|offline|online|scanning|should|only|\bwith\b|\bnot\b|\bor\b|\bof\b|\bis\b|\bto\b/i;

/**
 * Fallback for OCR engines that return lines in photo order (a sideways card puts the name after
 * the date of birth): the first short letters-only line that has no card wording in it.
 */
function nameFromAnyLine(lines) {
  return lines.find((line) => /^[A-Za-z][A-Za-z .]{2,39}$/.test(line) && !NOT_A_NAME.test(line) && line.replace(/[^A-Za-z]/g, '').length >= 3) || '';
}

/** Extract address from text (heuristic: lines after "Address:" or "पता:") */
function extractAddressFromText(text) {
  const lines = text.split('\n');
  let capturing = false;
  let address = [];
  for (const line of lines) {
    if (line.toLowerCase().includes('address') || line.includes('पता')) {
      capturing = true;
      const afterColon = line.split(/[:：]/)[1];
      if (afterColon) {
        const part = truncateBeforeAadhaarNumber(afterColon);
        if (part) address.push(part);
        if (AADHAAR_LIKE.test(afterColon)) break;
      }
      continue;
    }
    if (capturing) {
      // Stop at the Aadhaar number (spaced, dashed or plain), keeping any address text before it
      if (AADHAAR_LIKE.test(line)) {
        const part = truncateBeforeAadhaarNumber(line);
        if (part.length > 5) address.push(part);
        break;
      }
      if (line.length > 5) address.push(line.trim());
      if (address.length >= 3) break;
    }
  }
  return address.join(', ');
}

/** Extract gender from text */
function extractGenderFromText(text) {
  const lower = text.toLowerCase();
  if (lower.includes('male') && !lower.includes('female')) return 'Male';
  if (lower.includes('female')) return 'Female';
  if (lower.includes('पुरुष')) return 'Male';
  if (lower.includes('महिला') || lower.includes('स्त्री')) return 'Female';
  return '';
}

/** Extract bank account number from text */
function extractAccountNumber(text) {
  // Account numbers are typically 9-18 digits
  const match = text.match(/\b(\d{9,18})\b/);
  return match ? match[1] : '';
}

/** Extract IFSC code from text */
function extractIfscCode(text) {
  // IFSC format: 4 letters + 0 + 6 alphanumeric
  const match = text.match(/\b([A-Z]{4}0[A-Z0-9]{6})\b/i);
  return match ? match[1].toUpperCase() : '';
}

/** Extract bank name from text (common Indian banks) */
function extractBankName(text) {
  const banks = [
    'State Bank of India', 'SBI', 'Punjab National Bank', 'PNB',
    'Bank of Baroda', 'BOB', 'Canara Bank', 'Union Bank',
    'Indian Bank', 'Central Bank', 'Bank of India', 'BOI',
    'HDFC', 'ICICI', 'Axis Bank', 'Kotak', 'Yes Bank',
    'Indian Overseas Bank', 'IOB', 'UCO Bank', 'Syndicate Bank',
  ];
  const upper = text.toUpperCase();
  for (const bank of banks) {
    if (upper.includes(bank.toUpperCase())) return bank;
  }
  return '';
}

export default {
  extractAadhaarFields,
  extractBankFields,
  verhoeffChecksum,
  assessDocumentQuality,
  crossValidateNames,
};
