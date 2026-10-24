/**
 * Nirman Mitra — S3 Utility
 * Upload/download helpers with SSE-S3 (AES256) encryption + pre-signed URL generation.
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config, { isDemoMode } from './config.js';

const IS_DEMO = isDemoMode();
const s3Client = IS_DEMO ? null : new S3Client({ region: config.aws.region });

// In-memory S3 mock for demo/local testing
const memS3 = new Map();


/**
 * Upload a file to S3 with SSE-S3 (AES256) encryption
 * @param {string} bucket - Bucket name
 * @param {string} key - Object key (path)
 * @param {Buffer|Uint8Array|string} body - File content
 * @param {string} contentType - MIME type
 * @param {object} [metadata] - Optional metadata key-value pairs
 */
export async function uploadToS3(bucket, key, body, contentType, metadata = {}) {
  if (IS_DEMO) {
    const s3Key = `${bucket}/${key}`;
    memS3.set(s3Key, { body, contentType, metadata });
    console.log(`[MockS3] PUT ${s3Key} (${typeof body === 'object' ? body.length + ' bytes' : 'string'})`);
    return { bucket, key, url: `s3://${bucket}/${key}` };
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
 * Download a file from S3
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
 * Delete a file from S3 (e.g. an identity document image once OCR is done)
 * @param {string} bucket
 * @param {string} key
 */
export async function deleteFromS3(bucket, key) {
  if (IS_DEMO) {
    memS3.delete(`${bucket}/${key}`);
    console.log(`[MockS3] DELETE ${bucket}/${key}`);
    return;
  }
  await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Generate a pre-signed URL for downloading an S3 object
 * @param {string} bucket
 * @param {string} key
 * @param {number} [expiresIn=3600] - URL expiry in seconds (default 1 hour)
 * @returns {Promise<string>} Pre-signed URL
 */
export async function generatePresignedUrl(bucket, key, expiresIn = 3600) {
  if (IS_DEMO) {
    const demoUrl = `https://demo-presigned.s3.amazonaws.com/${bucket}/${key}?expires=${expiresIn}`;
    console.log(`[MockS3] Presign ${bucket}/${key}`);
    return demoUrl;
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
 * S3 key (media-raw bucket) of a worker's enrolled reference selfie, used for 1:1 face matching
 * at every check-in. The enrolled/ prefix is kept out of the 90-day raw-media expiry rule.
 * @param {string} workerId
 */
export function enrolledSelfieKey(workerId) {
  return `enrolled/${workerId}/selfie.jpg`;
}

/**
 * Upload processed audio (Polly TTS output) to processed bucket
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
};
