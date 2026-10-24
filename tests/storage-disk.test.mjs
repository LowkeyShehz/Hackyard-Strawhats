// Disk storage (STORAGE_BACKEND=disk): files under STORAGE_DIR, served by src/server.js behind
// signed, expiring /files/ links that stand in for S3 pre-signed URLs.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nm-files-'));
Object.assign(process.env, { STORAGE_BACKEND: 'disk', STORAGE_DIR: dir, FILE_URL_SECRET: 'test-file-secret' });

const H = await import('./helpers/harness.mjs');
const storage = await import('../src/utils/s3.js');
const { createServer } = await import('../src/server.js');
const { default: config } = await import('../src/utils/config.js');

let server;
let base;

before(async () => {
  H.quiet();
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  H.close();
  await fs.rm(dir, { recursive: true, force: true });
});

/** A signed link, pointed at the test server instead of PUBLIC_BASE_URL */
async function link(bucket, key, expiresIn) {
  const url = new URL(await storage.generatePresignedUrl(bucket, key, expiresIn));
  return `${base}${url.pathname}${url.search}`;
}

test('upload, download and delete round-trip on disk', async () => {
  const body = Buffer.from('%PDF-1.4 certificate');
  await storage.uploadToS3('certs', 'certificates/W1/C1.pdf', body, 'application/pdf');
  assert.deepEqual(await storage.downloadFromS3('certs', 'certificates/W1/C1.pdf'), body);
  await fs.access(path.join(dir, 'certs', 'certificates', 'W1', 'C1.pdf'));

  await storage.deleteFromS3('certs', 'certificates/W1/C1.pdf');
  await assert.rejects(storage.downloadFromS3('certs', 'certificates/W1/C1.pdf'), { name: 'NoSuchKey' });
});

test('keys that would escape the storage folder are rejected', async () => {
  for (const [bucket, key] of [['raw', '../escape.txt'], ['..', 'x'], ['raw', 'a//b'], ['raw', 'a\\..\\b']]) {
    await assert.rejects(storage.uploadToS3(bucket, key, 'x', 'text/plain'), { name: 'InvalidPath' }, `${bucket}/${key}`);
  }
});

test('signed links serve the file with its content type; tampered or expired links do not', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  await storage.uploadToS3('certs', 'certificates/W2/C2-qr.png', png, 'image/png');

  const good = await link('certs', 'certificates/W2/C2-qr.png', 900);
  assert.ok(good.includes('/files/certs/certificates/W2/C2-qr.png?exp='));
  const res = await fetch(good);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);

  const tampered = good.replace(/sig=./, (m) => (m.endsWith('A') ? 'sig=B' : 'sig=A'));
  assert.equal((await fetch(tampered)).status, 403);
  assert.equal((await fetch(good.replace('C2-qr.png', 'C3-qr.png'))).status, 403, 'a signature is only valid for its own key');
  assert.equal((await fetch(await link('certs', 'certificates/W2/C2-qr.png', -5))).status, 403, 'expired');
  assert.equal((await fetch(`${base}/files/certs/certificates/W2/C2-qr.png`)).status, 403, 'unsigned');
});

test('links use the public base URL', async () => {
  const url = await storage.generatePresignedUrl('certs', 'a b/c.pdf', 60);
  assert.ok(url.startsWith(`${config.storage.publicBaseUrl}/files/certs/a%20b/c.pdf?exp=`));
});

test('raw worker media older than 90 days is pruned; enrolled selfies are kept', async () => {
  const raw = config.buckets.mediaRaw;
  await storage.uploadToS3(raw, 'workers/W3/selfie-old.jpg', 'old', 'image/jpeg');
  await storage.uploadToS3(raw, 'workers/W3/selfie-new.jpg', 'new', 'image/jpeg');
  await storage.uploadToS3(raw, 'enrolled/W3/selfie.jpg', 'enrolled', 'image/jpeg');
  const longAgo = new Date(Date.now() - 100 * 86400e3);
  for (const key of ['workers/W3/selfie-old.jpg', 'enrolled/W3/selfie.jpg']) {
    await fs.utimes(storage.diskPath(raw, key), longAgo, longAgo);
  }

  assert.equal(await storage.pruneOldMedia(90), 1);
  await assert.rejects(storage.downloadFromS3(raw, 'workers/W3/selfie-old.jpg'), { name: 'NoSuchKey' });
  assert.equal(String(await storage.downloadFromS3(raw, 'workers/W3/selfie-new.jpg')), 'new');
  assert.equal(String(await storage.downloadFromS3(raw, 'enrolled/W3/selfie.jpg')), 'enrolled');
});
