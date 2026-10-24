/**
 * Nirman Mitra — Aadhaar Helpers
 * Only the last 4 digits of an Aadhaar number are ever stored; the full
 * number is used in memory for Verhoeff validation and then discarded.
 */

/**
 * Mask Aadhaar number showing only last 4 digits
 * @param {string} aadhaarNumber - Full 12-digit number
 * @returns {string} Masked format: XXXX-XXXX-1234
 */
export function maskAadhaar(aadhaarNumber) {
  const clean = aadhaarNumber.replace(/\s|-/g, '');
  if (clean.length !== 12) return 'XXXX-XXXX-XXXX';
  const last4 = clean.slice(-4);
  return `XXXX-XXXX-${last4}`;
}

/**
 * Extract last 4 digits from Aadhaar number
 * @param {string} aadhaarNumber
 * @returns {string}
 */
export function getAadhaarLast4(aadhaarNumber) {
  const clean = aadhaarNumber.replace(/\s|-/g, '');
  return clean.slice(-4);
}

export default {
  maskAadhaar,
  getAadhaarLast4,
};
