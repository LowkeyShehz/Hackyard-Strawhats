/**
 * Nirman Mitra — Document OCR Service
 * Textract OCR + name cross-validation for identity documents.
 * Aadhaar OCR, bank passbook OCR, name cross-validation.
 */

import { TextractClient, AnalyzeDocumentCommand } from '@aws-sdk/client-textract';
import config, { isDemoMode } from '../utils/config.js';
import { withRetry } from '../utils/retryHelper.js';

const IS_DEMO = isDemoMode();
const textractClient = IS_DEMO ? null : new TextractClient({ region: config.aws.region });

// ─────────────────────────────────────────────────────────
// Aadhaar OCR
// ─────────────────────────────────────────────────────────

/**
 * Extract fields from an Aadhaar card image using Textract
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

  const textractResult = await withRetry(
    () => textractClient.send(
      new AnalyzeDocumentCommand({
        Document: { Bytes: imageBuffer },
        FeatureTypes: ['FORMS'],
      }),
    ),
    { label: 'Textract:Aadhaar' },
  );

  // Parse Textract FORMS response to extract key-value pairs
  const kvPairs = parseTextractForms(textractResult);
  const allText = extractAllText(textractResult);

  // Extract specific Aadhaar fields
  const fields = {
    name: findFieldValue(kvPairs, ['name', 'naam', 'नाम']) || extractNameFromText(allText),
    dob: findFieldValue(kvPairs, ['dob', 'date of birth', 'birth', 'जन्म तिथि', 'year of birth']) || extractDobFromText(allText),
    aadhaar_number: extractAadhaarNumber(allText),
    address: truncateBeforeAadhaarNumber(findFieldValue(kvPairs, ['address', 'पता']) || extractAddressFromText(allText)),
    gender: findFieldValue(kvPairs, ['gender', 'sex', 'लिंग']) || extractGenderFromText(allText),
    confidence: calculateAverageConfidence(textractResult),
  };

  return fields;
}

// ─────────────────────────────────────────────────────────
// Bank Passbook OCR
// ─────────────────────────────────────────────────────────

/**
 * Extract fields from a bank passbook image using Textract
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

  const textractResult = await withRetry(
    () => textractClient.send(
      new AnalyzeDocumentCommand({
        Document: { Bytes: imageBuffer },
        FeatureTypes: ['FORMS'],
      }),
    ),
    { label: 'Textract:BankPassbook' },
  );

  const kvPairs = parseTextractForms(textractResult);
  const allText = extractAllText(textractResult);

  const fields = {
    account_holder_name: findFieldValue(kvPairs, ['name', 'account holder', 'holder name', 'customer name']) || '',
    account_number: findFieldValue(kvPairs, ['account', 'a/c', 'account no', 'account number']) || extractAccountNumber(allText),
    ifsc_code: findFieldValue(kvPairs, ['ifsc', 'ifsc code', 'branch code']) || extractIfscCode(allText),
    bank_name: findFieldValue(kvPairs, ['bank', 'bank name']) || extractBankName(allText),
    confidence: calculateAverageConfidence(textractResult),
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
 * Uses Textract confidence as a proxy for image quality.
 * Textract errors are thrown, not scored as 0: a service outage is not an unclear photo.
 * @param {Buffer} imageBuffer
 * @returns {Promise<number>} Quality score 0-100
 */
export async function assessDocumentQuality(imageBuffer) {
  if (IS_DEMO) {
    console.log('[DocumentOCR DEMO] Returning mock quality score');
    return 85;
  }

  const result = await withRetry(
    () => textractClient.send(
      new AnalyzeDocumentCommand({
        Document: { Bytes: imageBuffer },
        FeatureTypes: ['FORMS'],
      }),
    ),
    { label: 'Textract:QualityAssess' },
  );
  return calculateAverageConfidence(result);
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
  // Common formats: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY
  const match = text.match(/\b(\d{2}[/\-.]\d{2}[/\-.]\d{4})\b/);
  return match ? match[1] : '';
}

/** Extract name from Aadhaar text (heuristic: line after "Government of India") */
function extractNameFromText(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes('government of india') || lines[i].toLowerCase().includes('भारत सरकार')) {
      // Name is typically 1-2 lines after the header
      if (lines[i + 1] && /^[a-zA-Z\s.]+$/.test(lines[i + 1])) {
        return lines[i + 1];
      }
      if (lines[i + 2] && /^[a-zA-Z\s.]+$/.test(lines[i + 2])) {
        return lines[i + 2];
      }
    }
  }
  return '';
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
