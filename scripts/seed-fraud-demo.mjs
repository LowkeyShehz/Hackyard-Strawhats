#!/usr/bin/env node
/**
 * Nirman Mitra — seed the fraud demo: check-ins the nightly Nodus sweep (nodus/sweep.py) must flag.
 *
 * Usage:
 *   node scripts/seed-fraud-demo.mjs           write the demo workers and check-ins to DynamoDB
 *   node scripts/seed-fraud-demo.mjs --clean   delete everything this script wrote
 *   node scripts/seed-fraud-demo.mjs --json    print the items instead of writing them
 *
 * Writes go through the app's data helpers, so DB_BACKEND picks the database:
 *   DB_BACKEND=postgres DATABASE_URL=<Render external URL> node scripts/seed-fraud-demo.mjs
 *   DB_BACKEND=dynamodb (with AWS credentials in the environment) for the Lambda stack
 * Tables are WORKERS_TABLE / ATTENDANCE_TABLE, defaulting to the -dev names.
 *
 * One scenario per detector in nodus/fraud_core.py, all inside the sweep's 14-day window:
 *   farm    4 workers in one 11 m cell within 45 s         -> detect_phone_farms         (4 logs)
 *   static  1 worker, identical GPS fix on 3 days          -> detect_static_gps          (3 logs)
 *   travel  1 worker, Surathkal then Bengaluru 80 min apart -> detect_impossible_travel  (the 2nd of 2 logs)
 *   face    2 workers with the same face embedding         -> detect_shared_faces        (2 logs)
 * Every check-in passed per-check-in verification (auto_approved): the point of the demo is that
 * the sweep catches what a single check-in cannot show. Seeded workers have DEMO-FRAUD- ids,
 * non-dialable 9100000000xx numbers and no next_reminder_time, so nothing is ever sent to them.
 */
import crypto from 'crypto';

const SEED_TAG = 'fraud-demo';

const SITES = {
  guwahati: { site_id: 'DEMO-IIT-GUWAHATI', site_name: '[DEMO] IIT Guwahati (Hackyard venue)', lat: 26.1878, lng: 91.6916 },
  bengaluru: { site_id: 'DEMO-BENGALURU-MG-ROAD', site_name: '[DEMO] Bengaluru MG Road site', lat: 12.9716, lng: 77.5946 },
  surathkal: { site_id: 'DEMO-SURATHKAL', site_name: '[DEMO] Surathkal site', lat: 13.0108, lng: 74.7943 },
};

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/** Deterministic PRNG so the face embeddings are the same on every run */
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

/** float32 -> IEEE half (bits); values here are normal-range, tiny ones flush to zero */
function toHalf(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  const x = view.getUint32(0);
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  if (exp <= 0) return sign;
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | ((x & 0x7fffff) >>> 13);
}

/** Same encoding as fraud_core.encode_vector: float16, little-endian, base64 */
function encodeVector(values) {
  const buf = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => buf.writeUInt16LE(toHalf(v), i * 2));
  return buf.toString('base64');
}

/** Same fields as fraudSignals.gpsFingerprint: the 4 dp cell and a keyed hash of the exact fix */
function gpsFingerprint(lat, lng) {
  const key = process.env.GPS_HASH_KEY || 'fraud-demo-seed';
  return {
    gps_cell: { lat: Math.round(lat * 1e4) / 1e4, lng: Math.round(lng * 1e4) / 1e4 },
    gps_hash: crypto.createHmac('sha256', key).update(`${lat},${lng}`).digest('hex'),
  };
}

/** IST calendar date `daysAgo` days back, and the instant hh:mm:ss IST on that date */
function istMoment(daysAgo, hh, mm, ss = 0) {
  const logDate = new Date(Date.now() + 5.5 * 3600e3 - daysAgo * 86400e3).toISOString().slice(0, 10);
  const pad = (n) => String(n).padStart(2, '0');
  const iso = new Date(`${logDate}T${pad(hh)}:${pad(mm)}:${pad(ss)}+05:30`).toISOString();
  return { logDate, iso, hour: hh };
}

// ─────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────

let phoneSeq = 0;
function worker(id, name, language, extra = {}) {
  phoneSeq += 1;
  return {
    worker_id: `DEMO-FRAUD-${id}`,
    phone_number: `9100000000${String(phoneSeq).padStart(2, '0')}`,
    name,
    preferred_language: language,
    profile_status: 'active',
    consent_given: true,
    total_days_logged: 0,
    created_at: new Date(Date.now() - 20 * 86400e3).toISOString(),
    demo_seed: SEED_TAG,
    ...extra,
  };
}

function checkin(w, site, moment, lat, lng, scenario) {
  w.total_days_logged += 1;
  return {
    worker_id: w.worker_id,
    log_date: moment.logDate,
    timestamp: moment.iso,
    created_at: moment.iso,
    site_id: site.site_id,
    site_name: site.site_name,
    verification_status: 'auto_approved',
    confidence: 88,
    face_confidence: 91,
    geo_confidence: 95,
    voice_confidence: 78,
    geo_location: { latitude: 'recorded', longitude: 'recorded', distance_meters: 60 },
    voice_details: { is_work_related: true, activity: 'plastering', location_mention: null },
    flagged_reason: null,
    is_off_hours: moment.hour < 6 || moment.hour >= 20,
    image_hash: null,
    fraud_signals: null,
    ...gpsFingerprint(lat, lng),
    demo_seed: SEED_TAG,
    demo_scenario: scenario,
  };
}

function buildDemo() {
  phoneSeq = 0;
  const workers = [];
  const logs = [];

  // Phone farm: one phone checks in four workers from the same spot, 15 s apart
  const g = SITES.guwahati;
  ['Ravi', 'Suresh', 'Manoj', 'Dilip'].forEach((name, i) => {
    const w = worker(`FARM-${i + 1}`, name, 'hi');
    workers.push(w);
    logs.push(checkin(w, g, istMoment(1, 9, 15, i * 15), g.lat + 0.00001 * i, g.lng + 0.00001 * i, 'farm'));
  });

  // Mock-location app: the exact same fix three mornings running
  const b = SITES.bengaluru;
  const stat = worker('STATIC-1', 'Lakshmi', 'kn');
  workers.push(stat);
  for (const daysAgo of [3, 2, 1]) {
    logs.push(checkin(stat, b, istMoment(daysAgo, 8, 50), b.lat + 0.00213, b.lng - 0.00117, 'static'));
  }

  // Impossible travel: Surathkal late at night, Bengaluru (about 290 km) 80 minutes later
  const s = SITES.surathkal;
  const trav = worker('TRAVEL-1', 'Anil', 'kn');
  workers.push(trav);
  logs.push(checkin(trav, s, istMoment(3, 23, 20), s.lat + 0.0004, s.lng + 0.0003, 'travel'));
  logs.push(checkin(trav, b, istMoment(2, 0, 40), b.lat - 0.0031, b.lng + 0.0024, 'travel'));

  // One person, two numbers: two workers whose enrolled faces are near-identical (cosine ~0.96)
  const rand = mulberry32(37);
  const face = Array.from({ length: 512 }, () => gaussian(rand));
  const twin = face.map((v) => v + 0.3 * gaussian(rand));
  const faceA = worker('FACE-1', 'Prakash', 'kn', { face_embedding: encodeVector(face) });
  const faceB = worker('FACE-2', 'Prakash K', 'kn', { face_embedding: encodeVector(twin) });
  workers.push(faceA, faceB);
  logs.push(checkin(faceA, s, istMoment(1, 10, 0), s.lat - 0.004, s.lng + 0.002, 'face'));
  logs.push(checkin(faceB, s, istMoment(1, 11, 30), s.lat + 0.006, s.lng - 0.003, 'face'));

  return { workers, logs };
}

// ─────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────

async function main() {
  const mode = process.argv[2] || '';
  const { workers, logs } = buildDemo();

  if (mode === '--json') {
    console.log(JSON.stringify({ workers, logs }, null, 2));
    return;
  }

  if (mode && mode !== '--clean') {
    console.error('Usage: node scripts/seed-fraud-demo.mjs [--clean | --json]');
    process.exit(1);
  }

  // Loaded only when writing, so --json works without any database configured
  const { default: config } = await import('../src/utils/config.js');
  if (config.dbBackend === 'memory') {
    console.error('Set DB_BACKEND (postgres or dynamodb): the in-memory demo store does not persist');
    process.exit(1);
  }
  const db = await import('../src/utils/dynamodb.js');
  const { workers: WORKERS_TABLE, attendance: ATTENDANCE_TABLE } = config.tables;
  console.log(`Backend ${config.dbBackend}; tables ${WORKERS_TABLE}, ${ATTENDANCE_TABLE}`);

  if (mode === '--clean') {
    let removed = 0;
    for (const w of workers) {
      for (const log of await db.getWorkerAttendanceLogs(w.worker_id)) {
        await db.deleteItem(ATTENDANCE_TABLE, { worker_id: log.worker_id, log_date: log.log_date });
        removed++;
      }
      await db.deleteItem(WORKERS_TABLE, { worker_id: w.worker_id });
    }
    console.log(`Removed ${workers.length} demo workers and ${removed} check-ins`);
    return;
  }

  for (const w of workers) await db.putItem(WORKERS_TABLE, w);
  for (const log of logs) await db.putItem(ATTENDANCE_TABLE, log);

  const byScenario = logs.reduce((acc, l) => ({ ...acc, [l.demo_scenario]: (acc[l.demo_scenario] || 0) + 1 }), {});
  console.log(`Seeded ${workers.length} workers and ${logs.length} check-ins:`, byScenario);
  console.log('Expected sweep result: 10 of these 11 check-ins flagged (not the first leg of the trip). Remove with --clean.');
}

await main();
if (process.env.DB_BACKEND === 'postgres') await (await import('../src/utils/postgres.js')).closePostgres();
