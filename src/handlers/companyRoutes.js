/**
 * Nirman Mitra — Company (employer) routes
 * Construction companies get VISIBILITY ONLY into attendance at their own sites: today's roster,
 * a 7-day trend, flagged check-ins and a muster-roll export. They can never approve, reject or
 * change a worker's days; those decisions stay with verification and the welfare board.
 *
 * Every query is scoped server-side by the company_id in the caller's access token.
 * Admins create company accounts and assign sites through /api/admin/companies and the site upsert.
 */

import { randomUUID } from 'crypto';
import config, { apiResponse, corsHeaders, istDate } from '../utils/config.js';
import { getItem, putItem, queryItems, scanTable } from '../utils/dynamodb.js';
import { hashPassword, getAdminByEmail, normalizeEmail } from '../middleware/auth.js';

const VERIFIED = new Set(['auto_approved', 'approved']);
const DAY_MS = 86400000;
const MAX_MUSTER_DAYS = 31;
const COMPANY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

class CompanyError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function maskPhone(phone) {
  return phone ? `****${String(phone).slice(-4)}` : '';
}

function parseJsonBody(event) {
  if (!event.body) return {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return JSON.parse(raw) || {};
  } catch {
    throw new CompanyError(400, 'Request body must be valid JSON');
  }
}

/** IST date `days` before `date` (YYYY-MM-DD) */
function shiftDate(date, days) {
  return istDate(Date.parse(`${date}T12:00:00+05:30`) - days * DAY_MS);
}

function dateParam(value, fallback, field) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new CompanyError(400, `${field} must be a date in YYYY-MM-DD format`);
  }
  return value;
}

// ─────────────────────────────────────────────────────────
// Data access
// ─────────────────────────────────────────────────────────

/** The company's sites (the Sites table is small; company_id is an optional attribute) */
async function companySites(companyId) {
  const sites = await scanTable(config.tables.sites);
  return sites.filter((s) => s.company_id === companyId);
}

/** Attendance logs at the given sites from `fromDate` to `toDate` inclusive (SiteLogsIndex) */
async function siteLogs(sites, fromDate, toDate) {
  const perSite = await Promise.all(sites.map((site) => queryItems(
    config.tables.attendance,
    'site_id = :sid',
    { ':sid': site.site_id },
    'SiteLogsIndex',
  )));
  return perSite.flat().filter((l) => l.log_date >= fromDate && l.log_date <= toDate);
}

/** worker_id → { name, phone (masked), totalDays } for the workers in `logs` */
async function workerLookup(logs) {
  const ids = [...new Set(logs.map((l) => l.worker_id))];
  const workers = await Promise.all(ids.map((id) => getItem(config.tables.workers, { worker_id: id })));
  return new Map(ids.map((id, i) => [id, {
    name: workers[i]?.name || 'Unknown worker',
    phone: maskPhone(workers[i]?.phone_number),
    totalDays: workers[i]?.total_days_logged || 0,
  }]));
}

function logRow(log, workers, siteNames) {
  const w = workers.get(log.worker_id) || {};
  return {
    worker_id: log.worker_id,
    worker_name: w.name,
    phone: w.phone,
    site_id: log.site_id,
    site_name: siteNames.get(log.site_id) || log.site_name || log.site_id,
    date: log.log_date,
    time: log.timestamp || log.created_at || null,
    status: log.verification_status,
    confidence: log.confidence ?? null,
    flag_reason: log.flagged_reason || null,
  };
}

// ─────────────────────────────────────────────────────────
// Company endpoints (role: company)
// ─────────────────────────────────────────────────────────

async function getOverview(companyId) {
  const sites = await companySites(companyId);
  const today = istDate();
  const logs = await siteLogs(sites, shiftDate(today, 29), today);
  const workers = await workerLookup(logs);
  const last7Start = shiftDate(today, 6);

  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const date = shiftDate(today, i);
    const dayLogs = logs.filter((l) => l.log_date === date);
    trend.push({
      date,
      day: new Date(`${date}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'Asia/Kolkata' }),
      checkins: dayLogs.length,
      verified: dayLogs.filter((l) => VERIFIED.has(l.verification_status)).length,
    });
  }

  const threshold = config.certificateThreshold;
  const workerStats = [...workers.values()];
  const todayLogs = logs.filter((l) => l.log_date === today);
  const week = logs.filter((l) => l.log_date >= last7Start);

  return apiResponse(200, {
    today,
    sites: sites.map((s) => ({ site_id: s.site_id, name: s.site_name || s.site_id, is_active: s.is_active === 'true' })),
    workersLast30Days: workers.size,
    checkinsToday: todayLogs.length,
    verifiedToday: todayLogs.filter((l) => VERIFIED.has(l.verification_status)).length,
    underReviewLast7Days: week.filter((l) => l.verification_status === 'pending_review').length,
    flaggedLast7Days: week.filter((l) => l.flagged_reason).length,
    welfare: {
      threshold,
      eligible: workerStats.filter((w) => w.totalDays >= threshold).length,
      closeToEligibility: workerStats.filter((w) => w.totalDays < threshold && w.totalDays >= Math.ceil(threshold * 0.8)).length,
    },
    trend,
  });
}

async function getRoster(companyId, params) {
  const date = dateParam(params.date, istDate(), 'date');
  const sites = await companySites(companyId);
  const siteNames = new Map(sites.map((s) => [s.site_id, s.site_name || s.site_id]));
  const logs = await siteLogs(sites, date, date);
  const workers = await workerLookup(logs);
  const rows = logs
    .map((l) => logRow(l, workers, siteNames))
    .sort((a, b) => a.site_name.localeCompare(b.site_name) || String(a.time).localeCompare(String(b.time)));
  return apiResponse(200, { date, sites: [...siteNames.entries()].map(([site_id, name]) => ({ site_id, name })), rows });
}

async function getFlags(companyId, params) {
  const days = Math.min(Math.max(parseInt(params.days || '7', 10) || 7, 1), 30);
  const today = istDate();
  const sites = await companySites(companyId);
  const siteNames = new Map(sites.map((s) => [s.site_id, s.site_name || s.site_id]));
  const logs = (await siteLogs(sites, shiftDate(today, days - 1), today)).filter((l) => l.flagged_reason);
  const workers = await workerLookup(logs);
  const rows = logs
    .map((l) => logRow(l, workers, siteNames))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.time).localeCompare(String(a.time)));
  return apiResponse(200, { days, rows });
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const MUSTER_CODE = { auto_approved: 'P', approved: 'P', pending_review: 'R', rejected: 'X' };

/** Muster roll CSV: one row per worker per site, one column per day (P present, R under review, X rejected) */
async function getMusterCsv(companyId, params) {
  const to = dateParam(params.to, istDate(), 'to');
  const from = dateParam(params.from, shiftDate(to, 6), 'from');
  if (from > to) throw new CompanyError(400, 'from must not be after to');
  const dates = [];
  for (let d = from; d <= to; d = shiftDate(d, -1)) {
    dates.push(d);
    if (dates.length > MAX_MUSTER_DAYS) throw new CompanyError(400, `A muster roll covers at most ${MAX_MUSTER_DAYS} days`);
  }

  const sites = await companySites(companyId);
  const siteNames = new Map(sites.map((s) => [s.site_id, s.site_name || s.site_id]));
  const logs = await siteLogs(sites, from, to);
  const workers = await workerLookup(logs);

  const byWorkerSite = new Map();
  for (const log of logs) {
    const key = `${log.worker_id}|${log.site_id}`;
    if (!byWorkerSite.has(key)) byWorkerSite.set(key, { worker_id: log.worker_id, site_id: log.site_id, days: {} });
    byWorkerSite.get(key).days[log.log_date] = MUSTER_CODE[log.verification_status] || '?';
  }

  const header = ['Worker', 'Phone', 'Site', ...dates, 'Days present'];
  const lines = [header.map(csvCell).join(',')];
  const entries = [...byWorkerSite.values()].sort((a, b) =>
    (siteNames.get(a.site_id) || '').localeCompare(siteNames.get(b.site_id) || '')
    || (workers.get(a.worker_id)?.name || '').localeCompare(workers.get(b.worker_id)?.name || ''));
  for (const e of entries) {
    const w = workers.get(e.worker_id) || {};
    const codes = dates.map((d) => e.days[d] || '-');
    lines.push([w.name, w.phone, siteNames.get(e.site_id) || e.site_id, ...codes, codes.filter((c) => c === 'P').length]
      .map(csvCell).join(','));
  }

  return {
    statusCode: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="muster-roll-${from}-to-${to}.csv"`,
    },
    body: `${lines.join('\n')}\n`,
  };
}

/**
 * Route /api/company/* for a caller whose token has role "company".
 * @returns {Promise<object|null>} API response, or null when the path is not a company route
 */
export async function handleCompanyRoute(caller, event, path, method) {
  if (!path.includes('/api/company/')) return null;
  if (method !== 'GET') return apiResponse(405, { error: 'Method not allowed' });
  if (!caller.company_id) return apiResponse(403, { error: 'Forbidden — no company on this account' });

  const params = event.queryStringParameters || {};
  try {
    if (path.endsWith('/api/company/overview')) return await getOverview(caller.company_id);
    if (path.endsWith('/api/company/roster')) return await getRoster(caller.company_id, params);
    if (path.endsWith('/api/company/flags')) return await getFlags(caller.company_id, params);
    if (path.endsWith('/api/company/muster.csv')) return await getMusterCsv(caller.company_id, params);
  } catch (err) {
    if (err instanceof CompanyError) return apiResponse(err.statusCode, { error: err.message });
    throw err;
  }
  return apiResponse(404, { error: 'Route not found' });
}

// ─────────────────────────────────────────────────────────
// Admin: company accounts (role: admin / super_admin)
// ─────────────────────────────────────────────────────────

async function listCompanies() {
  const [admins, sites] = await Promise.all([scanTable(config.tables.adminUsers), scanTable(config.tables.sites)]);
  const companies = admins
    .filter((a) => a.role === 'company' && a.company_id)
    .map((a) => ({
      company_id: a.company_id,
      name: a.company_name || a.name,
      email: a.email,
      site_ids: sites.filter((s) => s.company_id === a.company_id).map((s) => s.site_id),
      created_at: a.created_at || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return apiResponse(200, { companies });
}

async function createCompany(event) {
  const body = parseJsonBody(event);
  const name = typeof body.name === 'string' ? body.name.replace(/[<>]/g, '').trim().slice(0, 120) : '';
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!name) throw new CompanyError(400, 'name is required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CompanyError(400, 'A valid email is required');
  if (password.length < 10) throw new CompanyError(400, 'password must be at least 10 characters');
  if (await getAdminByEmail(email)) throw new CompanyError(409, 'An account with this email already exists');

  const companyId = `CO-${randomUUID().slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();
  await putItem(config.tables.adminUsers, {
    admin_id: randomUUID(),
    email,
    password_hash: await hashPassword(password),
    role: 'company',
    name,
    company_id: companyId,
    company_name: name,
    permissions: {},
    created_at: now,
    updated_at: now,
  });
  return apiResponse(201, { company: { company_id: companyId, name, email, site_ids: [] } });
}

/**
 * Route /api/admin/companies for admins.
 * @returns {Promise<object|null>} API response, or null when the path is not this route
 */
export async function handleAdminCompanyRoute(event, path, method) {
  if (!path.endsWith('/api/admin/companies')) return null;
  try {
    if (method === 'GET') return await listCompanies();
    if (method === 'POST') return await createCompany(event);
  } catch (err) {
    if (err instanceof CompanyError) return apiResponse(err.statusCode, { error: err.message });
    throw err;
  }
  return apiResponse(405, { error: 'Method not allowed' });
}

/** Validate an optional company_id for the site upsert ('' or null clears it) */
export function parseSiteCompanyId(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !COMPANY_ID_PATTERN.test(value)) {
    throw new CompanyError(400, 'company_id may contain only letters, digits, "-" and "_"');
  }
  return value;
}

export { CompanyError };
