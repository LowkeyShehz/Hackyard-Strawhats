/**
 * Nirman Mitra — Postgres backend for the data helpers in utils/dynamodb.js (DB_BACKEND=postgres)
 * Every DynamoDB table becomes rows of one `items` table: (tbl, pk, sk) as the primary key and the
 * whole item as JSONB. Key schemas and GSIs mirror template.yaml, so queries, sort order and sparse
 * indexes behave as they did on DynamoDB. Conditions and updates use the same DynamoDB expressions
 * (utils/expressions.js), evaluated inside a transaction that holds a per-key advisory lock, so
 * conditional writes stay atomic under concurrent webhooks.
 */

import pg from 'pg';
import config from './config.js';
import { conditionHolds, applyUpdate, parseKeyCondition, compare } from './expressions.js';

/** Key schema and GSIs per table (config.tables key), as in template.yaml */
const SCHEMAS = {
  workers: { pk: 'worker_id', indexes: { PhoneNumberIndex: ['phone_number'], ReminderIndex: ['profile_status', 'next_reminder_time'] } },
  attendance: { pk: 'worker_id', sk: 'log_date', indexes: { SiteLogsIndex: ['site_id', 'log_date'], ReviewQueueIndex: ['verification_status', 'timestamp'] } },
  sites: { pk: 'site_id', indexes: { ActiveSitesIndex: ['is_active'] } },
  certificates: { pk: 'worker_id', sk: 'certificate_id', indexes: { VerificationHashIndex: ['verification_hash'], CertificateIdIndex: ['certificate_id'] } },
  audit: { pk: 'subject', sk: 'entry_id' },
  documents: { pk: 'worker_id', sk: 'document_id' },
  conversation: { pk: 'worker_id', sk: 'session_id', ttl: true },
  bedrockCache: { pk: 'input_hash', ttl: true },
  adminUsers: { pk: 'admin_id', indexes: { EmailIndex: ['email'] } },
  refreshTokens: { pk: 'token_id', ttl: true },
};

function schemaFor(tableName) {
  const key = Object.keys(config.tables).find((k) => config.tables[k] === tableName);
  const schema = key && SCHEMAS[key];
  if (!schema) throw new Error(`[Postgres] Unknown table ${tableName}`);
  return schema;
}

function conditionalCheckFailed() {
  return Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
}

/** Primary key columns of an item or key object; missing key attributes are a validation error */
function keyColumns(schema, item) {
  const pk = item?.[schema.pk];
  const sk = schema.sk ? item?.[schema.sk] : '';
  if (pk === undefined || pk === null || sk === undefined || sk === null) {
    throw Object.assign(new Error('ValidationException: missing key attribute'), { name: 'ValidationException' });
  }
  return [String(pk), String(sk)];
}

const sqlLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sqlIdent = (s) => s.toLowerCase().replace(/[^a-z0-9_]/g, '_');

let pool = null;
let ready = null;

function getPool() {
  if (!pool) {
    if (!config.databaseUrl) throw new Error('[Postgres] DATABASE_URL is not set');
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
    pool.on('error', (err) => console.error('[Postgres] idle client error:', err.message));
  }
  return pool;
}

/** Create the items table and one expression index per GSI hash key (idempotent, once per process) */
function ensureSchema() {
  if (!ready) {
    const statements = [
      `CREATE TABLE IF NOT EXISTS items (
         tbl  text  NOT NULL,
         pk   text  NOT NULL,
         sk   text  NOT NULL DEFAULT '',
         data jsonb NOT NULL,
         PRIMARY KEY (tbl, pk, sk)
       )`,
    ];
    for (const [key, schema] of Object.entries(SCHEMAS)) {
      const table = config.tables[key];
      for (const [indexName, [hashKey]] of Object.entries(schema.indexes || {})) {
        statements.push(`CREATE INDEX IF NOT EXISTS ${sqlIdent(`items_${key}_${indexName}`)}
          ON items ((data -> ${sqlLiteral(hashKey)})) WHERE tbl = ${sqlLiteral(table)}`);
      }
    }
    ready = (async () => {
      for (const sql of statements) await getPool().query(sql);
    })().catch((err) => { ready = null; throw err; });
  }
  return ready;
}

async function query(sql, params) {
  await ensureSchema();
  return getPool().query(sql, params);
}

/** Run fn(client, existingItem) in a transaction holding the row's advisory lock */
async function withLockedItem(tableName, pk, sk, fn) {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([tableName, pk, sk])]);
    const { rows } = await client.query('SELECT data FROM items WHERE tbl = $1 AND pk = $2 AND sk = $3', [tableName, pk, sk]);
    const result = await fn(client, rows[0]?.data);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const UPSERT = `INSERT INTO items (tbl, pk, sk, data) VALUES ($1, $2, $3, $4)
  ON CONFLICT (tbl, pk, sk) DO UPDATE SET data = EXCLUDED.data`;

/** JSON round trip drops undefined attributes, like removeUndefinedValues on DynamoDB */
const toJson = (item) => JSON.stringify(item);

/** Range-key order: numbers numerically, strings by code unit (as DynamoDB sorts them) */
function byRangeKey(rangeKey) {
  return (a, b) => {
    const c = compare(a[rangeKey], b[rangeKey]);
    return Number.isNaN(c) ? compare(String(a[rangeKey]), String(b[rangeKey])) : c;
  };
}

function sortAndPage(items, rangeKey, options) {
  let out = rangeKey ? [...items].sort(byRangeKey(rangeKey)) : items;
  if (options.FilterExpression) {
    out = out.filter((it) => conditionHolds(it, options.FilterExpression, options.ExpressionAttributeValues, options.ExpressionAttributeNames));
  }
  if (options.ScanIndexForward === false) out = [...out].reverse();
  if (options.Limit) out = out.slice(0, options.Limit);
  return out;
}

export const postgresDb = {
  async putItem(tableName, item, conditionExpression, expressionValues, expressionNames) {
    const [pk, sk] = keyColumns(schemaFor(tableName), item);
    if (!conditionExpression) {
      await query(UPSERT, [tableName, pk, sk, toJson(item)]);
      return item;
    }
    return withLockedItem(tableName, pk, sk, async (client, existing) => {
      if (!conditionHolds(existing, conditionExpression, expressionValues, expressionNames)) throw conditionalCheckFailed();
      await client.query(UPSERT, [tableName, pk, sk, toJson(item)]);
      return item;
    });
  },

  async getItem(tableName, key) {
    const [pk, sk] = keyColumns(schemaFor(tableName), key);
    const { rows } = await query('SELECT data FROM items WHERE tbl = $1 AND pk = $2 AND sk = $3', [tableName, pk, sk]);
    return rows[0]?.data ?? null;
  },

  async queryItems(tableName, keyConditionExpression, expressionValues, indexName, options = {}) {
    const schema = schemaFor(tableName);
    const keys = indexName ? schema.indexes?.[indexName] : [schema.pk, schema.sk];
    if (!keys) throw Object.assign(new Error(`ValidationException: no index ${indexName} on ${tableName}`), { name: 'ValidationException' });
    const [hashKey, rangeKey] = keys;
    const names = options.expressionAttributeNames || options.ExpressionAttributeNames;
    const { hashValue, matches } = parseKeyCondition(keyConditionExpression, hashKey, names, expressionValues);

    const { rows } = indexName
      ? await query('SELECT data FROM items WHERE tbl = $1 AND data -> $2 = $3::jsonb', [tableName, hashKey, JSON.stringify(hashValue)])
      : await query('SELECT data FROM items WHERE tbl = $1 AND pk = $2', [tableName, String(hashValue)]);

    // GSIs are sparse: items without the index's range key are not in the index
    const items = rows.map((r) => r.data).filter((it) => (!indexName || !rangeKey || it[rangeKey] !== undefined) && matches(it));
    return sortAndPage(items, rangeKey, options);
  },

  async updateItem(tableName, key, updateExpression, expressionValues, expressionNames, conditionExpression) {
    const [pk, sk] = keyColumns(schemaFor(tableName), key);
    return withLockedItem(tableName, pk, sk, async (client, existing) => {
      if (conditionExpression && !conditionHolds(existing, conditionExpression, expressionValues, expressionNames)) {
        throw conditionalCheckFailed();
      }
      const updated = { ...applyUpdate(existing ?? key, updateExpression, expressionValues, expressionNames), ...key };
      await client.query(UPSERT, [tableName, pk, sk, toJson(updated)]);
      return updated;
    });
  },

  async deleteItem(tableName, key) {
    const [pk, sk] = keyColumns(schemaFor(tableName), key);
    await query('DELETE FROM items WHERE tbl = $1 AND pk = $2 AND sk = $3', [tableName, pk, sk]);
  },

  async scanTable(tableName, options = {}, { maxItems } = {}) {
    schemaFor(tableName);
    const { rows } = await query('SELECT data FROM items WHERE tbl = $1 ORDER BY pk, sk LIMIT $2', [tableName, maxItems]);
    return sortAndPage(rows.map((r) => r.data), null, options);
  },

  /** One page in primary-key order; ExclusiveStartKey is the previous page's lastEvaluatedKey */
  async scanPage(tableName, options = {}) {
    const schema = schemaFor(tableName);
    const limit = options.Limit || 1000;
    const start = options.ExclusiveStartKey ? keyColumns(schema, options.ExclusiveStartKey) : null;
    const { rows } = start
      ? await query('SELECT data FROM items WHERE tbl = $1 AND (pk, sk) > ($2, $3) ORDER BY pk, sk LIMIT $4', [tableName, ...start, limit])
      : await query('SELECT data FROM items WHERE tbl = $1 ORDER BY pk, sk LIMIT $2', [tableName, limit]);
    const items = rows.map((r) => r.data);
    const last = items.length === limit ? items[items.length - 1] : null;
    const lastEvaluatedKey = last
      ? { [schema.pk]: last[schema.pk], ...(schema.sk && { [schema.sk]: last[schema.sk] }) }
      : null;
    return { items, lastEvaluatedKey };
  },
};

/**
 * Delete rows whose `ttl` (epoch seconds) has passed, in the tables that had DynamoDB TTL.
 * DynamoDB removed these lazily (within about 48 h); the reminder cron job runs this every 15 min.
 * @returns {Promise<number>} rows deleted
 */
export async function pruneExpired(nowSeconds = Math.floor(Date.now() / 1000)) {
  const tables = Object.entries(SCHEMAS).filter(([, s]) => s.ttl).map(([key]) => config.tables[key]);
  const { rowCount } = await query(
    `DELETE FROM items WHERE tbl = ANY($1) AND jsonb_typeof(data -> 'ttl') = 'number' AND (data ->> 'ttl')::numeric < $2`,
    [tables, nowSeconds],
  );
  return rowCount;
}

/** Close the pool (scripts and tests) */
export async function closePostgres() {
  if (pool) await pool.end();
  pool = null;
  ready = null;
}

export default { postgresDb, pruneExpired, closePostgres };
