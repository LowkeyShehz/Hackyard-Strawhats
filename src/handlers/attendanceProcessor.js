/**
 * Nirman Mitra — Attendance Processor Handler
 * Triple Verification(TM) — face + GPS + voice confidence routing.
 * Face, geo and voice checks run in parallel; results merge into confidence-based routing.
 *
 * Invoked by Step Functions with specific task types:
 *   - face_verify: Rekognition CompareFaces against enrolled face
 *   - geo_verify: GPS extraction from EXIF + geo-fence check against Sites table
 *   - voice_verify: LLM extracts work details from voice transcription
 *   - merge_decision: Combine all results + confidence routing + DynamoDB write
 */

import {
  RekognitionClient,
  CompareFacesCommand,
} from '@aws-sdk/client-rekognition';
import config, { isDemoMode, istDate } from '../utils/config.js';
import {
  getItem,
  queryItems,
  incrementDaysLogged,
  updateWorkerReminderState,
} from '../utils/dynamodb.js';
import { downloadFromS3, uploadToS3, enrolledSelfieKey } from '../utils/s3.js';
import { putItemIfAbsent } from '../services/conditionalWrite.js';
import { complete } from '../providers/llm.js';
import { withRetry } from '../utils/retryHelper.js';
import { languageName } from '../utils/i18n.js';

const rekognitionClient = new RekognitionClient({ region: config.aws.region });

/** Pre-migration location of the reference selfie (expires with the rest of workers/) */
const legacyEnrolledSelfieKey = (workerId) => `workers/${workerId}/selfie-latest.jpg`;

export const handler = async (event) => {
  console.log('AttendanceProcessor event:', JSON.stringify(event).substring(0, 500));

  const { task } = event;

  try {
    switch (task) {
      case 'face_verify':
        return await processFaceVerification(event);
      case 'geo_verify':
        return await processGeoVerification(event);
      case 'voice_verify':
        return await processVoiceVerification(event);
      case 'merge_decision':
        return await processMergeDecision(event);
      default:
        return { statusCode: 400, error: `Unknown task: ${task}` };
    }
  } catch (err) {
    console.error(`AttendanceProcessor error (${task}):`, err);
    return { statusCode: 500, error: err.message, task };
  }
};

// ---------------------------------------------------------
// Task: Face Verification (Rekognition CompareFaces)
// ---------------------------------------------------------

async function processFaceVerification(event) {
  const { workerId, selfieKey, bucket } = event;

  const worker = await getItem(config.tables.workers, { worker_id: workerId });
  if (!worker || !worker.face_vector) {
    // In dev mode, auto-pass face verification if no enrolled face
    if (isDemoMode()) {
      console.log('[AttendanceProcessor DEV] No enrolled face, auto-passing face verify');
      return { success: true, confidence: 85, faceMatch: true, details: { similarity: 85, qualityBrightness: 75, qualitySharpness: 80 } };
    }
    return { success: false, confidence: 0, reason: 'no_enrolled_face' };
  }

  if (isDemoMode()) {
    console.log('[AttendanceProcessor DEMO] Simulating face verification');
    return {
      success: true,
      confidence: 88,
      faceMatch: true,
      details: { similarity: 88, qualityBrightness: 75, qualitySharpness: 80 },
    };
  }

  // Download the check-in selfie
  const selfieBuffer = await downloadFromS3(
    bucket || config.buckets.mediaRaw,
    selfieKey,
  );

  // Compare against the enrolled reference selfie stored during registration; workers enrolled
  // before the enrolled/ prefix existed still have it at the legacy key
  let enrolledBuffer;
  try {
    enrolledBuffer = await downloadFromS3(config.buckets.mediaRaw, enrolledSelfieKey(workerId));
  } catch {
    try {
      enrolledBuffer = await downloadFromS3(config.buckets.mediaRaw, legacyEnrolledSelfieKey(workerId));
    } catch {
      return { success: false, confidence: 0, reason: 'enrolled_selfie_not_found' };
    }
    // The legacy key expires with the rest of workers/ media, so keep a permanent copy
    try {
      await uploadToS3(config.buckets.mediaRaw, enrolledSelfieKey(workerId), enrolledBuffer, 'image/jpeg', {
        worker_id: workerId,
        media_type: 'enrolled-selfie',
      });
    } catch (err) {
      console.warn('[AttendanceProcessor] Could not copy legacy enrolled selfie:', err.message);
    }
  }

  let compareResult;
  try {
    compareResult = await withRetry(
      () => rekognitionClient.send(
        new CompareFacesCommand({
          SourceImage: { Bytes: enrolledBuffer },
          TargetImage: { Bytes: selfieBuffer },
          // Return every match: similarity 30-59 must route to review, not look like "no match"
          SimilarityThreshold: 0,
          QualityFilter: 'AUTO',
        }),
      ),
      { label: 'Rekognition:CompareFaces' },
    );
  } catch (err) {
    // Rekognition rejects images in which it finds no face with InvalidParameterException
    if (err.name === 'InvalidParameterException') {
      return { success: false, confidence: 0, faceMatch: false, reason: 'no_face' };
    }
    throw err;
  }

  const match = compareResult.FaceMatches?.[0];
  if (!match) {
    return {
      success: false,
      confidence: 0,
      faceMatch: false,
      reason: 'no_face_match',
      unmatchedCount: compareResult.UnmatchedFaces?.length || 0,
    };
  }

  // Unrounded, so routing thresholds are compared exactly (59.5 is below 60)
  return {
    success: true,
    confidence: match.Similarity,
    faceMatch: true,
    details: {
      similarity: Math.round(match.Similarity),
      qualityBrightness: Math.round(match.Face?.Quality?.Brightness || 0),
      qualitySharpness: Math.round(match.Face?.Quality?.Sharpness || 0),
    },
  };
}

// ---------------------------------------------------------
// Task: Geo-Fence Verification (GPS + Site matching)
// ---------------------------------------------------------

async function processGeoVerification(event) {
  const { latitude, longitude } = event;

  if (!latitude || !longitude) {
    // In dev mode, auto-pass geo verification if no GPS data (WhatsApp strips EXIF)
    if (isDemoMode()) {
      console.log('[AttendanceProcessor DEV] No GPS data, auto-passing geo verify');
      return {
        success: true,
        confidence: 90,
        withinRadius: true,
        distance: 50,
        nearestSite: { site_id: 'DEV-SITE-001', name: 'Dev Construction Site', radius: 500 },
      };
    }
    return { success: false, confidence: 0, reason: 'no_gps_data', distance: null };
  }

  if (isDemoMode()) {
    // Demo: simulate GPS within range of a demo site
    console.log('[AttendanceProcessor DEMO] Simulating geo verification');
    return {
      success: true,
      confidence: 92,
      withinRadius: true,
      distance: 45,
      nearestSite: { site_id: 'DEMO-SITE-001', name: 'Demo Construction Site', radius: 500 },
    };
  }

  // Query active sites
  const sites = await queryItems(
    config.tables.sites,
    'is_active = :active',
    { ':active': 'true' },
    'ActiveSitesIndex',
  );

  if (sites.length === 0) {
    return { success: false, confidence: 0, reason: 'no_active_sites', distance: null };
  }

  // Pick the site with the smallest distance / radius ratio: a site whose fence contains the
  // point (ratio <= 1) always wins over a closer site whose smaller fence does not
  let nearestSite = null;
  let minDistance = Infinity;
  let minRatio = Infinity;

  for (const site of sites) {
    const siteLat = site.geo_location?.latitude;
    const siteLng = site.geo_location?.longitude;
    if (!siteLat || !siteLng) continue;

    const distance = haversineDistance(latitude, longitude, siteLat, siteLng);
    const ratio = distance / (site.radius_meters || 500);
    if (ratio < minRatio) {
      minRatio = ratio;
      minDistance = distance;
      nearestSite = site;
    }
  }

  if (!nearestSite) {
    return { success: false, confidence: 0, reason: 'no_sites_with_coordinates', distance: null };
  }

  const siteRadius = nearestSite.radius_meters || 500;
  const withinRadius = minDistance <= siteRadius;

  // Confidence based on distance: 100% at center, decreasing as you approach boundary.
  // Outside the fence stays below 60, so it can never auto-approve.
  let confidence;
  if (minDistance <= siteRadius * 0.5) {
    confidence = 95; // Well within
  } else if (minDistance <= siteRadius) {
    confidence = 80; // Within but near edge
  } else if (minDistance <= siteRadius * 1.2) {
    confidence = 50; // Slightly outside (review range)
  } else {
    confidence = 30; // Clearly outside
  }

  return {
    success: withinRadius,
    confidence,
    withinRadius,
    // Unrounded, so the 2x-radius rejection is compared exactly
    distance: minDistance,
    nearestSite: {
      site_id: nearestSite.site_id,
      name: nearestSite.site_name || nearestSite.site_id,
      radius: siteRadius,
    },
  };
}

// ---------------------------------------------------------
// Task: Voice Intent Verification (LLM)
// ---------------------------------------------------------

async function processVoiceVerification(event) {
  const { voiceTranscription, language, passcode } = event;

  if (!voiceTranscription || voiceTranscription.length < 3) {
    return { success: false, confidence: 0, reason: 'no_voice_data', workDetails: null };
  }

  if (isDemoMode()) {
    console.log('[AttendanceProcessor DEMO] Simulating voice verification');
    return {
      success: true,
      confidence: 85,
      workDetails: {
        activity: 'brick laying',
        location_mention: 'construction site',
        is_work_related: true,
      },
    };
  }

  const passcodeInstruction = passcode ? 
    `\n\nCRITICAL FRAUD CHECK: The worker was instructed to say the number "${passcode}". Check if this number or its word equivalent is present in the transcription (e.g. if the number is 42, look for "42", "forty two", "bealis", "forty-two", "beayalees").\n5. Did they say the passcode?` : '';

  const prompt = `You are analyzing a voice note from an Indian construction worker who is logging their daily attendance. The worker described their work in ${languageName(language)}.${passcodeInstruction}

Worker's voice transcription: "${voiceTranscription}"

Analyze this and determine:
1. Is this a genuine work-related check-in (not a fake/scripted message)?
2. What specific work activity did they describe?
3. Did they mention any location or site details?
4. Confidence score (0-100) that this is a legitimate work attendance check-in${passcode ? '\n5. Did they say the passcode?' : ''}

Respond in EXACTLY this JSON format (no markdown, no code blocks):
{"is_work_related": true/false, "activity": "brief description", "location_mention": "any location mentioned or null", "confidence": 0-100, "reasoning": "brief explanation"${passcode ? ', "passcode_match": true/false' : ''}}`;

  try {
    const response = await complete({ prompt, json: true, maxTokens: 200, cacheTtlSeconds: 86400 });
    const jsonStr = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result = JSON.parse(jsonStr);
    // The model sometimes answers "false" as a string, which Boolean() would read as true
    const isWorkRelated = result.is_work_related === true || String(result.is_work_related).toLowerCase() === 'true';
    let confidence = Math.min(100, Math.max(0, Number(result.confidence) || 0));
    
    // Passcode enforcement
    if (passcode) {
      const passcodeMatch = result.passcode_match === true || String(result.passcode_match).toLowerCase() === 'true';
      if (!passcodeMatch) {
        console.warn(`[Anti-Fraud] Passcode mismatch. Expected: ${passcode}, Transcription: ${voiceTranscription}`);
        confidence = 0;
        result.reasoning = `Failed passcode check (expected ${passcode}). ` + (result.reasoning || '');
      }
      result.passcode_mismatch = !passcodeMatch;
    }

    return {
      success: isWorkRelated,
      confidence: confidence,
      workDetails: {
        activity: String(result.activity || ''),
        location_mention: result.location_mention || null,
        is_work_related: isWorkRelated,
        passcode_mismatch: result.passcode_mismatch || false,
      },
    };
  } catch (err) {
    console.error('Voice verification failed:', err.message);
    // In dev mode, auto-pass voice verification on failure
    if (isDemoMode()) {
      console.log('[AttendanceProcessor DEV] Voice analysis failed, auto-passing');
      return { success: true, confidence: 80, workDetails: { activity: 'construction work', location_mention: 'site', is_work_related: true } };
    }
    return { success: false, confidence: 50, reason: 'voice_analysis_failed', workDetails: null };
  }
}

// ---------------------------------------------------------
// Task: Merge + Decision (Confidence Routing)
// Confidence Routing Rules
// ---------------------------------------------------------

async function processMergeDecision(event) {
  const { workerId, faceResult, geoResult, voiceResult } = event;

  const worker = await getItem(config.tables.workers, { worker_id: workerId });
  if (!worker) {
    return { statusCode: 404, error: 'Worker not found' };
  }

  // Attendance days are IST calendar days (UTC+5:30), as is off-hours detection
  const logDate = istDate();
  const timestamp = new Date().toISOString();
  const currentHour = new Date(Date.now() + 5.5 * 60 * 60 * 1000).getUTCHours();
  const threshold = config.certificateThreshold;

  const duplicate = (existingStatus) => {
    const days = worker.total_days_logged || 0;
    return {
      status: 'duplicate',
      message: 'Attendance already logged for today',
      existingStatus,
      totalDaysLogged: days,
      daysRemaining: Math.max(0, threshold - days),
      threshold,
    };
  };

  // Fast path for the common duplicate; the conditional write below is what actually
  // guarantees one log per day when two check-ins race
  const existingLog = await getItem(config.tables.attendance, {
    worker_id: workerId,
    log_date: logDate,
  });

  if (existingLog && existingLog.verification_status !== 'rejected') {
    return duplicate(existingLog.verification_status);
  }

  // Extract confidence scores (unrounded; rounded only when stored)
  const faceConfidence = faceResult?.confidence || 0;
  const geoConfidence = geoResult?.confidence || 0;
  const voiceConfidence = voiceResult?.confidence || 0;

  // Combined confidence: weighted average
  // Face: 40%, Geo: 35%, Voice: 25%
  const combinedConfidence = Math.round(
    faceConfidence * 0.4 + geoConfidence * 0.35 + voiceConfidence * 0.25,
  );

  // Determine verification status from the routing rules
  let verificationStatus;
  let flaggedReasons = [];

  // Face rules
  if (faceResult?.reason === 'no_face') {
    flaggedReasons.push('No face found in selfie');
  } else if (faceConfidence < 60) {
    flaggedReasons.push(`Low face confidence: ${Math.round(faceConfidence)}%`);
  } else if (faceConfidence < 80) {
    flaggedReasons.push(`Face confidence in review range: ${Math.round(faceConfidence)}%`);
  }

  // Anti-Fraud: Screen spoofing (Phase 3.2)
  const sharpness = faceResult?.details?.qualitySharpness;
  const brightness = faceResult?.details?.qualityBrightness;
  if (sharpness !== undefined && sharpness < 30) {
    flaggedReasons.push(`Low image sharpness (possible screen spoof): ${sharpness}`);
  }
  if (brightness !== undefined && (brightness < 20 || brightness > 90)) {
    flaggedReasons.push(`Abnormal brightness (possible glare/spoof): ${brightness}`);
  }

  // GPS rules
  const distance = geoResult?.distance ?? null;
  if (distance !== null) {
    const siteRadius = geoResult?.nearestSite?.radius || 500;
    if (distance > siteRadius) {
      flaggedReasons.push(`GPS outside radius: ${Math.round(distance)}m (limit: ${siteRadius}m)`);
    } else if (distance > siteRadius * 0.5) {
      flaggedReasons.push(`GPS near boundary: ${Math.round(distance)}m`);
    }
  } else if (!geoResult?.success) {
    flaggedReasons.push('No GPS data available');
  }

  // Voice rules: only a spoken note that describes work (and says the number) can auto-approve
  const voiceSource = event.voiceSource || 'audio';
  if (voiceSource === 'none') {
    flaggedReasons.push('Voice note skipped');
  } else if (voiceSource === 'text') {
    flaggedReasons.push('Typed text instead of a voice note');
  }
  if (voiceSource !== 'none' && !voiceResult?.workDetails?.is_work_related) {
    flaggedReasons.push('Voice note not work-related');
  } else if (voiceResult?.workDetails?.passcode_mismatch) {
    flaggedReasons.push('Passcode check failed');
  }
  const voiceVerified = voiceSource === 'audio'
    && voiceResult?.workDetails?.is_work_related === true
    && !voiceResult?.workDetails?.passcode_mismatch;

  // Off-hours check
  const isOffHours = currentHour < 6 || currentHour >= 20;
  if (isOffHours) {
    flaggedReasons.push('Off-hours submission');
  }

  // Apply confidence routing
  // Off-hours is a flag only — it does not block auto-approval if scores are high
  const hasHardFail = faceConfidence < 30 || (distance !== null && distance > (geoResult?.nearestSite?.radius || 500) * 2) || (voiceResult?.workDetails?.passcode_mismatch === true);

  if (hasHardFail) {
    verificationStatus = 'rejected';
  } else if (faceConfidence >= 60 && geoConfidence >= 60 && voiceVerified && !flaggedReasons.some(r => r.includes('spoof'))) {
    verificationStatus = 'auto_approved';
  } else {
    verificationStatus = 'pending_review';
  }

  // Write attendance log
  const attendanceLog = {
    worker_id: workerId,
    log_date: logDate,
    timestamp,
    site_id: geoResult?.nearestSite?.site_id || 'unknown',
    site_name: geoResult?.nearestSite?.name || 'Unknown Site',
    verification_status: verificationStatus,
    confidence: combinedConfidence,
    face_confidence: Math.round(faceConfidence),
    geo_confidence: Math.round(geoConfidence),
    voice_confidence: Math.round(voiceConfidence),
    geo_location: distance !== null
      ? { latitude: 'recorded', longitude: 'recorded', distance_meters: Math.round(distance) }
      : null,
    voice_details: voiceResult?.workDetails || null,
    flagged_reason: flaggedReasons.join(' | ') || null,
    is_off_hours: isOffHours,
    image_hash: event.imageHash || null,
    created_at: timestamp,
  };

  // Conditional write: only if there is no log for today yet (or only a rejected one), so two
  // concurrent check-ins cannot both be logged and both increment total_days_logged
  const written = await putItemIfAbsent(
    config.tables.attendance,
    attendanceLog,
    { worker_id: workerId, log_date: logDate },
    { replaceIf: { attr: 'verification_status', value: 'rejected' } },
  );
  if (!written) {
    return duplicate('logged_concurrently');
  }

  // Update check-in date and set up next reminder (tomorrow at 18:00 IST / 12:30 UTC)
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(12, 30, 0, 0);
  await updateWorkerReminderState(workerId, logDate, tomorrow.toISOString());

  // If auto-approved, increment the worker's total days
  let totalDaysLogged = worker.total_days_logged || 0;
  if (verificationStatus === 'auto_approved') {
    const updated = await incrementDaysLogged(workerId);
    totalDaysLogged = updated?.total_days_logged || totalDaysLogged + 1;
  }

  const daysRemaining = Math.max(0, threshold - totalDaysLogged);

  return {
    status: verificationStatus,
    confidence: combinedConfidence,
    faceConfidence: Math.round(faceConfidence),
    geoConfidence: Math.round(geoConfidence),
    voiceConfidence: Math.round(voiceConfidence),
    flaggedReasons,
    logDate,
    totalDaysLogged,
    daysRemaining,
    threshold,
    isOffHours,
    certificateEligible: totalDaysLogged >= threshold,
  };
}

// ---------------------------------------------------------
// Haversine Distance (meters)
// ---------------------------------------------------------

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

export default { handler };
