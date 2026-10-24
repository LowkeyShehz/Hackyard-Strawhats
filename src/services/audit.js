/**
 * Nirman Mitra — Audit Log
 * Append-only record of who did what to whom: officer views and decisions on credentials,
 * admin views of worker profiles and review decisions, and worker consent. Entries are only
 * ever inserted (conditional put), and the Lambda roles are granted PutItem/Query/GetItem on
 * the table but not UpdateItem or DeleteItem, so the log cannot be rewritten.
 *
 * Key: subject (e.g. "credential#<jti>", "worker#<id>") + entry_id ("<ISO time>#<uuid>"),
 * so one subject's history reads back in time order.
 */

import { randomUUID } from 'crypto';
import config from '../utils/config.js';
import { putItem, queryItems } from '../utils/dynamodb.js';

/**
 * Append one audit entry.
 * @param {object} entry
 * @param {string} entry.actor - Who acted, e.g. "admin:<id>", "worker:<id>"
 * @param {string} entry.action - What happened, e.g. "credential.view", "credential.decision"
 * @param {string} entry.subject - What it happened to, e.g. "credential#<jti>"
 * @param {string} [entry.outcome] - Result, e.g. "ok", "approve", "reject", "denied"
 * @param {object} [entry.details] - Extra non-sensitive context (never Aadhaar or phone numbers)
 * @returns {Promise<object>} The stored entry
 */
export async function writeAudit({ actor, action, subject, outcome = 'ok', details }) {
  const at = new Date().toISOString();
  const item = {
    subject,
    entry_id: `${at}#${randomUUID()}`,
    actor,
    action,
    outcome,
    at,
    ...(details && { details }),
  };
  await putItem(config.tables.audit, item, 'attribute_not_exists(entry_id)');
  return item;
}

/** All audit entries for one subject, oldest first */
export async function listAudit(subject) {
  return queryItems(config.tables.audit, 'subject = :s', { ':s': subject });
}

/** Audit subject for a signed credential */
export const credentialSubject = (jti) => `credential#${jti}`;

/** Audit subject for a worker */
export const workerSubject = (workerId) => `worker#${workerId}`;

export default { writeAudit, listAudit, credentialSubject, workerSubject };
