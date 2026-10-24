/**
 * In-browser verification of Nirman Mitra work credentials.
 * The credential is an ES256 JWT. The issuer's public key is read from its did:web document
 * (a static file), so deciding validity never calls the Nirman Mitra API.
 */

import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';

/**
 * Issuers this portal trusts. By default only the portal's own did:web, so a credential
 * self-signed by anyone else is rejected even if its signature is internally valid.
 */
export function trustedIssuers() {
  const configured = import.meta.env.VITE_TRUSTED_ISSUERS;
  if (configured) return configured.split(',').map((s) => s.trim()).filter(Boolean);
  return [`did:web:${window.location.host}`];
}

/** did:web:host → https://host/.well-known/did.json */
function didDocumentUrl(did) {
  const host = decodeURIComponent(did.replace(/^did:web:/, '').split(':')[0]);
  return `https://${host}/.well-known/did.json`;
}

/** Credential token from a /verify#<token> URL fragment, or '' */
export function tokenFromLocation(location = window.location) {
  const fragment = (location.hash || '').replace(/^#/, '');
  return /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(fragment) ? fragment : '';
}

export class CredentialError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Verify a credential token.
 * @returns {Promise<{payload: object, issuer: string, keyId: string, ms: number}>}
 * @throws {CredentialError} with code: malformed | untrusted_issuer | key_unavailable | invalid_signature | expired
 */
export async function verifyCredential(token) {
  const started = performance.now();

  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new CredentialError('malformed', 'This is not a valid credential.');
  }
  const keyId = header.kid || '';
  const issuer = keyId.split('#')[0];
  if (header.alg !== 'ES256' || !issuer.startsWith('did:web:')) {
    throw new CredentialError('malformed', 'This credential uses an unsupported format.');
  }
  if (!trustedIssuers().includes(issuer)) {
    throw new CredentialError('untrusted_issuer', `Issuer ${issuer} is not a trusted issuer.`);
  }

  let key;
  try {
    const res = await fetch(didDocumentUrl(issuer), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    const method = (doc.verificationMethod || []).find((m) => m.id === keyId);
    if (!method?.publicKeyJwk) throw new Error('key not published');
    key = await importJWK(method.publicKeyJwk, 'ES256');
  } catch {
    throw new CredentialError('key_unavailable', "Could not load the issuer's public key. Check your connection and try again.");
  }

  try {
    const { payload } = await jwtVerify(token, key, { issuer, algorithms: ['ES256'] });
    return { payload, issuer, keyId, ms: Math.round(performance.now() - started) };
  } catch (err) {
    if (err?.code === 'ERR_JWT_EXPIRED') {
      throw new CredentialError('expired', 'This credential has expired.');
    }
    throw new CredentialError('invalid_signature', 'The signature does not match. This credential may have been altered.');
  }
}
