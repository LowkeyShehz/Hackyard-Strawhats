/**
 * Nirman Mitra — Configuration Manager
 * Reads all environment variables from SAM template globals.
 * Provides demo mode toggle and utility helpers.
 */

/** CERTIFICATE_THRESHOLD must be an integer >= 1; anything else would issue certificates too early */
function parseCertificateThreshold(raw = '3') {
  const value = String(raw).trim();
  if (/^\d+$/.test(value) && parseInt(value, 10) >= 1) return parseInt(value, 10);
  console.error(`[Config] Invalid CERTIFICATE_THRESHOLD "${raw}"; falling back to 90`);
  return 90;
}

const config = Object.freeze({
  // Environment
  environment: process.env.ENVIRONMENT || 'dev',
  certificateThreshold: parseCertificateThreshold(process.env.CERTIFICATE_THRESHOLD),

  // Process webhook messages in a separate async invocation (set in template.yaml; only on Lambda)
  asyncWebhook: process.env.ASYNC_WEBHOOK === 'true' && Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME),

  // Public URL of the dashboard / officer portal (no trailing slash); certificate QR codes link here
  portalUrl: (process.env.PORTAL_URL || '').replace(/\/+$/, ''),

  // Signed work credentials: issuer's ES256 private key as a JWK (JSON string)
  credential: {
    signingJwk: process.env.CREDENTIAL_SIGNING_JWK || '',
  },

  // Team phone numbers (digits only, comma-separated) allowed to use the "demo cert" /
  // "test review" keywords. Empty means nobody can.
  demoPhoneNumbers: (process.env.DEMO_PHONE_NUMBERS || '')
    .split(',')
    .map((n) => n.replace(/\D/g, ''))
    .filter(Boolean),

  // JWT Auth
  jwt: {
    // The dev fallbacks apply only to local runs. On Lambda a missing secret stays empty, so
    // signing fails and every token is rejected instead of trusting a publicly known key.
    secret: process.env.JWT_SECRET || (process.env.AWS_LAMBDA_FUNCTION_NAME ? '' : 'dev-jwt-secret-change-me'),
    refreshSecret: process.env.JWT_REFRESH_SECRET
      || (process.env.AWS_LAMBDA_FUNCTION_NAME ? '' : 'dev-refresh-secret-change-me'),
    accessTokenExpiry: '15m',
    refreshTokenExpiry: '7d',
  },

  // DynamoDB Tables
  tables: {
    workers: process.env.WORKERS_TABLE || 'NirmanMitra-Workers-dev',
    attendance: process.env.ATTENDANCE_TABLE || 'NirmanMitra-AttendanceLogs-dev',
    sites: process.env.SITES_TABLE || 'NirmanMitra-Sites-dev',
    certificates: process.env.CERTIFICATES_TABLE || 'NirmanMitra-Certificates-dev',
    documents: process.env.DOCUMENTS_TABLE || 'NirmanMitra-Documents-dev',
    conversation: process.env.CONVERSATION_TABLE || 'NirmanMitra-ConversationState-dev',
    bedrockCache: process.env.BEDROCK_CACHE_TABLE || 'NirmanMitra-BedrockCache-dev',
    adminUsers: process.env.ADMIN_USERS_TABLE || 'NirmanMitra-AdminUsers-dev',
    refreshTokens: process.env.REFRESH_TOKENS_TABLE || 'NirmanMitra-RefreshTokens-dev',
    audit: process.env.AUDIT_TABLE || 'NirmanMitra-AuditLog-dev',
  },

  // Version of the WhatsApp purpose notice a worker agrees to; bump it when the notice text changes
  consentNoticeVersion: '2026-09-27',

  // S3 Buckets
  buckets: {
    mediaRaw: process.env.MEDIA_RAW_BUCKET || 'nirman-mitra-media-raw',
    mediaProcessed: process.env.MEDIA_PROCESSED_BUCKET || 'nirman-mitra-media-processed',
    certificates: process.env.CERTIFICATES_BUCKET || 'nirman-mitra-certificates',
  },

  // WhatsApp Business (Meta Cloud API)
  whatsapp: {
    apiToken: process.env.WHATSAPP_API_TOKEN || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    apiBaseUrl: process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v22.0',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  },

  // SQS
  queues: {
    processing: process.env.PROCESSING_QUEUE_URL || '',
    dlq: process.env.DLQ_URL || '',
  },

  // Step Functions
  stepFunctions: {
    onboardingFlow: process.env.ONBOARDING_FLOW_ARN || '',
    attendanceFlow: process.env.ATTENDANCE_FLOW_ARN || '',
    certificateFlow: process.env.CERTIFICATE_FLOW_ARN || '',
  },

  // Rekognition
  rekognitionCollectionId: process.env.REKOGNITION_COLLECTION_ID || 'nirman-mitra-workers',

  // Lex V2 (optional intent layer; disabled when botId is empty)
  lex: {
    botId: process.env.LEX_BOT_ID || '',
    botAliasId: process.env.LEX_BOT_ALIAS_ID || '',
    localeId: process.env.LEX_LOCALE_ID || 'en_US',
  },

  // AWS region used by every AWS SDK client
  aws: {
    region: process.env.AWS_REGION || 'ap-south-1',
  },

  // LLM provider (see src/providers/llm.js)
  llm: {
    provider: process.env.LLM_PROVIDER || 'groq',
    model: process.env.LLM_MODEL || 'openai/gpt-oss-120b',
    groqApiKey: process.env.GROQ_API_KEY || '',
  },

  // Polly language → voice mapping. Polly's only Indian voices are hi-IN and en-IN (Kajal,
  // Aditi, Raveena); there is no Kannada, Tamil, Telugu, Malayalam, Bengali, Marathi or Gujarati
  // voice (https://docs.aws.amazon.com/polly/latest/dg/available-voices.html). Languages not
  // listed here get text-only replies rather than being read out by a Hindi voice.
  pollyVoices: {
    hi: { voiceId: 'Kajal', engine: 'neural', languageCode: 'hi-IN' },
    en: { voiceId: 'Kajal', engine: 'neural', languageCode: 'en-IN' },
  },
});

/** Check if running in demo/dev mode (only true when running locally, not on Lambda) */
export function isDemoMode() {
  return !process.env.AWS_LAMBDA_FUNCTION_NAME && config.environment === 'dev';
}

/**
 * Calendar date (YYYY-MM-DD) in IST (UTC+5:30). Attendance "days" are Indian calendar days,
 * so a check-in at 01:00 IST belongs to that IST date, not the previous UTC date.
 * @param {number} [ms] - Epoch milliseconds (default now)
 */
export function istDate(ms = Date.now()) {
  return new Date(ms + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
}

/** Get certificate threshold (3 for demo, 90 for prod) */
export function getCertificateThreshold() {
  return config.certificateThreshold;
}

/** Build standard CORS headers for API responses */
export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Api-Key',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Content-Type': 'application/json',
  };
}

/** Build a standard API response */
export function apiResponse(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(body),
  };
}

export default config;
