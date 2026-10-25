/**
 * Nirman Mitra — Fraud Signals (Nodus Compute)
 * Sends each check-in selfie to the Nodus `analyze_selfie` function (through the bridge in
 * nodus/bridge.py) for near-duplicate, recapture and face-embedding checks, and keeps the
 * worker's recent selfie fingerprints for the next comparison.
 *
 * Fraud signals only ever add review flags. When the service is unconfigured, slow or down the
 * check-in proceeds on the triple verification alone.
 */

import { createHmac } from 'crypto';
import config, { istDate } from '../utils/config.js';
import { getItem, updateItem } from '../utils/dynamodb.js';

const HISTORY_LIMIT = 30;

/** Whether the Nodus fraud service is configured */
export function fraudServiceEnabled() {
  return Boolean(config.fraud.serviceUrl && config.fraud.serviceToken);
}

/**
 * Analyse a check-in selfie on Nodus.
 * @param {string} workerId
 * @param {Buffer} selfieBuffer
 * @returns {Promise<{analyzed: boolean, flags: string[], recaptureScore?: number,
 *   nearDuplicateOf?: string|null, error?: string}>}
 */
export async function analyzeSelfie(workerId, selfieBuffer) {
  if (!fraudServiceEnabled()) return { analyzed: false, flags: [] };

  try {
    const worker = await getItem(config.tables.workers, { worker_id: workerId });
    const history = (worker?.selfie_history || []).slice(-HISTORY_LIMIT);

    const res = await fetch(`${config.fraud.serviceUrl}/analyze-selfie`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.fraud.serviceToken}`,
      },
      body: JSON.stringify({ image_b64: selfieBuffer.toString('base64'), history }),
      signal: AbortSignal.timeout(config.fraud.timeoutMs),
    });
    if (!res.ok) throw new Error(`fraud service HTTP ${res.status}`);
    const result = await res.json();

    await rememberSelfie(workerId, worker, history, result);

    return {
      analyzed: true,
      flags: Array.isArray(result.flags) ? result.flags.map(String) : [],
      recaptureScore: typeof result.recapture_score === 'number' ? result.recapture_score : undefined,
      nearDuplicateOf: result.near_duplicate?.date || null,
      backend: result.backend === 'nodus' ? 'nodus' : 'local',
    };
  } catch (err) {
    console.warn('[Fraud] Selfie analysis skipped:', err.message);
    return { analyzed: false, flags: [], error: err.message };
  }
}

/** Append this selfie's fingerprint to the worker's history; keep the first face embedding */
async function rememberSelfie(workerId, worker, history, result) {
  if (!result.phash) return;
  const entry = { date: istDate(), phash: String(result.phash) };
  if (result.embedding) entry.embedding = String(result.embedding);
  const nextHistory = [...history, entry].slice(-HISTORY_LIMIT);

  const sets = ['selfie_history = :h'];
  const values = { ':h': nextHistory };
  if (result.face_embedding && !worker?.face_embedding) {
    sets.push('face_embedding = :f');
    values[':f'] = String(result.face_embedding);
  }
  await updateItem(config.tables.workers, { worker_id: workerId }, `SET ${sets.join(', ')}`, values)
    .catch((err) => console.warn('[Fraud] Could not save selfie fingerprint:', err.message));
}

/**
 * Privacy-preserving GPS fields for the nightly Nodus sweep: a ~11 m cell for proximity checks
 * and a keyed hash of the exact fix, so repeated identical fixes (mock-location apps) can be
 * detected without storing the coordinates.
 * @returns {{gps_cell: {lat: number, lng: number}, gps_hash: string} | null}
 */
export function gpsFingerprint(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !config.fraud.gpsHashKey) return null;
  return {
    gps_cell: { lat: Math.round(lat * 1e4) / 1e4, lng: Math.round(lng * 1e4) / 1e4 },
    gps_hash: createHmac('sha256', config.fraud.gpsHashKey).update(`${latitude},${longitude}`).digest('hex'),
  };
}

export default { fraudServiceEnabled, analyzeSelfie, gpsFingerprint };
