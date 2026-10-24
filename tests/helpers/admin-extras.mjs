// Extra DynamoDB behaviour for the admin API tests, layered over harness.mjs (import it first):
// - Scan returns small pages with LastEvaluatedKey and honours Limit / ExclusiveStartKey
// - Put honours ConditionExpression attribute_not_exists(...)
// Both operate on the harness's in-memory tables (H.db) with the same key encoding.
import { AwsStub } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import * as H from './harness.mjs';

const KEYS = {
  Workers: ['worker_id'], AttendanceLogs: ['worker_id', 'log_date'], Sites: ['site_id'],
  Certificates: ['worker_id', 'certificate_id'], Documents: ['worker_id', 'document_id'],
  ConversationState: ['worker_id', 'session_id'], BedrockCache: ['input_hash'],
  AdminUsers: ['admin_id'], RefreshTokens: ['token_id'], AuditLog: ['subject', 'entry_id'],
};
const keysOf = (t) => KEYS[Object.keys(KEYS).find((k) => t.includes(`-${k}-`))];
const keyStr = (t, item) => { const [pk, sk] = keysOf(t); return JSON.stringify([item[pk], sk ? item[sk] : null]); };
const tbl = (t) => { if (!H.db.has(t)) H.db.set(t, new Map()); return H.db.get(t); };

export const scanCalls = [];

export function installDdbExtras({ pageSize = 2 } = {}) {
  const proto = DynamoDBDocumentClient.prototype;
  const stub = new AwsStub(proto, proto.send);
  stub.on(ScanCommand).callsFake((i) => {
    scanCalls.push(i);
    const all = [...tbl(i.TableName).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const start = i.ExclusiveStartKey ? all.findIndex(([k]) => k === keyStr(i.TableName, i.ExclusiveStartKey)) + 1 : 0;
    const size = Math.min(i.Limit || Infinity, pageSize);
    const page = all.slice(start, start + size);
    const res = { Items: page.map(([, v]) => structuredClone(v)) };
    if (start + size < all.length && page.length) {
      const last = page.at(-1)[1];
      const [pk, sk] = keysOf(i.TableName);
      res.LastEvaluatedKey = { [pk]: last[pk], ...(sk && { [sk]: last[sk] }) };
    }
    return res;
  });
  stub.on(PutCommand).callsFake((i) => {
    const t = tbl(i.TableName);
    const k = keyStr(i.TableName, i.Item);
    if (/attribute_not_exists/i.test(i.ConditionExpression || '') && t.has(k)) {
      throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
    }
    t.set(k, structuredClone(i.Item));
    return {};
  });
}
