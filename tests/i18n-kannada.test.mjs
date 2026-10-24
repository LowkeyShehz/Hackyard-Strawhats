// Kannada (PRD FR-8): replies on the demo path are in Kannada, and Kannada text is never
// spoken by a Hindi Polly voice (Polly has no Kannada voice, so Kannada replies are text-only).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers/harness.mjs';

const { M, send } = H;
const { putItem } = await import('../src/utils/dynamodb.js');
const { default: config } = await import('../src/utils/config.js');
const { handler: notify } = await import('../src/handlers/notificationSender.js');
const { t, KN } = await import('../src/utils/i18n.js');

const KANNADA = /[ಀ-೿]/;
const kannadaPollyCalls = () => H.polly.calls.filter((c) => KANNADA.test(c.Text));

before(async () => {
  H.quiet();
  await putItem(config.tables.sites, {
    site_id: 'S-KN', site_name: 'Metro', is_active: 'true',
    geo_location: { latitude: 12.9716, longitude: 77.5946 }, radius_meters: 500,
  });
  H.llm.responder = H.defaultLlmResponder;
});
after(() => H.close());

async function onboard(phone, greeting) {
  const notice = await send(phone, M.text(greeting));
  const first = await H.agree(phone);
  await send(phone, M.text('Ram Kumar'));
  await send(phone, M.image('a1'));
  await send(phone, M.image('s1'));
  const last = await send(phone, M.location());
  return { notice, first, last };
}

async function checkIn(phone) {
  await send(phone, M.image('c1'));
  const loc = await send(phone, M.location());
  const result = await send(phone, M.text('ok'));
  return { loc, result };
}

test('t() falls back to Hindi for a language without a variant', () => {
  assert.equal(t('kn', { en: 'E', hi: 'H', kn: 'K' }), 'K');
  assert.equal(t('ta', { en: 'E', hi: 'H', kn: 'K' }), 'H');
  assert.equal(t('en', { hi: 'H' }), 'H');
});

test('a worker who writes in Kannada script is greeted and onboarded in Kannada, with no Polly call', async () => {
  const phone = '919500000001';
  const pollyBefore = H.polly.calls.length;
  const { notice, first, last } = await onboard(phone, 'ನಮಸ್ಕಾರ');
  assert.equal(H.worker(phone).preferred_language, 'kn');
  assert.deepEqual(notice.replies, [`[buttons] ${KN.consentNotice}`], 'consent notice in Kannada first');
  assert.deepEqual(first.replies, [KN.consentThanks, KN.greetingNew], 'text only: no audio message');
  assert.ok(last.replies.every((r) => KANNADA.test(r)), `registration replies in Kannada: ${last.replies}`);
  assert.equal(H.worker(phone).profile_status, 'active');
  assert.equal(H.polly.calls.length, pollyBefore, 'no Polly call for Kannada replies');
});

test('after switching to Kannada, check-in prompts and the result are in Kannada', async () => {
  const phone = '919500000002';
  await onboard(phone, 'Namaste');
  assert.equal(H.worker(phone).preferred_language, 'hi');

  const sw = await send(phone, M.text('ಕನ್ನಡ'));
  assert.equal(H.worker(phone).preferred_language, 'kn');
  assert.equal(sw.replies[0], KN.languageChanged);

  const pollyBefore = H.polly.calls.length;
  const { loc, result } = await checkIn(phone);
  assert.match(loc.replies[0], /ಸ್ಥಳ ಸ್ವೀಕರಿಸಲಾಗಿದೆ!/); // Changed to regex because passcode makes it dynamic
  assert.equal(result.replies.length, 1, 'text only: no audio message');
  assert.match(result.replies[0], KANNADA);
  assert.match(result.replies[0], /ಹಾಜರಿ/);
  assert.doesNotMatch(result.replies[0], /Attendance|din aur baaki/);
  assert.equal(H.polly.calls.length, pollyBefore, 'no Polly call for Kannada replies');
});

test('Kannada progress / help replies; a Kannada-script keyword is understood', async () => {
  const phone = '919500000003';
  await onboard(phone, 'ನಮಸ್ಕಾರ');
  const progress = await send(phone, M.text('ನನ್ನ ಪ್ರಗತಿ'));
  assert.match(progress.replies[0], /ಹಾಜರಿ ಹಾಕಿದ್ದೀರಿ/);
  const cert = await send(phone, M.text('certificate'));
  assert.match(cert.replies[0], /ಸರ್ಟಿಫಿಕೇಟ್‌ಗೆ ಇನ್ನೂ \d+ ದಿನ ಬೇಕು/);
  const help = await send(phone, M.text('help'));
  assert.match(help.replies[0], /ನಾನು ಇವು ಮಾಡಬಹುದು/);
});

test('notifications for a Kannada worker are Kannada text with no voice', async () => {
  await putItem(config.tables.workers, { worker_id: 'w-kn-notify', phone_number: '919500000004', preferred_language: 'kn', name: 'Ramu', total_days_logged: 2 });
  const sentBefore = H.wa.sent.length;
  const pollyBefore = H.polly.calls.length;
  const res = await notify({ workerId: 'w-kn-notify', notificationType: 'attendance_confirmed' });
  assert.equal(res.statusCode, 200);
  const sent = H.wa.sent.slice(sentBefore);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text.body, /^Ramu, ನಿಮ್ಮ ಹಾಜರಿ ಆಯಿತು!/);
  assert.equal(H.polly.calls.length, pollyBefore);
});

test('no Polly call is ever made with Kannada text, and ta/te get no Hindi voice', () => {
  assert.equal(kannadaPollyCalls().length, 0);
  for (const lang of ['kn', 'ta', 'te']) assert.equal(config.pollyVoices[lang], undefined, lang);
  for (const c of H.polly.calls) assert.ok(['hi-IN', 'en-IN'].includes(c.LanguageCode));
});
