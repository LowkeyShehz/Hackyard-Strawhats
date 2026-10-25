// OCR_PROVIDER=bridge: Aadhaar and passbook text come from RapidOCR on the bridge, a card is read
// once per upload, and a bridge failure falls back to Tesseract
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.OCR_PROVIDER = 'bridge';
process.env.FRAUD_SERVICE_URL = 'https://fraud.test';
process.env.FRAUD_SERVICE_TOKEN = 'fraud-token';
const H = await import('./helpers/harness.mjs');
const ocr = await import('../src/services/documentOcr.js');

let n = 0;
const card = () => Buffer.from(`card-${++n}`); // distinct bytes, so reads are not shared between tests
let tesseractCalls;

before(() => {
  H.quiet();
  ocr.tesseract.recognize = async () => { tesseractCalls++; return { text: 'Ram Kumar\n2830 7765 3450\n', confidence: 70 }; };
});
beforeEach(() => {
  H.fraud.ocrFail = false;
  H.fraud.ocrCalls.length = 0;
  H.fraud.ocrConfidence = 90;
  H.fraud.ocrText = 'Government of India\nRam Kumar\nDOB: 01/01/1990\nMale\n2830 7765 3450\n';
  tesseractCalls = 0;
});
after(() => H.close());

test('Aadhaar fields come from the bridge, with the service token, and Tesseract is not used', async () => {
  const fields = await ocr.extractAadhaarFields(card());
  assert.equal(fields.aadhaar_number, '283077653450');
  assert.equal(fields.name, 'Ram Kumar');
  assert.equal(fields.confidence, 90);
  assert.equal(H.fraud.ocrCalls.length, 1);
  assert.equal(H.fraud.ocrCalls[0].headers.Authorization, 'Bearer fraud-token');
  assert.equal(tesseractCalls, 0);
});

test('the quality check and the field extraction share one read of the same card', async () => {
  const photo = card();
  assert.equal(await ocr.assessDocumentQuality(photo), 90);
  const fields = await ocr.extractAadhaarFields(photo);
  assert.equal(fields.aadhaar_number, '283077653450');
  assert.equal(H.fraud.ocrCalls.length, 1, 'one bridge call for both');
});

test('a bridge outage falls back to Tesseract', async () => {
  H.fraud.ocrFail = true;
  const fields = await ocr.extractAadhaarFields(card());
  assert.equal(fields.aadhaar_number, '283077653450');
  assert.equal(tesseractCalls, 1);
});

test('a sideways card (lines in photo order) still yields the name and the real date of birth', async () => {
  H.fraud.ocrText = [
    'Aadhaar No. Issued: 15/12/2011', 'Government of India', '2830 7765 3450',
    'authentication or scanning of QR code / offline XML)', 'of birth. It should be used only with verification online',
    'Aadhaar is proof of identity, not of citizenship or date', 'd/Male', 'x/D0B: 24/08/2005', 'Abubaker', 'A', '2830 7765 3450',
  ].join('\n');
  const fields = await ocr.extractAadhaarFields(card());
  assert.equal(fields.aadhaar_number, '283077653450');
  assert.equal(fields.name, 'Abubaker');
  assert.equal(fields.dob, '24/08/2005');
  assert.equal(fields.gender, 'Male');
});

test('a date without a DOB label is still not taken from the "Issued" line', async () => {
  H.fraud.ocrText = 'Aadhaar No. Issued: 15/12/2011\nGovernment of India\nRam Kumar\n01/01/1990\n2830 7765 3450\n';
  const fields = await ocr.extractAadhaarFields(card());
  assert.equal(fields.dob, '01/01/1990');
  assert.equal(fields.name, 'Ram Kumar');
});
