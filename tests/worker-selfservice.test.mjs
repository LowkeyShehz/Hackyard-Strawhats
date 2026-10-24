// WhatsApp self-service for active workers: tap menu, today, my days, language, certificate resend.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers/harness.mjs';

const { M, send } = H;
const { putItem, saveConversationState } = await import('../src/utils/dynamodb.js');
const { default: config, istDate } = await import('../src/utils/config.js');

const lastSent = (from, type) => H.wa.sent.slice(from).filter((p) => p.type === type);

async function activeWorker(workerId, phone, language = 'en') {
  await putItem(config.tables.workers, {
    worker_id: workerId, phone_number: phone, name: 'Ravi', profile_status: 'active',
    preferred_language: language, total_days_logged: 0,
    // An active worker has already agreed to the purpose notice
    consent_version: config.consentNoticeVersion, consent_language: language, consent_channel: 'whatsapp',
  });
}

before(async () => {
  H.quiet();
  H.llm.responder = H.defaultLlmResponder;
  await activeWorker('w-ss-1', '918200000001');
  await activeWorker('w-ss-2', '918200000002');
  await activeWorker('w-ss-3', '918200000003');
  await activeWorker('w-ss-4', '918200000004', 'kn');
});
after(() => H.close());

test('"menu" sends a tap-able list whose rows carry intent ids', async () => {
  const start = H.wa.sent.length;
  const { replies } = await send('918200000001', M.text('menu'));
  assert.ok(replies.includes('[interactive:list]'));
  const [list] = lastSent(start, 'interactive');
  const ids = list.interactive.action.sections[0].rows.map((r) => r.id);
  assert.deepEqual(ids, ['menu_today', 'menu_days', 'menu_progress', 'menu_card', 'menu_checkin', 'menu_language', 'menu_help']);
  assert.ok(list.interactive.action.sections[0].rows.every((r) => r.title.length <= 24));
});

test('tapping "today" with no check-in says none yet', async () => {
  const { replies } = await send('918200000001', M.button('menu_today', "Today's attendance"));
  assert.match(replies[0], /No attendance yet today/);
});

test('"aaj" after a verified check-in reports it verified with the site', async () => {
  await putItem(config.tables.attendance, {
    worker_id: 'w-ss-1', log_date: istDate(), verification_status: 'auto_approved',
    site_id: 'S1', site_name: 'NITK Site', timestamp: new Date().toISOString(),
  });
  const { replies } = await send('918200000001', M.text('aaj'));
  assert.match(replies[0], /verified ✅ \(NITK Site\)/);
});

test('a work description containing "aaj" is not a today-status query', async () => {
  const { replies } = await send('918200000001', M.text('aaj maine plaster kiya'));
  assert.doesNotMatch(replies[0] || '', /Today's attendance/);
});

test('"mere din" lists recent days, newest first, with a verified count', async () => {
  const yesterday = istDate(Date.now() - 86400000);
  await putItem(config.tables.attendance, {
    worker_id: 'w-ss-1', log_date: yesterday, verification_status: 'pending_review',
    site_id: 'S1', site_name: 'NITK Site', timestamp: new Date().toISOString(),
  });
  const { replies } = await send('918200000001', M.text('mere din'));
  const [header, first, second] = replies[0].split('\n');
  assert.match(header, /^1 of 3 days verified/);
  assert.match(first, /^✅ /);
  assert.match(second, /^⏳ /);
});

test('a Kannada "my days" phrase routes to the history', async () => {
  const { replies } = await send('918200000004', M.text('ನನ್ನ ದಿನಗಳು'));
  assert.equal(replies[0], 'ಇನ್ನೂ ಯಾವುದೇ ಹಾಜರಿ ಇಲ್ಲ. ಮೊದಲ ಹಾಜರಿಗೆ ಸೆಲ್ಫಿ ಕಳಿಸಿ.');
});

test('language: buttons are offered and the choice is saved', async () => {
  const { replies } = await send('918200000002', M.text('language'));
  assert.ok(replies.some((r) => r.startsWith('[buttons] ')), `reply buttons offered: ${replies}`);
  const set = await send('918200000002', M.button('lang_kn', 'ಕನ್ನಡ'));
  assert.equal(H.worker('918200000002').preferred_language, 'kn');
  assert.match(set.replies[0], /ಕನ್ನಡಕ್ಕೆ/);
});

test('a menu tap during a check-in does not submit the check-in', async () => {
  await saveConversationState('w-ss-3', 'w-ss-3', {
    current_step: 'awaiting_voice', pending_selfie_key: 'workers/w-ss-3/checkin.jpg', preferred_language: 'en',
  });
  const { replies } = await send('918200000003', M.button('menu_today', "Today's attendance"));
  assert.match(replies[0], /No attendance yet today/);
  const logs = [...H.table('AttendanceLogs').values()].filter((l) => l.worker_id === 'w-ss-3');
  assert.equal(logs.length, 0);
});

test('asking for the card again resends the PDF and the credential QR', async () => {
  await putItem(config.tables.certificates, {
    worker_id: 'w-ss-2', certificate_id: 'c-ss-2', pdf_s3_key: 'certificates/w-ss-2/c-ss-2.pdf',
    qr_s3_key: 'certificates/w-ss-2/c-ss-2-qr.png', credential_jwt: 'eyJ.a.b', created_at: new Date().toISOString(),
  });
  const start = H.wa.sent.length;
  await send('918200000002', M.text('mera card'));
  assert.equal(lastSent(start, 'document').length, 1);
  assert.equal(lastSent(start, 'image').length, 1);
});

test('help also shows the menu', async () => {
  const { replies } = await send('918200000001', M.text('help'));
  assert.ok(replies.includes('[interactive:list]'));
});
