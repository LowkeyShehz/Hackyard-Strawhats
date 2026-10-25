/**
 * Nirman Mitra — Dataset exports for Adaption Visualize
 * GET /api/admin/export/attendance.csv?days=30   one row per check-in
 * GET /api/admin/export/fraud.csv?days=30        one row per fraud signal
 *
 * Officers upload these to Adaption Visualize (adaptionlabs.ai), a hosted app that answers
 * questions about a table with charts. The files leave our systems, so they carry no personal
 * data: workers appear as a keyed pseudonym (stable within the deployment, not reversible
 * without the key), and there are no names, phone numbers, Aadhaar details or GPS positions.
 * Every export is written to the audit log.
 */

import crypto from 'crypto';
import config, { apiResponse, corsHeaders } from '../utils/config.js';
import { scanTable } from '../utils/dynamodb.js';
import { writeAudit } from '../services/audit.js';

const MAX_DAYS = 180;

const FRAUD_PATTERNS = [
  ['phone_farm', /other workers at the same spot/i],
  ['static_gps', /identical gps fix/i],
  ['impossible_travel', /impossible travel/i],
  ['shared_face', /face matches another worker/i],
  ['resent_selfie', /near-duplicate of selfie/i],
  ['screen_photo', /photo of a screen/i],
];

/** Pattern names for fraud signal texts; free text (which can name other workers) is never exported */
export function fraudPattern(text) {
  return FRAUD_PATTERNS.find(([, re]) => re.test(text))?.[0] || 'other';
}

/** Stable, non-reversible worker code, e.g. W-3f9a1c2e */
function pseudonym(workerId) {
  const key = config.jwt.secret || config.storage.urlSecret || 'nirman-export';
  return `W-${crypto.createHmac('sha256', key).update(`export:${workerId}`).digest('hex').slice(0, 8)}`;
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, rows) {
  return [header, ...rows.map((r) => header.map((h) => r[h]))].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

const IST_MS = 5.5 * 3600e3;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** IST hour and weekday of an ISO timestamp */
function istParts(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { hour: '', weekday: '' };
  const ist = new Date(t + IST_MS);
  return { hour: ist.getUTCHours(), weekday: WEEKDAYS[ist.getUTCDay()] };
}

/** Fraud signals on a log: sweep flags plus per-check-in Nodus flags in flagged_reason */
function fraudSignals(log) {
  const nodus = String(log.flagged_reason || '').split(' | ').filter((r) => r.startsWith('Nodus:'));
  return [...(log.fraud_flags || []), ...nodus];
}

async function recentLogs(days) {
  const since = new Date(Date.now() + IST_MS - days * 86400e3).toISOString().slice(0, 10);
  const [logs, workers] = await Promise.all([scanTable(config.tables.attendance), scanTable(config.tables.workers)]);
  const language = new Map(workers.map((w) => [w.worker_id, w.preferred_language || '']));
  return {
    since,
    language,
    logs: logs.filter((l) => String(l.log_date) >= since).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))),
  };
}

const ATTENDANCE_COLUMNS = [
  'date', 'weekday', 'hour_ist', 'site', 'worker', 'worker_language', 'status',
  'confidence', 'face_confidence', 'geo_confidence', 'voice_confidence', 'off_hours',
  'fraud_signal_count', 'fraud_patterns', 'reviewed',
];

const FRAUD_COLUMNS = ['date', 'weekday', 'hour_ist', 'site', 'worker', 'status', 'pattern', 'source'];

async function exportAttendance(days) {
  const { since, language, logs } = await recentLogs(days);
  const rows = logs.map((l) => {
    const { hour, weekday } = istParts(l.timestamp);
    const signals = fraudSignals(l);
    return {
      date: l.log_date,
      weekday,
      hour_ist: hour,
      site: l.site_name || l.site_id || '',
      worker: pseudonym(l.worker_id),
      worker_language: language.get(l.worker_id) || '',
      status: l.verification_status || '',
      confidence: l.confidence ?? '',
      face_confidence: l.face_confidence ?? '',
      geo_confidence: l.geo_confidence ?? '',
      voice_confidence: l.voice_confidence ?? '',
      off_hours: l.is_off_hours ? 'yes' : 'no',
      fraud_signal_count: signals.length,
      fraud_patterns: [...new Set(signals.map(fraudPattern))].join(';'),
      reviewed: l.reviewed_at ? 'yes' : 'no',
    };
  });
  return { since, rows, csv: toCsv(ATTENDANCE_COLUMNS, rows) };
}

async function exportFraud(days) {
  const { since, logs } = await recentLogs(days);
  const rows = [];
  for (const l of logs) {
    const { hour, weekday } = istParts(l.timestamp);
    const patterns = [
      ...(l.fraud_flags || []).map((f) => [fraudPattern(f), 'nightly_sweep']),
      ...fraudSignals(l).slice((l.fraud_flags || []).length).map((f) => [fraudPattern(f), 'check_in']),
    ];
    // One row per distinct pattern and source (a farm member can carry several farm reasons)
    for (const key of new Set(patterns.map((p) => p.join('|')))) {
      const [pattern, source] = key.split('|');
      rows.push({
        date: l.log_date, weekday, hour_ist: hour, site: l.site_name || l.site_id || '',
        worker: pseudonym(l.worker_id), status: l.verification_status || '', pattern, source,
      });
    }
  }
  return { since, rows, csv: toCsv(FRAUD_COLUMNS, rows) };
}

const DATASETS = { 'attendance.csv': exportAttendance, 'fraud.csv': exportFraud };

/** /api/admin/export/<dataset>.csv for admins; null when the path is not an export route */
export async function handleAdminExport(event, path, method, admin) {
  const name = path.split('/api/admin/export/')[1];
  if (name === undefined) return null;
  const build = DATASETS[name];
  if (!build) return apiResponse(404, { error: `Unknown export ${name}; use ${Object.keys(DATASETS).join(' or ')}` });
  if (method !== 'GET') return apiResponse(405, { error: 'Method not allowed' });

  const requested = parseInt(event.queryStringParameters?.days || '30', 10);
  const days = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_DAYS) : 30;
  const { since, rows, csv } = await build(days);

  await writeAudit({
    actor: `admin:${admin.admin_id}`,
    action: 'export.download',
    subject: `export#${name}`,
    details: { days, rows: rows.length, destination: 'adaption-visualize' },
  });

  return {
    statusCode: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="nirman-mitra-${name.replace('.csv', '')}-since-${since}.csv"`,
    },
    body: csv,
  };
}

export default { handleAdminExport, fraudPattern };
