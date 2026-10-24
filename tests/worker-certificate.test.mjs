// Regression tests for certificate issuance and WhatsApp delivery.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as H from './helpers/harness.mjs';

const { M, send } = H;
const { putItem } = await import('../src/utils/dynamodb.js');
const { default: config, istDate } = await import('../src/utils/config.js');
const { handler: certHandler } = await import('../src/handlers/certificateGenerator.js');

const certsFor = (wid) => [...H.table('Certificates').values()].filter((c) => c.worker_id === wid);
const docsSent = (from) => H.wa.sent.slice(from).filter((m) => m.type === 'document');

before(async () => {
  H.quiet();
  await putItem(config.tables.sites, {
    site_id: 'S1', site_name: 'Metro', is_active: 'true',
    geo_location: { latitude: 12.9716, longitude: 77.5946 }, radius_meters: 500,
  });
  H.llm.responder = H.defaultLlmResponder;
});
after(() => H.close());

async function onboard(phone) {
  await send(phone, M.text('Namaste'));
  await H.agree(phone);
  await send(phone, M.text('Ram Kumar'));
  await send(phone, M.image('a1'));
  await send(phone, M.image('s1'));
  await send(phone, M.location());
  return H.worker(phone);
}

/** Approved logs on the `days` IST dates before today */
async function seedApprovedLogs(workerId, days) {
  for (let i = 1; i <= days; i++) {
    await putItem(config.tables.attendance, {
      worker_id: workerId, log_date: istDate(Date.now() - i * 86400000), verification_status: 'approved',
      site_id: 'S1', site_name: 'Metro', timestamp: new Date().toISOString(),
    });
  }
}

test('concurrent generate calls issue exactly one certificate', async () => {
  const worker_id = 'w-cert-race';
  await putItem(config.tables.workers, { worker_id, phone_number: '918100000001', name: 'Sita Devi', aadhaar_last4: '3450', profile_status: 'active', total_days_logged: 3 });
  await seedApprovedLogs(worker_id, 3);
  const results = await Promise.all([
    certHandler({ task: 'generate', workerId: worker_id }),
    certHandler({ task: 'generate', workerId: worker_id }),
  ]);
  assert.equal(results.filter((r) => r.success).length, 1);
  assert.equal(results.find((r) => !r.success).reason, 'certificate_already_exists');
  assert.equal(certsFor(worker_id).length, 1);
});

test('the certificate record snapshots worker_name and aadhaar_last4', async () => {
  const [cert] = certsFor('w-cert-race');
  assert.equal(cert.worker_name, 'Sita Devi');
  assert.equal(cert.aadhaar_last4, '3450');
});

test('the certificate PDF is delivered as a WhatsApp document and re-sent on request', async () => {
  const phone = '919500000001';
  const w = await onboard(phone);
  await seedApprovedLogs(w.worker_id, 2);
  await putItem(config.tables.workers, { ...H.worker(phone), total_days_logged: 2 });

  const before = H.wa.sent.length;
  await send(phone, M.image('c1'));
  await send(phone, M.location());
  await send(phone, M.audio('v1'));
  const [doc] = docsSent(before);
  assert.ok(doc, 'certificate sent as a document');
  assert.match(doc.document.filename, /\.pdf$/);
  assert.ok(doc.document.link.includes('X-Amz-Expires=900'), 'fresh short-lived presigned link');
  assert.equal(certsFor(w.worker_id).length, 1);
  assert.ok(!H.wa.sent.slice(before).some((m) => m.text?.body?.includes('https://')), 'no link pasted in text');

  const again = H.wa.sent.length;
  await send(phone, M.text('certificate'));
  const resent = docsSent(again);
  assert.equal(resent.length, 1, 'existing certificate re-sent');
  assert.equal(resent[0].document.filename, doc.document.filename);
  assert.equal(certsFor(w.worker_id).length, 1, 'no second certificate');
});

test('CERTIFICATE_THRESHOLD must be an integer >= 1, else 90', () => {
  const threshold = (value) => execFileSync(process.execPath, [
    '--input-type=module', '-e',
    "const { default: c } = await import('./src/utils/config.js'); process.stdout.write(String(c.certificateThreshold));",
  ], { env: { ...process.env, CERTIFICATE_THRESHOLD: value }, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  assert.equal(threshold('5'), '5');
  for (const bad of ['0', '-3', 'abc', '2.5', '']) {
    assert.equal(threshold(bad), '90', `"${bad}" falls back to 90`);
  }
});
