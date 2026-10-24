/**
 * Nirman Mitra — worker-facing reply localisation.
 *
 * Call sites keep their Hindi and English text inline and pick a variant with
 * t(language, { en, hi, kn }). Hindi is the fallback for any language without a variant.
 * Every Kannada string lives in the KN block below, so a native speaker can review them in
 * one place (PRD FR-8).
 */

/**
 * Pick the reply for a worker's language; falls back to Hindi when that language is missing.
 * @param {string} language - ISO 639-1 code (hi, en, kn, ...)
 * @param {{hi: string, en?: string, kn?: string}} variants
 * @returns {string}
 */
export function t(language, variants) {
  return variants[language] ?? variants.hi;
}

/** English name of a language, for LLM prompts */
export function languageName(language) {
  return { hi: 'Hindi', en: 'English', kn: 'Kannada', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', bn: 'Bengali', mr: 'Marathi', gu: 'Gujarati' }[language] || 'Hindi';
}

// kn: needs native-speaker review
export const KN = {
  // ── Consent (purpose notice, PRD FR-1) ──
  // Shortened notice: needs a native-speaker check
  consentNotice: `ನಿರ್ಮಾಣ ಮಿತ್ರ ನಿಮ್ಮ ಕೆಲಸದ ದಿನಗಳಿಗೆ ಪುರಾವೆ ಮಾಡಿ, ಕಲ್ಯಾಣ ಸೌಲಭ್ಯ ಪಡೆಯಲು ಸಹಾಯ ಮಾಡುತ್ತದೆ.

ನಿಮ್ಮ ಹೆಸರು, ಆಧಾರ್‌ನ ಕೊನೆಯ 4 ಅಂಕಿಗಳು, ಸೆಲ್ಫಿ, ಹಾಜರಿ ಸ್ಥಳ ಮತ್ತು ವಾಯ್ಸ್ ನೋಟ್ ಅನ್ನು ಕೆಲಸ ಪರಿಶೀಲಿಸಲು ಮಾತ್ರ ಬಳಸುತ್ತೇವೆ.

ಮುಂದುವರಿಯಲು "ನಾನು ಒಪ್ಪುತ್ತೇನೆ" ಒತ್ತಿ.`,
  consentButton: 'ನಾನು ಒಪ್ಪುತ್ತೇನೆ',
  consentRequired: 'ದಯವಿಟ್ಟು ಮೊದಲು "ನಾನು ಒಪ್ಪುತ್ತೇನೆ" ಒತ್ತಿ. ನೀವು ಒಪ್ಪುವವರೆಗೆ ನಾವು ಏನನ್ನೂ ಉಳಿಸುವುದಿಲ್ಲ.',
  consentThanks: 'ಧನ್ಯವಾದಗಳು. ನಿಮ್ಮ ಒಪ್ಪಿಗೆ ದಾಖಲಾಗಿದೆ.',
  consentContinueActive: 'ಈಗ ಮುಂದುವರಿಯಬಹುದು: ಇಂದಿನ ಹಾಜರಿಗೆ ಸೆಲ್ಫಿ ಕಳಿಸಿ.',

  // ── Greeting / registration ──
  greetingNew: 'ನಮಸ್ಕಾರ! ನಾನು ನಿರ್ಮಾಣ ಮಿತ್ರ — ನಿಮ್ಮ ಡಿಜಿಟಲ್ ಸಂಗಾತಿ. ನೋಂದಣಿ ಶುರು ಮಾಡಲು, ದಯವಿಟ್ಟು ನಿಮ್ಮ ಹೆಸರು ಹೇಳಿ.',
  greetingRegistered: (name) => `ನಮಸ್ಕಾರ ${name}! ನಾನು ನಿರ್ಮಾಣ ಮಿತ್ರ. ನಿಮ್ಮ ನೋಂದಣಿ ಆಗಿದೆ. ಈಗ ಪ್ರತಿದಿನ ಸೆಲ್ಫಿ ಮತ್ತು ವಾಯ್ಸ್ ನೋಟ್ ಕಳಿಸಿ ಹಾಜರಿ ಹಾಕಬಹುದು.`,
  alreadyRegistered: (name) => `ನಮಸ್ಕಾರ ${name}! ನೀವು ಈಗಾಗಲೇ ನೋಂದಣಿ ಆಗಿದ್ದೀರಿ. ಹಾಜರಿ ಹಾಕಲು ಸೆಲ್ಫಿ ಮತ್ತು ವಾಯ್ಸ್ ನೋಟ್ ಕಳಿಸಿ.`,
  stepName: 'ದಯವಿಟ್ಟು ನಿಮ್ಮ ಪೂರ್ತಿ ಹೆಸರು ಹೇಳಿ ಅಥವಾ ಟೈಪ್ ಮಾಡಿ.',
  stepAadhaar: 'ಧನ್ಯವಾದ! ಈಗ ದಯವಿಟ್ಟು ನಿಮ್ಮ ಆಧಾರ್ ಕಾರ್ಡ್ ಫೋಟೋ ಕಳಿಸಿ.',
  stepSelfie: 'ಆಧಾರ್ ಪರಿಶೀಲನೆ ಆಯಿತು! ಈಗ ದಯವಿಟ್ಟು ನಿಮ್ಮ ಒಂದು ಸೆಲ್ಫಿ ಫೋಟೋ ಕಳಿಸಿ.',
  stepPassbook: 'ಸೆಲ್ಫಿ ಉಳಿಸಲಾಗಿದೆ! ಈಗ ದಯವಿಟ್ಟು ನಿಮ್ಮ ಬ್ಯಾಂಕ್ ಪಾಸ್‌ಬುಕ್ ಫೋಟೋ ಕಳಿಸಿ.',
  stepRegistrationComplete: 'ಅಭಿನಂದನೆಗಳು! ನಿಮ್ಮ ನೋಂದಣಿ ಪೂರ್ತಿಯಾಯಿತು. ಈಗ ಪ್ರತಿದಿನ ಸೆಲ್ಫಿ ಮತ್ತು ವಾಯ್ಸ್ ನೋಟ್ ಕಳಿಸಿ ಹಾಜರಿ ಹಾಕಬಹುದು.',
  stepRetryImage: 'ಫೋಟೋ ಸ್ಪಷ್ಟವಾಗಿಲ್ಲ. ದಯವಿಟ್ಟು ಒಳ್ಳೆ ಬೆಳಕಿನಲ್ಲಿ ಮತ್ತೆ ಫೋಟೋ ಕಳಿಸಿ.',
  stepError: 'ಏನೋ ತೊಂದರೆ ಆಯಿತು. ದಯವಿಟ್ಟು ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.',
  nameThanks: (name) => `ಧನ್ಯವಾದ, ${name}! ಈಗ ದಯವಿಟ್ಟು ನಿಮ್ಮ ಆಧಾರ್ ಕಾರ್ಡ್ ಫೋಟೋ ಕಳಿಸಿ.`,
  sayName: 'ದಯವಿಟ್ಟು ನಿಮ್ಮ ಹೆಸರು ಹೇಳಿ ಅಥವಾ ಟೈಪ್ ಮಾಡಿ.',
  sendNameToContinue: 'ನೋಂದಣಿ ಮುಂದುವರಿಸಲು ದಯವಿಟ್ಟು ನಿಮ್ಮ ಹೆಸರು ಕಳಿಸಿ.',
  aadhaarFlagged: 'ನಿಮ್ಮ ಆಧಾರ್ ಕಾರ್ಡ್ ಓದಲು ಆಗಲಿಲ್ಲ. ಅಡ್ಮಿನ್ ನಿಮಗೆ ಸಹಾಯ ಮಾಡುತ್ತಾರೆ ಮತ್ತು ಇಲ್ಲೇ ಮೆಸೇಜ್ ಮಾಡುತ್ತಾರೆ.',
  aadhaarServiceError: 'ಈಗ ದಾಖಲೆ ಓದುವುದರಲ್ಲಿ ಸ್ವಲ್ಪ ತೊಂದರೆ ಇದೆ. ದಯವಿಟ್ಟು ಕೆಲವು ನಿಮಿಷಗಳ ನಂತರ ಆಧಾರ್ ಫೋಟೋ ಮತ್ತೆ ಕಳಿಸಿ.',
  aadhaarInvalid: 'ಫೋಟೋದಲ್ಲಿ ಸರಿಯಾದ 12 ಅಂಕಿಯ ಆಧಾರ್ ನಂಬರ್ ಸಿಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ನಿಮ್ಮ ಆಧಾರ್ ನಂಬರ್ ಸ್ಪಷ್ಟವಾಗಿ ಕಾಣುವಂತೆ ಫೋಟೋ ಕಳಿಸಿ.',
  aadhaarVerified: (last4) => `ಆಧಾರ್ ಪರಿಶೀಲನೆ ಆಯಿತು (****${last4})! ಈಗ ದಯವಿಟ್ಟು ನಿಮ್ಮ ಒಂದು ಸೆಲ್ಫಿ ಫೋಟೋ ಕಳಿಸಿ.`,
  aadhaarReminder: 'ದಯವಿಟ್ಟು ನಿಮ್ಮ ಆಧಾರ್ ಕಾರ್ಡ್ ಫೋಟೋ ಕಳಿಸಿ.',
  selfieReminder: 'ದಯವಿಟ್ಟು ನಿಮ್ಮ ಸೆಲ್ಫಿ ಫೋಟೋ ಕಳಿಸಿ.',
  selfieMultipleFaces: 'ಫೋಟೋದಲ್ಲಿ ಒಂದಕ್ಕಿಂತ ಹೆಚ್ಚು ಮುಖಗಳಿವೆ. ದಯವಿಟ್ಟು ನಿಮ್ಮ ಮುಖ ಮಾತ್ರ ಇರುವ ಸೆಲ್ಫಿ ಕಳಿಸಿ.',
  selfieLowQuality: 'ಸೆಲ್ಫಿ ಸರಿಯಾಗಿ ಬಂದಿಲ್ಲ. ದಯವಿಟ್ಟು ಒಳ್ಳೆ ಬೆಳಕಿನಲ್ಲಿ ಮತ್ತೆ ಫೋಟೋ ತೆಗೆಯಿರಿ.',
  selfieNoFace: 'ಮುಖ ಕಾಣಿಸುತ್ತಿಲ್ಲ. ದಯವಿಟ್ಟು ನಿಮ್ಮ ಮುಖ ಸ್ಪಷ್ಟವಾಗಿ ಕಾಣುವ ಸೆಲ್ಫಿ ಕಳಿಸಿ.',
  selfieSaved: 'ಸೆಲ್ಫಿ ಉಳಿಸಲಾಗಿದೆ! ಈಗ ನಿಮ್ಮ ಕೆಲಸದ ಜಾಗದ ಲೊಕೇಶನ್ ಕಳಿಸಿ.',
  registrationLocationButton: 'ನಿಮ್ಮ ಕೆಲಸದ ಜಾಗದ ಲೊಕೇಶನ್ ಕಳಿಸಲು ಕೆಳಗಿನ ಬಟನ್ ಒತ್ತಿ.',
  registrationLocationReminder: 'ದಯವಿಟ್ಟು ಬಟನ್ ಒತ್ತಿ ನಿಮ್ಮ ಕೆಲಸದ ಜಾಗದ ಲೊಕೇಶನ್ ಕಳಿಸಿ, ಅಥವಾ ಬಿಡಲು "ok" ಕಳಿಸಿ.',
  registrationLocationSaved: 'ಲೊಕೇಶನ್ ಉಳಿಸಲಾಗಿದೆ! ನಿಮ್ಮ ನೋಂದಣಿ ಪೂರ್ತಿ ಮಾಡುತ್ತಿದ್ದೇವೆ...',
  registrationLocationSkipped: 'ಲೊಕೇಶನ್ ಬಿಡಲಾಗಿದೆ. ನಿಮ್ಮ ನೋಂದಣಿ ಪೂರ್ತಿ ಮಾಡುತ್ತಿದ್ದೇವೆ...',
  nameMismatch: (aadhaarName, bankName) => `ಗಮನಿಸಿ: ನಿಮ್ಮ ಆಧಾರ್ ("${aadhaarName}") ಮತ್ತು ಪಾಸ್‌ಬುಕ್ ("${bankName}") ನಲ್ಲಿ ಹೆಸರು ಬೇರೆ ಇದೆ. ನಾವು ಮುಂದುವರಿಯುತ್ತೇವೆ, ಆದರೆ ಅಡ್ಮಿನ್ ಪರಿಶೀಲಿಸಬಹುದು. ನೋಂದಣಿ ಪೂರ್ತಿ ಮಾಡುತ್ತಿದ್ದೇವೆ...`,
  passbookVerified: 'ಬ್ಯಾಂಕ್ ಪಾಸ್‌ಬುಕ್ ಪರಿಶೀಲನೆ ಆಯಿತು! ನಿಮ್ಮ ನೋಂದಣಿ ಪೂರ್ತಿ ಮಾಡುತ್ತಿದ್ದೇವೆ...',
  registrationComplete: (name) => `ಅಭಿನಂದನೆಗಳು ${name}! ನಿಮ್ಮ ನೋಂದಣಿ ಪೂರ್ತಿಯಾಯಿತು. ಈಗ ಪ್ರತಿದಿನ ಸೆಲ್ಫಿ ಮತ್ತು ವಾಯ್ಸ್ ನೋಟ್ ಕಳಿಸಿ ನಿಮ್ಮ ಹಾಜರಿ ಹಾಕಬಹುದು.`,
  adminFlagged: 'ನಿಮ್ಮ ದಾಖಲೆ ಅಡ್ಮಿನ್ ಬಳಿ ಪರಿಶೀಲನೆಗೆ ಇದೆ. ಪರಿಶೀಲನೆ ಆದ ಮೇಲೆ ನಾವು ಇಲ್ಲೇ ನಿಮಗೆ ಮೆಸೇಜ್ ಮಾಡುತ್ತೇವೆ.',
  languageChanged: 'ಭಾಷೆಯನ್ನು ಕನ್ನಡಕ್ಕೆ ಬದಲಾಯಿಸಲಾಗಿದೆ.',
  tryAgain: 'ಏನೋ ತೊಂದರೆ ಆಯಿತು. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.',

  // ── Daily check-in (selfie → location → voice) ──
  checkinLocationButton: 'ಸೆಲ್ಫಿ ಸಿಕ್ಕಿತು! ಹಾಜರಿ ಪೂರ್ತಿ ಮಾಡಲು ಈಗ ನಿಮ್ಮ ಲೊಕೇಶನ್ ಕಳಿಸಿ. ಕೆಳಗಿನ ಬಟನ್ ಒತ್ತಿ.',
  // Review outcome (needs a native-speaker check)
  reviewApproved: (day, logged, remaining) => `${day} ರ ನಿಮ್ಮ ಹಾಜರಿಯನ್ನು ಕಲ್ಯಾಣ ಅಧಿಕಾರಿ ಅನುಮೋದಿಸಿದ್ದಾರೆ. ${logged} ದಿನ ದಾಖಲಾಗಿದೆ, ${remaining} ದಿನ ಬಾಕಿ.`,
  reviewRejected: (day, reason) => `${day} ರ ನಿಮ್ಮ ಹಾಜರಿ ಅನುಮೋದನೆ ಆಗಲಿಲ್ಲ.${reason ? ` ಕಾರಣ: ${reason}.` : ''} ದಯವಿಟ್ಟು ಸೆಲ್ಫಿ, ಸ್ಥಳ ಮತ್ತು ವಾಯ್ಸ್ ನೋಟ್ ಜೊತೆ ಮತ್ತೆ ಹಾಜರಿ ಹಾಕಿ.`,
  reviewCertificateHint: 'ನೀವು ಪ್ರಮಾಣಪತ್ರಕ್ಕೆ ಅರ್ಹರಾಗಿದ್ದೀರಿ. ಪಡೆಯಲು "certificate" ಕಳಿಸಿ.',
  checkinExpired: 'ಸೆಲ್ಫಿ 10 ನಿಮಿಷಕ್ಕಿಂತ ಹಳೆಯದಾಗಿರುವುದರಿಂದ ನಿಮ್ಮ ಹಾಜರಿ ಅವಧಿ ಮುಗಿದಿದೆ. ದಯವಿಟ್ಟು ಹೊಸ ಸೆಲ್ಫಿ ಕಳಿಸಿ ಮತ್ತೆ ಶುರು ಮಾಡಿ.',
  locationNoSelfie: 'ಲೊಕೇಶನ್ ಸಿಕ್ಕಿತು! ಈಗ ಹಾಜರಿ ಶುರು ಮಾಡಲು ಸೆಲ್ಫಿ ಕಳಿಸಿ.',
  selfieErrorRetry: 'ಏನೋ ತೊಂದರೆ ಆಯಿತು. ದಯವಿಟ್ಟು ಮತ್ತೆ ಸೆಲ್ಫಿ ಕಳಿಸಿ.',
  activeGuidance: 'ಹಾಜರಿ ಹಾಕಲು ಸೆಲ್ಫಿ + ವಾಯ್ಸ್ ನೋಟ್ ಕಳಿಸಿ, ಅಥವಾ ನಿಮ್ಮ ಸ್ಥಿತಿ ನೋಡಲು "progress" ಎಂದು ಟೈಪ್ ಮಾಡಿ.',

  // ── Check-in results ──
  progressSuffix: (daysLogged, daysRemaining) => ` ${daysLogged} ದಿನ ಹಾಜರಿ ಆಗಿದೆ, ಇನ್ನೂ ${daysRemaining} ದಿನ ಬಾಕಿ.`,
  attendanceDuplicate: 'ನಿಮ್ಮ ಇವತ್ತಿನ ಹಾಜರಿ ಈಗಾಗಲೇ ದಾಖಲಾಗಿದೆ.',
  attendanceVerified: (daysLogged, daysRemaining, eligible) => `ಹಾಜರಿ ಪರಿಶೀಲನೆ ಯಶಸ್ವಿಯಾಗಿದೆ! ${daysLogged}ನೇ ದಿನ ದಾಖಲಾಯಿತು. ಇನ್ನೂ ${daysRemaining} ದಿನ ಬಾಕಿ.${eligible ? ' ನೀವು ಸರ್ಟಿಫಿಕೇಟ್ ಪಡೆಯಲು ಅರ್ಹರು!' : ''}`,
  attendancePending: 'ಹಾಜರಿಯನ್ನು ಅಡ್ಮಿನ್ ಪರಿಶೀಲನೆಗೆ ಕಳಿಸಲಾಗಿದೆ. ಪರಿಶೀಲನೆ ಆದ ಮೇಲೆ ನಿಮಗೆ ತಿಳಿಸುತ್ತೇವೆ.',
  attendanceRejected: 'ಹಾಜರಿ ಪರಿಶೀಲನೆ ವಿಫಲವಾಗಿದೆ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.',
  attendanceError: 'ಹಾಜರಿ ದಾಖಲಿಸುವಲ್ಲಿ ತೊಂದರೆಯಾಗಿದೆ. ದಯವಿಟ್ಟು ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.',

  // ── Progress / certificate / help / greeting (active worker) ──
  progress: (name, daysLogged, threshold, pct, daysRemaining) => `${name}, ನೀವು ${threshold} ದಿನಗಳಲ್ಲಿ ${daysLogged} ದಿನ ಹಾಜರಿ ಹಾಕಿದ್ದೀರಿ (${pct}%). ${daysRemaining > 0 ? `ಇನ್ನೂ ${daysRemaining} ದಿನ ಬಾಕಿ ಇದೆ.` : 'ನೀವು ಸರ್ಟಿಫಿಕೇಟ್ ಪಡೆಯಲು ಅರ್ಹರು!'}`,
  certificateNotReady: (name, daysRemaining) => `${name}, ಸರ್ಟಿಫಿಕೇಟ್‌ಗೆ ಇನ್ನೂ ${daysRemaining} ದಿನ ಬೇಕು. ಪ್ರತಿದಿನ ಹಾಜರಿ ಹಾಕುತ್ತಾ ಇರಿ!`,
  certificateReady: (ref) => `ಅಭಿನಂದನೆಗಳು! ನಿಮ್ಮ ಸ್ಮಾರ್ಟ್ ಸರ್ಟಿಫಿಕೇಟ್ ಸಿದ್ಧವಾಗಿದೆ! BOCW Ref: ${ref}. ಸರ್ಟಿಫಿಕೇಟ್ PDF ಕೆಳಗೆ ಕಳಿಸಲಾಗಿದೆ.`,
  // ── Self-service menu ──
  menuBody: 'ನಿಮಗೆ ಏನು ಬೇಕು? ಕೆಳಗಿನ ಬಟನ್ ಒತ್ತಿ ಆಯ್ಕೆ ಮಾಡಿ.',
  menuButton: 'ಆಯ್ಕೆಗಳು',
  menuRows: {
    today: 'ಇಂದಿನ ಹಾಜರಿ',
    days: 'ನನ್ನ ದಿನಗಳು',
    progress: 'ನನ್ನ ಪ್ರಗತಿ',
    card: 'ನನ್ನ ಸರ್ಟಿಫಿಕೇಟ್',
    checkin: 'ಹಾಜರಿ ಹಾಕಿ',
    language: 'ಭಾಷೆ ಬದಲಿಸಿ',
    help: 'ಸಹಾಯ',
  },
  todayVerified: (site) => `ಇಂದಿನ ಹಾಜರಿ ಪರಿಶೀಲನೆ ಆಗಿದೆ ✅${site ? ` (${site})` : ''}`,
  todayPending: 'ಇಂದಿನ ಹಾಜರಿ ಅಡ್ಮಿನ್ ಪರಿಶೀಲನೆಯಲ್ಲಿದೆ ⏳. ಬೇಗ ತಿಳಿಸುತ್ತೇವೆ.',
  todayRejected: 'ಇಂದಿನ ಹಾಜರಿ ಪರಿಶೀಲನೆ ಆಗಲಿಲ್ಲ ❌. ದಯವಿಟ್ಟು ಮತ್ತೆ ಸೆಲ್ಫಿ ಕಳಿಸಿ.',
  todayNone: 'ಇಂದು ಇನ್ನೂ ಹಾಜರಿ ಹಾಕಿಲ್ಲ. ಹಾಜರಿ ಹಾಕಲು ಸೆಲ್ಫಿ ಕಳಿಸಿ.',
  myDaysHeader: (verified, threshold) => `ನಿಮ್ಮ ${verified} ದಿನ ಪರಿಶೀಲನೆ ಆಗಿದೆ (${threshold} ರಲ್ಲಿ). ಇತ್ತೀಚಿನ ಹಾಜರಿ:`,
  myDaysEmpty: 'ಇನ್ನೂ ಯಾವುದೇ ಹಾಜರಿ ಇಲ್ಲ. ಮೊದಲ ಹಾಜರಿಗೆ ಸೆಲ್ಫಿ ಕಳಿಸಿ.',
  languagePrompt: 'ನಿಮ್ಮ ಭಾಷೆ ಆಯ್ಕೆ ಮಾಡಿ:',

  credentialQrCaption: 'ಈ QR ಕೋಡ್ ಅನ್ನು ಕಲ್ಯಾಣ ಮಂಡಳಿ ಅಧಿಕಾರಿಗೆ ತೋರಿಸಿ. ಅವರು ಇದನ್ನು ಸ್ಕ್ಯಾನ್ ಮಾಡಿ ನಿಮ್ಮ ಕೆಲಸದ ದಿನಗಳನ್ನು ಪರಿಶೀಲಿಸುತ್ತಾರೆ.',
  certificateCaption: (ref) => `ನಿರ್ಮಾಣ ಮಿತ್ರ ಸ್ಮಾರ್ಟ್ ಸರ್ಟಿಫಿಕೇಟ್${ref ? ` (BOCW Ref: ${ref})` : ''}`,
  logAttendanceGuide: 'ಹಾಜರಿ ಹಾಕಲು:\n1. ಸೆಲ್ಫಿ ಫೋಟೋ ಕಳಿಸಿ\n2. ಲೊಕೇಶನ್ ಕಳಿಸಿ (ಬಟನ್ ಒತ್ತಿ)\n3. ಕೆಲಸದ ಬಗ್ಗೆ ವಾಯ್ಸ್ ನೋಟ್ ಕಳಿಸಿ\n\nಮೊದಲು ಸೆಲ್ಫಿ ಕಳಿಸಿ!',
  greetingActive: (name, daysLogged) => `ನಮಸ್ಕಾರ ${name}! ನಾನು ನಿರ್ಮಾಣ ಮಿತ್ರ, ನಿಮ್ಮ ಡಿಜಿಟಲ್ ಸಂಗಾತಿ. ನೀವು ${daysLogged} ದಿನ ಹಾಜರಿ ಹಾಕಿದ್ದೀರಿ. ಹಾಜರಿಗೆ ಸೆಲ್ಫಿ ಕಳಿಸಿ, ಅಥವಾ ನಿಮ್ಮ ಪ್ರಗತಿ ಕೇಳಿ.`,
  help: (name, daysLogged, daysRemaining) => `${name}, ನಾನು ಇವು ಮಾಡಬಹುದು:\n• ಸೆಲ್ಫಿ + ವಾಯ್ಸ್ ನೋಟ್ ಕಳಿಸಿ → ಹಾಜರಿ\n• "progress" ಎಂದು ಹೇಳಿ → ನಿಮ್ಮ ದಿನಗಳು ನೋಡಿ\n• "certificate" ಎಂದು ಹೇಳಿ → ಸರ್ಟಿಫಿಕೇಟ್ ಕೇಳಿ\n\nನೀವು ${daysLogged} ದಿನ ಹಾಜರಿ ಹಾಕಿದ್ದೀರಿ, ${daysRemaining} ದಿನ ಬಾಕಿ.`,
  voiceUnclear: 'ವಾಯ್ಸ್ ನೋಟ್ ಅರ್ಥ ಆಗಲಿಲ್ಲ. ದಯವಿಟ್ಟು ಗದ್ದಲವಿಲ್ಲದ ಜಾಗದಿಂದ ಮತ್ತೆ ಹೇಳಿ, ಅಥವಾ ನಿಮ್ಮ ಪ್ರಶ್ನೆ ಟೈಪ್ ಮಾಡಿ.',
  voiceError: 'ಏನೋ ತೊಂದರೆ ಆಯಿತು. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ ಅಥವಾ ನಿಮ್ಮ ಪ್ರಶ್ನೆ ಟೈಪ್ ಮಾಡಿ.',
  demoFail: 'ಹಾಜರಿಯನ್ನು ಅಡ್ಮಿನ್ ಪರಿಶೀಲನೆಗೆ ಕಳಿಸಲಾಗಿದೆ — ವಿಶ್ವಾಸ ಕಡಿಮೆ ಇತ್ತು. ಅಡ್ಮಿನ್ ಡ್ಯಾಶ್‌ಬೋರ್ಡ್‌ನಲ್ಲಿ review queue ನೋಡಿ.',
  demoCertificate: (threshold) => `ಡೆಮೊ ಮೋಡ್: ನಿಮ್ಮ ದಿನಗಳನ್ನು ${threshold} ಕ್ಕೆ ಹೊಂದಿಸಲಾಗಿದೆ. ಸರ್ಟಿಫಿಕೇಟ್ ತಯಾರಿಸುತ್ತಿದ್ದೇವೆ...`,

  // ── Async notifications (notificationSender) ──
  notifyAadhaarProcessed: (name) => `${name}, ನಿಮ್ಮ ಆಧಾರ್ ಕಾರ್ಡ್ ಪರಿಶೀಲನೆ ಆಯಿತು. ಈಗ ದಯವಿಟ್ಟು ನಿಮ್ಮ ಸೆಲ್ಫಿ ಕಳಿಸಿ.`,
  notifySelfieProcessed: (name) => `${name}, ನಿಮ್ಮ ಸೆಲ್ಫಿ ಉಳಿಸಲಾಗಿದೆ. ಈಗ ದಯವಿಟ್ಟು ಬ್ಯಾಂಕ್ ಪಾಸ್‌ಬುಕ್ ಫೋಟೋ ಕಳಿಸಿ.`,
  notifyPassbookProcessed: (name) => `${name}, ನಿಮ್ಮ ಬ್ಯಾಂಕ್ ಪಾಸ್‌ಬುಕ್ ಪರಿಶೀಲನೆ ಆಯಿತು. ನೋಂದಣಿ ಪೂರ್ತಿ ಮಾಡುತ್ತಿದ್ದೇವೆ...`,
  notifyRegistrationComplete: (name) => `ಅಭಿನಂದನೆಗಳು ${name}! ನಿಮ್ಮ ನೋಂದಣಿ ಪೂರ್ತಿಯಾಯಿತು. ಈಗ ಪ್ರತಿದಿನ ಸೆಲ್ಫಿ ಮತ್ತು ವಾಯ್ಸ್ ನೋಟ್ ಕಳಿಸಿ ಹಾಜರಿ ಹಾಕಿ.`,
  notifyAttendanceConfirmed: (name, daysLogged, daysRemaining) => `${name}, ನಿಮ್ಮ ಹಾಜರಿ ಆಯಿತು! ${daysLogged}ನೇ ದಿನ ಪರಿಶೀಲನೆ ಆಯಿತು. ಇನ್ನೂ ${daysRemaining} ದಿನ ಬಾಕಿ ಇದೆ.`,
  notifyAttendanceRejected: (name) => `${name}, ನಿಮ್ಮ ಹಾಜರಿ ಪರಿಶೀಲನೆ ವಿಫಲವಾಗಿದೆ. ದಯವಿಟ್ಟು ಸ್ಪಷ್ಟವಾದ ಸೆಲ್ಫಿ ಮತ್ತು ವಾಯ್ಸ್ ನೋಟ್ ಕಳಿಸಿ.`,
  notifyAttendancePending: (name) => `${name}, ನಿಮ್ಮ ಹಾಜರಿ ಅಡ್ಮಿನ್ ಪರಿಶೀಲನೆಯಲ್ಲಿದೆ. ಬೇಗ ತಿಳಿಸುತ್ತೇವೆ.`,
  notifyAttendanceDuplicate: (name) => `${name}, ನಿಮ್ಮ ಇವತ್ತಿನ ಹಾಜರಿ ಈಗಾಗಲೇ ದಾಖಲಾಗಿದೆ.`,
  notifyCertificateReady: (name) => `ಅಭಿನಂದನೆಗಳು ${name}! ನಿಮ್ಮ ಸರ್ಟಿಫಿಕೇಟ್ ಸಿದ್ಧವಾಗಿದೆ. ಕೆಳಗಿನ ಲಿಂಕ್‌ನಿಂದ ಡೌನ್‌ಲೋಡ್ ಮಾಡಿ.`,
  notifyError: (name) => `${name}, ಏನೋ ತೊಂದರೆ ಆಯಿತು. ದಯವಿಟ್ಟು ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.`,
};
