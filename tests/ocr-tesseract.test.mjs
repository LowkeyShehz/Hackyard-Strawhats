// OCR_PROVIDER=tesseract: Aadhaar and passbook fields come from plain OCR text, and Textract
// is never called. The recogniser is stubbed; a real tesseract.js run needs its language data.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.OCR_PROVIDER = 'tesseract';
const H = await import('./helpers/harness.mjs');
const ocr = await import('../src/services/documentOcr.js');

let nextText = '';
before(() => {
  H.quiet();
  ocr.tesseract.recognize = async () => ({ text: nextText, confidence: 87.6 });
});
after(() => H.close());

test('Aadhaar fields are read from Tesseract text without Textract', async () => {
  const textractBefore = H.textract.calls;
  nextText = 'भारत सरकार\nGovernment of India\nRam Kumar\nDOB: 01/01/1990\nMale\n2830 7765 3450\n';
  const fields = await ocr.extractAadhaarFields(Buffer.from('jpeg'));
  assert.equal(fields.name, 'Ram Kumar');
  assert.equal(fields.dob, '01/01/1990');
  assert.equal(fields.gender, 'Male');
  assert.equal(fields.aadhaar_number, '283077653450');
  assert.equal(fields.confidence, 88);
  assert.equal(H.textract.calls, textractBefore, 'Textract is not called');
});

test('passbook fields and quality come from the same engine', async () => {
  nextText = 'STATE BANK OF INDIA\nName: Ram Kumar\nA/c No: 12345678901234\nIFSC: SBIN0001234\n';
  const bank = await ocr.extractBankFields(Buffer.from('jpeg'));
  assert.equal(bank.account_holder_name, 'Ram Kumar');
  assert.equal(bank.account_number, '12345678901234');
  assert.equal(bank.ifsc_code, 'SBIN0001234');
  assert.equal(bank.bank_name, 'State Bank of India');
  assert.equal(await ocr.assessDocumentQuality(Buffer.from('jpeg')), 88);
});
