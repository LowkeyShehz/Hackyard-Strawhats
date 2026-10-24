/**
 * Nirman Mitra — Signed Work Credential
 * Issues a W3C-style verifiable credential as a JWT signed with ES256.
 * The issuer is a did:web identifier; its public key is published at
 * https://<portal host>/.well-known/did.json, so an officer's browser can verify the
 * signature without calling the Nirman Mitra API.
 */

import { SignJWT, importJWK } from 'jose';
import config from '../utils/config.js';

const CREDENTIAL_VALIDITY_SECONDS = 365 * 24 * 60 * 60;

let signingKeyPromise = null;

/** Parse and import the issuer's private JWK once per container */
function getSigningKey() {
  if (!signingKeyPromise) {
    signingKeyPromise = (async () => {
      const raw = config.credential.signingJwk;
      if (!raw) throw new Error('CREDENTIAL_SIGNING_JWK is not configured');
      // Accept the JWK as raw JSON or base64 (base64 survives deployment parameter parsing)
      const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
      const jwk = JSON.parse(json);
      return { key: await importJWK(jwk, 'ES256'), kid: jwk.kid || 'key-1' };
    })().catch((err) => {
      signingKeyPromise = null;
      throw err;
    });
  }
  return signingKeyPromise;
}

/** did:web identifier derived from the portal URL: https://host → did:web:host */
export function issuerDid() {
  if (!config.portalUrl) return '';
  return `did:web:${new URL(config.portalUrl).host}`;
}

/** True when signed credentials can be issued (key and portal URL configured) */
export function canIssueCredentials() {
  return Boolean(config.credential.signingJwk && config.portalUrl);
}

/**
 * Sign a work credential.
 * @param {object} data
 * @param {string} data.certificateId - Used as the credential ID (jti)
 * @param {string} data.workerId
 * @param {string} data.workerName
 * @param {string} data.aadhaarLast4
 * @param {number} data.verifiedDays
 * @param {string} data.dateFrom - YYYY-MM-DD
 * @param {string} data.dateTo - YYYY-MM-DD
 * @param {Array<{name: string}>} data.sites
 * @returns {Promise<{token: string, verifyUrl: string}>}
 */
export async function issueWorkCredential(data) {
  const { key, kid } = await getSigningKey();
  const iss = issuerDid();

  const token = await new SignJWT({
    vc: {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', 'ConstructionWorkCredential'],
      credentialSubject: {
        name: data.workerName,
        aadhaarLast4: data.aadhaarLast4,
        verifiedDays: data.verifiedDays,
        from: data.dateFrom,
        to: data.dateTo,
        sites: (data.sites || []).map((s) => s.name),
      },
    },
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: `${iss}#${kid}` })
    .setIssuer(iss)
    .setSubject(data.workerId)
    .setJti(data.certificateId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + CREDENTIAL_VALIDITY_SECONDS)
    .sign(key);

  // The token sits in the URL fragment, so it is never sent to (or logged by) any server
  return { token, verifyUrl: `${config.portalUrl}/verify#${token}` };
}

export default { issueWorkCredential, issuerDid, canIssueCredentials };
