/**
 * Nirman Mitra — Face Provider
 * Face enrolment and 1:1 matching through the face + fraud bridge (nodus/bridge.py): OpenCV SFace
 * on the bridge's CPU today, the same model on Nodus Compute once NODUS_API_KEY is set there.
 * Amazon Rekognition remains available with FACE_PROVIDER=rekognition.
 *
 * Provider (FACE_PROVIDER, see config.face.provider):
 *   bridge       SFace via FRAUD_SERVICE_URL (default when the bridge is configured)
 *   rekognition  Amazon Rekognition (default when only AWS credentials are present)
 *   none         no face model: check-ins go to officer review with the selfies side by side
 */

import config from '../utils/config.js';

const TIMEOUT_MS = 8000;

/** The active face provider */
export function faceProvider() {
  return config.face.provider;
}

async function post(path, body) {
  const res = await fetch(`${config.fraud.serviceUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.fraud.serviceToken}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`face service HTTP ${res.status}`);
  return res.json();
}

/**
 * Embed the enrolment selfie.
 * @param {Buffer} imageBuffer
 * @returns {Promise<{ok: true, embedding: string, quality: object} |
 *   {ok: false, problem: 'no_face'|'multiple_faces'|'low_quality'}>} embedding is base64 float16
 */
export async function enrollFace(imageBuffer) {
  const result = await post('/face-embed', { image_b64: imageBuffer.toString('base64') });
  if (result.problem) return { ok: false, problem: result.problem };
  if (!result.embedding_b64) return { ok: false, problem: 'no_face' };
  return { ok: true, embedding: result.embedding_b64, quality: result.quality || null };
}

/**
 * Compare a check-in selfie with the enrolled embedding.
 * @param {string} enrolledEmbedding - base64 float16 from enrollFace
 * @param {Buffer} imageBuffer
 * @returns {Promise<{faceFound: boolean, similarity: number, faces: number, quality: object|null,
 *   backend: string}>} similarity is 0-100 on the Rekognition-like scale the routing expects
 */
export async function matchFace(enrolledEmbedding, imageBuffer) {
  const result = await post('/face-match', {
    image_b64: imageBuffer.toString('base64'),
    enrolled_embedding: enrolledEmbedding,
  });
  return {
    faceFound: Boolean(result.face_found),
    similarity: Number(result.similarity) || 0,
    faces: result.faces || 0,
    quality: result.quality || null,
    backend: result.backend || 'local',
  };
}

export default { faceProvider, enrollFace, matchFace };
