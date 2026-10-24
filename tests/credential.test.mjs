// Signed work credentials: ES256 JWT issued at certificate time, verifiable with the did:web key.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPair, exportJWK, jwtVerify, importJWK, decodeProtectedHeader } from 'jose';

// Test issuer key, set before any src/ module reads the environment
const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
const privateJwk = { ...(await exportJWK(privateKey)), kid: 'key-1', alg: 'ES256' };
process.env.CREDENTIAL_SIGNING_JWK = JSON.stringify(privateJwk);

const H = await import('./helpers/harness.mjs');
const { putItem } = await import('../src/utils/dynamodb.js');
const { default: config } = await import('../src/utils/config.js');
const { issueWorkCredential, issuerDid } = await import('../src/services/credential.js');
const { handler: certHandler } = await import('../src/handlers/certificateGenerator.js');

const tokenFrom = (verifyUrl) => verifyUrl.split('#')[1];

before(() => H.quiet());
after(() => H.close());

test('issuer DID is derived from the portal URL', () => {
  assert.equal(issuerDid(), 'did:web:portal.example.com');
});

test('a credential verifies with the issuer public key and carries the work claims', async () => {
  const { token, verifyUrl } = await issueWorkCredential({
    certificateId: 'cert-1', workerId: 'w-1', workerName: 'Ravi Kumar', aadhaarLast4: '1234',
    verifiedDays: 3, dateFrom: '2026-09-24', dateTo: '2026-09-26', sites: [{ name: 'Metro' }],
  });

  assert.equal(verifyUrl, `${config.portalUrl}/verify#${token}`);
  assert.equal(decodeProtectedHeader(token).kid, 'did:web:portal.example.com#key-1');

  const { payload } = await jwtVerify(token, publicKey, { issuer: 'did:web:portal.example.com', algorithms: ['ES256'] });
  assert.equal(payload.sub, 'w-1');
  assert.equal(payload.jti, 'cert-1');
  assert.ok(payload.exp > payload.iat);
  assert.deepEqual(payload.vc.credentialSubject, {
    name: 'Ravi Kumar', aadhaarLast4: '1234', verifiedDays: 3,
    from: '2026-09-24', to: '2026-09-26', sites: ['Metro'],
  });
});

test('a tampered credential is rejected', async () => {
  const { token } = await issueWorkCredential({
    certificateId: 'cert-2', workerId: 'w-2', workerName: 'A', aadhaarLast4: '0000',
    verifiedDays: 3, dateFrom: '2026-09-24', dateTo: '2026-09-26', sites: [],
  });
  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  claims.vc.credentialSubject.verifiedDays = 90;
  const forged = [header, Buffer.from(JSON.stringify(claims)).toString('base64url'), signature].join('.');
  await assert.rejects(jwtVerify(forged, publicKey, { algorithms: ['ES256'] }));
});

test('issuing a certificate embeds a signed credential in the QR link', async () => {
  const workerId = 'w-cert';
  await putItem(config.tables.workers, {
    worker_id: workerId, phone_number: '919000000001', name: 'Sita Devi', aadhaar_last4: '4321',
    profile_status: 'active', total_days_logged: 3,
  });
  for (const day of ['2026-09-24', '2026-09-25', '2026-09-26']) {
    await putItem(config.tables.attendance, {
      worker_id: workerId, log_date: day, verification_status: 'auto_approved', site_id: 'S1', site_name: 'Metro',
    });
  }

  const result = await certHandler({ task: 'generate', workerId });
  assert.equal(result.success, true);
  assert.equal(result.signedCredential, true);
  assert.match(result.verificationUrl, /^https:\/\/portal\.example\.com\/verify#/);
  assert.ok(result.qrS3Key.endsWith('-qr.png'));

  const { payload } = await jwtVerify(tokenFrom(result.verificationUrl), publicKey, { algorithms: ['ES256'] });
  assert.equal(payload.sub, workerId);
  assert.equal(payload.jti, result.certificateId);
  assert.equal(payload.vc.credentialSubject.verifiedDays, 3);
});

test('the key also loads when supplied base64-encoded', async () => {
  const b64 = Buffer.from(JSON.stringify(privateJwk)).toString('base64');
  const key = await importJWK(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')), 'ES256');
  assert.ok(key);
});

test('the published did.json holds only the public key', () => {
  const doc = JSON.parse(readFileSync(new URL('../admin-dashboard/public/.well-known/did.json', import.meta.url), 'utf8'));
  const method = doc.verificationMethod[0];
  assert.equal(doc.id, 'did:web:main.d26uqawil4ygv7.amplifyapp.com');
  assert.equal(method.id, `${doc.id}#key-1`);
  assert.deepEqual(doc.assertionMethod, [method.id]);
  assert.equal(method.publicKeyJwk.crv, 'P-256');
  assert.equal(method.publicKeyJwk.d, undefined);
});
