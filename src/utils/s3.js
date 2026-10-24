/**
 * Nirman Mitra — File storage
 * Upload/download helpers and expiring download links. config.storageBackend picks the store:
 *   's3'     S3 with SSE-S3 (AES256) encryption and pre-signed URLs
 *   'disk'   a folder per bucket under STORAGE_DIR (the Render disk); links are signed, expiring
 *            /files/<bucket>/<key> URLs served by src/server.js
 *   'memory' an in-memory map for local demo runs
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from './config.js';

const BACKEND = config.storageBackend;
if (!['s3', 'disk', 'memory'].includes(BACKEND)) {
  throw new Error(`Unknown STORAGE_BACKEND "${BACKEND}" (use s3, disk or memory)`);
}
const IS_DEMO = BACKEND === 'memory';
const IS_DISK = BACKEND === 'disk';
const s3Client = BACKEND === 's3' ? new S3Client({ region: config.aws.region }) : null;

// In-memory S3 mock for demo/local testing
const memS3 = new Map();

// ─────────────────────────────────────────────────────────
// Disk backend
// ─────────────────────────────────────────────────────────

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.json': 'application/json',
};

/** Content type of a stored file, from its extension */
export function contentTypeFor(key) {
  return CONTENT_TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream';
}

/** Absolute path of bucket/key under STORAGE_DIR; rejects anything that would escape it */
export function diskPath(bucket, key) {
  const root = path.resolve(config.storage.dir);
  const segments = [bucket, ...String(key).split('/')];
  if (segments.some((s) => !s || s === '.' || s === '..' || s.includes('\\') || s.includes('\0'))) {
    throw Object.assign(new Error(`Invalid storage path ${bucket}/${key}`), { name: 'InvalidPath' });
  }
  const full = path.resolve(root, ...segments);
  if (!full.startsWith(root + path.sep)) throw Object.assign(new Error('Invalid storage path'), { name: 'InvalidPath' });
  return full;
}

function notFound(bucket, key) {
  return Object.assign(new Error(`NoSuchKey: ${bucket}/${key}`), { name: 'NoSuchKey' });
}

function linkSignature(bucket, key, expires) {
  if (!config.storage.urlSecret) throw new Error('FILE_URL_SECRET is not set; cannot sign file links');
  return crypto.createHmac('sha256', config.storage.urlSecret).update(`${bucket}/${key}\n${expires}`).digest('base64url');
}

/** True when a /files/ link's signature is valid and it has not expired */
export function verifyFileLink(bucket, key, expires, signature) {
  const exp = Number(expires);
  if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000) || typeof signature !== 'string') return false;
  const expected = Buffer.from(linkSignature(bucket, key, exp));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Read a stored file for the /files/ route; null when it does not exist */
export async function readStoredFile(bucket, key) {
  try {
    return await fs.readFile(diskPath(bucket, key));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Delete raw worker media older than maxAgeDays: the S3 lifecycle rule (workers/ prefix in the
 * raw media bucket, 90 days) applied to the disk backend. Enrolled selfies live under enrolled/.
 * @returns {Promise<number>} files deleted
 */
export async function pruneOldMedia(maxAgeDays = 90) {
  if (!IS_DISK) return 0;
  const cutoff = Date.now() - maxAgeDays * 86400e3;
  let removed = 0;
  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if ((await fs.stat(full)).mtimeMs < cutoff) {
        await fs.rm(full, { force: true });
        removed++;
      }
    }
  };
  await walk(path.join(path.resolve(config.storage.dir), config.buckets.mediaRaw, 'workers'));
  return removed;
}

// ─────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────

/**
 * Upload a file (S3: with SSE-S3 AES256 encryption)
 * @param {string} bucket - Bucket name
 * @param {string} key - Object key (path)
 * @param {Buffer|Uint8Array|string} body - File content
 * @param {string} contentType - MIME type
 * @param {object} [metadata] - Optional metadata key-value pairs (S3 only)
 */
export async function uploadToS3(bucket, key, body, contentType, metadata = {}) {
  if (IS_DEMO) {
    const s3Key = `${bucket}/${key}`;
    memS3.set(s3Key, { body, contentType, metadata });
    console.log(`[MockS3] PUT ${s3Key} (${typeof body === 'object' ? body.length + ' bytes' : 'string'})`);
    return { bucket, key, url: `s3://${bucket}/${key}` };
  }

  if (IS_DISK) {
    const file = diskPath(bucket, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write then rename, so a reader never sees a half-written file
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, file);
    return { bucket, key, url: `disk://${bucket}/${key}` };
  }

  const params = {
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    ServerSideEncryption: 'AES256',
    Metadata: metadata,
  };

  await s3Client.send(new PutObjectCommand(params));

  return {
    bucket,
    key,
    url: `s3://${bucket}/${key}`,
  };
}

/**
 * Download a file
 * @param {string} bucket
 * @param {string} key
 * @returns {Promise<Buffer>} File content as Buffer
 */
export async function downloadFromS3(bucket, key) {
  if (IS_DEMO) {
    const s3Key = `${bucket}/${key}`;
    const item = memS3.get(s3Key);
    console.log(`[MockS3] GET ${s3Key} ->`, item ? 'found' : 'null');
    return item ? item.body : Buffer.from('demo-placeholder');
  }

  if (IS_DISK) {
    const file = await readStoredFile(bucket, key);
    if (!file) throw notFound(bucket, key);
    return file;
  }

  const result = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  // Convert stream to buffer
  const chunks = [];
  for await (const chunk of result.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Delete a file (e.g. an identity document image once OCR is done)
 * @param {string} bucket
 * @param {string} key
 */
export async function deleteFromS3(bucket, key) {
  if (IS_DEMO) {
    memS3.delete(`${bucket}/${key}`);
    console.log(`[MockS3] DELETE ${bucket}/${key}`);
    return;
  }
  if (IS_DISK) {
    await fs.rm(diskPath(bucket, key), { force: true });
    return;
  }
  await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Generate an expiring download link (S3 pre-signed URL, or a signed /files/ link on disk)
 * @param {string} bucket
 * @param {string} key
 * @param {number} [expiresIn=3600] - URL expiry in seconds (default 1 hour)
 * @returns {Promise<string>} Download URL
 */
export async function generatePresignedUrl(bucket, key, expiresIn = 3600) {
  if (IS_DEMO) {
    const demoUrl = `https://demo-presigned.s3.amazonaws.com/${bucket}/${key}?expires=${expiresIn}`;
    console.log(`[MockS3] Presign ${bucket}/${key}`);
    return demoUrl;
  }
  if (IS_DISK) {
    diskPath(bucket, key);
    const expires = Math.floor(Date.now() / 1000) + expiresIn;
    const encodedKey = String(key).split('/').map(encodeURIComponent).join('/');
    const sig = linkSignature(bucket, key, expires);
    return `${config.storage.publicBaseUrl}/files/${encodeURIComponent(bucket)}/${encodedKey}?exp=${expires}&sig=${sig}`;
  }
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(s3Client, command, { expiresIn });
}

/**
 * Upload worker media (selfie, document photo) to raw bucket
 * @param {string} workerId
 * @param {string} mediaType - 'aadhaar', 'selfie', 'passbook', 'audio'
 * @param {Buffer} buffer
 * @param {string} contentType
 */
export async function uploadWorkerMedia(workerId, mediaType, buffer, contentType) {
  const timestamp = Date.now();
  const ext = contentType.includes('image') ? 'jpg' : contentType.includes('audio') ? 'ogg' : 'bin';
  const key = `workers/${workerId}/${mediaType}-${timestamp}.${ext}`;

  return uploadToS3(config.buckets.mediaRaw, key, buffer, contentType, {
    worker_id: workerId,
    media_type: mediaType,
  });
}

/**
 * Key (media-raw bucket) of a worker's enrolled reference selfie, used for 1:1 face matching
 * at every check-in. The enrolled/ prefix is kept out of the 90-day raw-media expiry rule.
 * @param {string} workerId
 */
export function enrolledSelfieKey(workerId) {
  return `enrolled/${workerId}/selfie.jpg`;
}

/**
 * Upload processed audio (TTS output) to processed bucket
 * @param {string} workerId
 * @param {string} label - e.g. 'greeting', 'confirmation'
 * @param {Buffer} audioBuffer
 */
export async function uploadProcessedAudio(workerId, label, audioBuffer) {
  const timestamp = Date.now();
  const key = `audio/${workerId}/${label}-${timestamp}.mp3`;

  return uploadToS3(config.buckets.mediaProcessed, key, audioBuffer, 'audio/mpeg', {
    worker_id: workerId,
    audio_type: label,
  });
}

export default {
  uploadToS3,
  downloadFromS3,
  deleteFromS3,
  generatePresignedUrl,
  uploadWorkerMedia,
  uploadProcessedAudio,
  enrolledSelfieKey,
  contentTypeFor,
  diskPath,
  verifyFileLink,
  readStoredFile,
  pruneOldMedia,
};
