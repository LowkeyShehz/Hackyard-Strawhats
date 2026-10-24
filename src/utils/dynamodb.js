/**
 * Nirman Mitra — DynamoDB Utility
 * DocumentClient wrapper with CRUD helpers for all 6 tables.
 *
 * In demo/dev mode (ENVIRONMENT=dev), all calls are intercepted by an
 * in-memory store so no real AWS credentials or DynamoDB are required.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import config from './config.js';

// ─────────────────────────────────────────────────────────
// In-Memory Mock Store (demo / local testing only)
// ─────────────────────────────────────────────────────────

const IS_DEMO = !process.env.AWS_LAMBDA_FUNCTION_NAME && (process.env.ENVIRONMENT || 'dev') === 'dev';

// Map<tableName, Map<compositeKey, item>>
const memStore = new Map();

function memKey(key) {
  return Object.values(key).join('#');
}

function tableStore(tableName) {
  if (!memStore.has(tableName)) memStore.set(tableName, new Map());
  return memStore.get(tableName);
}

/**
 * Evaluate the simple condition expressions this codebase uses against an in-memory item:
 * attribute_exists(a), attribute_not_exists(a), a = :v and a <> :v, joined by AND or OR.
 */
function mockConditionHolds(item, expression, values = {}, names = {}) {
  const attr = (token) => item?.[names[token] ?? token];
  const clause = (text) => {
    const c = text.trim();
    let m;
    if ((m = c.match(/^attribute_not_exists\(\s*(\S+?)\s*\)$/i))) return attr(m[1]) === undefined;
    if ((m = c.match(/^attribute_exists\(\s*(\S+?)\s*\)$/i))) return attr(m[1]) !== undefined;
    if ((m = c.match(/^(\S+)\s*<>\s*(:\w+)$/))) return attr(m[1]) !== values[m[2]];
    if ((m = c.match(/^(\S+)\s*=\s*(:\w+)$/))) return attr(m[1]) === values[m[2]];
    throw new Error(`[MockDB] Unsupported condition: ${c}`);
  };
  return expression.split(/\s+OR\s+/i).some((any) => any.split(/\s+AND\s+/i).every(clause));
}

function conditionalCheckFailed() {
  return Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
}

const mockDb = {
  async putItem(tableName, item, conditionExpression, expressionValues, expressionNames) {
    // Derive primary key from item (first one or two defined key fields)
    const store = tableStore(tableName);
    const key = memKey(item.worker_id !== undefined
      ? (item.session_id !== undefined
          ? { worker_id: item.worker_id, session_id: item.session_id }
          : item.log_date !== undefined
            ? { worker_id: item.worker_id, log_date: item.log_date }
            : item.certificate_id !== undefined
              ? { worker_id: item.worker_id, certificate_id: item.certificate_id }
              : item.document_id !== undefined
                ? { worker_id: item.worker_id, document_id: item.document_id }
                : { worker_id: item.worker_id })
      : item.admin_id !== undefined
        ? { admin_id: item.admin_id }
        : item.token_id !== undefined
          ? { token_id: item.token_id }
          : item.site_id !== undefined
            ? { site_id: item.site_id }
            : item.subject !== undefined
              ? { subject: item.subject, entry_id: item.entry_id }
              : { _id: JSON.stringify(item) });
    if (conditionExpression && !mockConditionHolds(store.get(key), conditionExpression, expressionValues, expressionNames)) {
      throw conditionalCheckFailed();
    }
    store.set(key, { ...item });
    console.log(`[MockDB] PUT ${tableName}[${key}]`);
    return item;
  },

  async getItem(tableName, key) {
    const k = memKey(key);
    const item = tableStore(tableName).get(k) || null;
    console.log(`[MockDB] GET ${tableName}[${k}] →`, item ? 'found' : 'null');
    return item;
  },

  async queryItems(tableName, keyConditionExpression, expressionValues, indexName, options = {}) {
    const store = tableStore(tableName);
    const all = Array.from(store.values());
    // Simple linear scan: match items where the expression values appear in the item
    const results = all.filter(item =>
      Object.entries(expressionValues).every(([_placeholder, val]) => {
        return Object.values(item).some(v => v === val);
      })
    );
    const limit = options.Limit || results.length;
    const sliced = options.ScanIndexForward === false ? results.reverse().slice(0, limit) : results.slice(0, limit);
    console.log(`[MockDB] QUERY ${tableName} (index: ${indexName || 'primary'}) → ${sliced.length} item(s)`);
    return sliced;
  },

  async updateItem(tableName, key, updateExpression, expressionValues, expressionNames, conditionExpression) {
    const k = memKey(key);
    const store = tableStore(tableName);
    if (conditionExpression && !mockConditionHolds(store.get(k), conditionExpression, expressionValues, expressionNames)) {
      throw conditionalCheckFailed();
    }
    const existing = store.get(k) || { ...key };
    // Parse simple SET expressions like: SET field = :val, field2 = :val2
    const updated = { ...existing };
    const setPart = updateExpression.replace(/^SET\s+/i, '');
    for (const clause of setPart.split(',')) {
      const match = clause.trim().match(/^(\S+)\s*=\s*(\S+)/);
      if (!match) continue;
      let [, fieldExpr, valExpr] = match;
      // Resolve expression names (#name → actual name)
      const field = expressionNames?.[fieldExpr] ?? fieldExpr;
      // Resolve expression values
      if (expressionValues[valExpr] !== undefined) {
        updated[field] = expressionValues[valExpr];
      } else if (valExpr.includes('+ :inc') || updateExpression.includes('+ :inc')) {
        updated[field] = (existing[field] || 0) + (expressionValues[':inc'] || 1);
      }
    }
    store.set(k, updated);
    console.log(`[MockDB] UPDATE ${tableName}[${k}]`);
    return updated;
  },

  async deleteItem(tableName, key) {
    const k = memKey(key);
    tableStore(tableName).delete(k);
    console.log(`[MockDB] DELETE ${tableName}[${k}]`);
  },

  async scanTable(tableName) {
    const items = Array.from(tableStore(tableName).values());
    console.log(`[MockDB] SCAN ${tableName} → ${items.length} item(s)`);
    return items;
  },
};

// ─────────────────────────────────────────────────────────
// Real DynamoDB client (used in staging / prod only)
// ─────────────────────────────────────────────────────────

const client = IS_DEMO ? null : new DynamoDBClient({ region: config.aws.region });
const docClient = IS_DEMO ? null : DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

// ─────────────────────────────────────────────────────────
// Generic CRUD Helpers
// ─────────────────────────────────────────────────────────

/**
 * Put an item into a DynamoDB table
 * @param {string} tableName
 * @param {object} item
 * @param {string} [conditionExpression] - e.g. 'attribute_not_exists(admin_id)'; a failed
 *   condition throws ConditionalCheckFailedException
 * @param {object} [expressionValues] - Values referenced by the condition, e.g. { ':v': 'x' }
 * @param {object} [expressionNames] - Names referenced by the condition, e.g. { '#a': 'status' }
 */
export async function putItem(tableName, item, conditionExpression, expressionValues, expressionNames) {
  if (IS_DEMO) return mockDb.putItem(tableName, item, conditionExpression, expressionValues, expressionNames);
  await docClient.send(new PutCommand({
    TableName: tableName,
    Item: item,
    ...(conditionExpression && { ConditionExpression: conditionExpression }),
    ...(expressionValues && { ExpressionAttributeValues: expressionValues }),
    ...(expressionNames && { ExpressionAttributeNames: expressionNames }),
  }));
  return item;
}

/**
 * Get a single item by primary key
 * @param {string} tableName
 * @param {object} key - e.g. { worker_id: '123' } or { worker_id: '123', log_date: '2026-03-01' }
 */
export async function getItem(tableName, key) {
  if (IS_DEMO) return mockDb.getItem(tableName, key);
  const result = await docClient.send(new GetCommand({ TableName: tableName, Key: key }));
  return result.Item || null;
}

/**
 * Query items using a key condition expression
 * @param {string} tableName
 * @param {string} keyConditionExpression - e.g. 'worker_id = :wid'
 * @param {object} expressionValues - e.g. { ':wid': '123' }
 * @param {string} [indexName] - GSI name (optional)
 * @param {object} [options] - Additional options (Limit, ScanIndexForward, FilterExpression, etc.)
 */
export async function queryItems(tableName, keyConditionExpression, expressionValues, indexName, options = {}) {
  if (IS_DEMO) return mockDb.queryItems(tableName, keyConditionExpression, expressionValues, indexName, options);
  const params = {
    TableName: tableName,
    KeyConditionExpression: keyConditionExpression,
    ExpressionAttributeValues: expressionValues,
    ...(indexName && { IndexName: indexName }),
    ...options,
  };

  if (options.expressionAttributeNames) {
    params.ExpressionAttributeNames = options.expressionAttributeNames;
    delete params.expressionAttributeNames;
  }

  const result = await docClient.send(new QueryCommand(params));
  return result.Items || [];
}

/**
 * Update an item with an update expression
 * @param {string} tableName
 * @param {object} key
 * @param {string} updateExpression - e.g. 'SET #name = :name, profile_status = :status'
 * @param {object} expressionValues - e.g. { ':name': 'Ram', ':status': 'active' }
 * @param {object} [expressionNames] - e.g. { '#name': 'name' }
 */
export async function updateItem(tableName, key, updateExpression, expressionValues, expressionNames, conditionExpression) {
  if (IS_DEMO) {
    return mockDb.updateItem(tableName, key, updateExpression, expressionValues, expressionNames, conditionExpression);
  }
  const params = {
    TableName: tableName,
    Key: key,
    UpdateExpression: updateExpression,
    ExpressionAttributeValues: expressionValues,
    ReturnValues: 'ALL_NEW',
  };
  if (expressionNames) {
    params.ExpressionAttributeNames = expressionNames;
  }
  if (conditionExpression) {
    params.ConditionExpression = conditionExpression;
  }
  const result = await docClient.send(new UpdateCommand(params));
  return result.Attributes;
}

/**
 * Delete an item by key
 * @param {string} tableName
 * @param {object} key
 */
export async function deleteItem(tableName, key) {
  if (IS_DEMO) return mockDb.deleteItem(tableName, key);
  await docClient.send(new DeleteCommand({ TableName: tableName, Key: key }));
}

/** Safety cap on the number of items a full scan collects */
const DEFAULT_SCAN_MAX_ITEMS = 10000;

/**
 * Scan a whole table (use sparingly — prefer queries), following LastEvaluatedKey
 * across pages until the table is exhausted or maxItems items have been collected.
 * @param {string} tableName
 * @param {object} [options] - Extra ScanCommand params (FilterExpression, etc.)
 * @param {object} [scanOptions]
 * @param {number} [scanOptions.maxItems=10000] - Stop after this many items
 */
export async function scanTable(tableName, options = {}, { maxItems = DEFAULT_SCAN_MAX_ITEMS } = {}) {
  if (IS_DEMO) return (await mockDb.scanTable(tableName, options)).slice(0, maxItems);
  const items = [];
  let startKey;
  do {
    const result = await docClient.send(new ScanCommand({
      TableName: tableName,
      ...options,
      ...(startKey && { ExclusiveStartKey: startKey }),
    }));
    items.push(...(result.Items || []));
    startKey = result.LastEvaluatedKey;
  } while (startKey && items.length < maxItems);
  if (items.length >= maxItems && startKey) {
    console.warn(`[DynamoDB] scan of ${tableName} stopped at ${maxItems} items`);
  }
  return items.slice(0, maxItems);
}

/**
 * Scan a single page of a table.
 * @param {string} tableName
 * @param {object} [options] - ScanCommand params (Limit, ExclusiveStartKey, ...)
 * @returns {Promise<{ items: object[], lastEvaluatedKey: object|null }>}
 */
export async function scanPage(tableName, options = {}) {
  if (IS_DEMO) {
    const all = await mockDb.scanTable(tableName, options);
    const start = options.ExclusiveStartKey ? Number(options.ExclusiveStartKey._offset) || 0 : 0;
    const end = options.Limit ? start + options.Limit : all.length;
    return { items: all.slice(start, end), lastEvaluatedKey: end < all.length ? { _offset: end } : null };
  }
  const result = await docClient.send(new ScanCommand({ TableName: tableName, ...options }));
  return { items: result.Items || [], lastEvaluatedKey: result.LastEvaluatedKey || null };
}

// ─────────────────────────────────────────────────────────
// Domain-Specific Helpers
// ─────────────────────────────────────────────────────────

/** Look up a worker by phone number using PhoneNumberIndex GSI */
export async function getWorkerByPhone(phoneNumber) {
  const items = await queryItems(
    config.tables.workers,
    'phone_number = :phone',
    { ':phone': phoneNumber },
    'PhoneNumberIndex',
    { Limit: 1 },
  );
  return items.length > 0 ? items[0] : null;
}

/**
 * Get conversation state for a worker. The canonical row is session_id = workerId; older
 * deployments keyed onboarding rows by a random UUID, which can sort above the canonical row,
 * so read the canonical row first and move a legacy row onto it the first time it is seen.
 */
export async function getConversationState(workerId) {
  const canonical = await getItem(config.tables.conversation, { worker_id: workerId, session_id: workerId });
  if (canonical) return canonical;

  const items = await queryItems(
    config.tables.conversation,
    'worker_id = :wid',
    { ':wid': workerId },
    undefined,
    { ScanIndexForward: false, Limit: 1 },
  );
  const legacy = items[0];
  if (!legacy) return null;

  const migrated = { ...legacy, session_id: workerId };
  await putItem(config.tables.conversation, migrated);
  await deleteItem(config.tables.conversation, { worker_id: workerId, session_id: legacy.session_id });
  return migrated;
}

/** Save or update conversation state */
export async function saveConversationState(workerId, sessionId, state) {
  const ttl = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now
  const item = {
    worker_id: workerId,
    session_id: sessionId,
    ...state,
    ttl,
    updated_at: new Date().toISOString(),
  };
  return putItem(config.tables.conversation, item);
}

/** Get all attendance logs for a worker */
export async function getWorkerAttendanceLogs(workerId) {
  return queryItems(
    config.tables.attendance,
    'worker_id = :wid',
    { ':wid': workerId },
  );
}

/** Get pending review items from ReviewQueueIndex */
export async function getPendingReviews(limit = 20) {
  return queryItems(
    config.tables.attendance,
    'verification_status = :status',
    { ':status': 'pending_review' },
    'ReviewQueueIndex',
    { Limit: limit, ScanIndexForward: false },
  );
}

/** Atomically increment total_days_logged on Workers table */
export async function incrementDaysLogged(workerId) {
  return updateItem(
    config.tables.workers,
    { worker_id: workerId },
    'SET total_days_logged = if_not_exists(total_days_logged, :zero) + :inc',
    { ':zero': 0, ':inc': 1 },
  );
}

/** Update worker reminder state after a check-in */
export async function updateWorkerReminderState(workerId, lastCheckinDate, nextReminderTime) {
  return updateItem(
    config.tables.workers,
    { worker_id: workerId },
    'SET last_checkin_date = :ld, next_reminder_time = :nt',
    { ':ld': lastCheckinDate, ':nt': nextReminderTime },
  );
}

/** Update only the next reminder time (used by the cron job) */
export async function updateWorkerReminderTime(workerId, nextReminderTime) {
  return updateItem(
    config.tables.workers,
    { worker_id: workerId },
    'SET next_reminder_time = :nt',
    { ':nt': nextReminderTime },
  );
}

export default {
  putItem,
  getItem,
  queryItems,
  updateItem,
  deleteItem,
  scanTable,
  scanPage,
  getWorkerByPhone,
  getConversationState,
  saveConversationState,
  getWorkerAttendanceLogs,
  getPendingReviews,
  incrementDaysLogged,
  updateWorkerReminderState,
  updateWorkerReminderTime,
};
