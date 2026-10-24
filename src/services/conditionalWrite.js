/**
 * Nirman Mitra — Conditional Writes
 * putItem() in utils/dynamodb.js overwrites unless given a condition. Writes that must happen at
 * most once (one check-in per day, webhook de-duplication) go through here, so two concurrent
 * requests cannot both succeed — in DynamoDB and in the local in-memory store alike.
 */

import { putItem } from '../utils/dynamodb.js';

/**
 * Put an item only if no item with the same primary key exists.
 * @param {string} tableName
 * @param {object} item
 * @param {object} key - Primary key of the item, e.g. { worker_id, log_date }
 * @param {object} [options]
 * @param {{attr: string, value: *}} [options.replaceIf] - Also overwrite an existing item whose attr equals value
 * @returns {Promise<boolean>} true if written, false if an item already existed
 */
export async function putItemIfAbsent(tableName, item, key, { replaceIf } = {}) {
  let condition = `attribute_not_exists(${Object.keys(key)[0]})`;
  let values;
  let names;
  if (replaceIf) {
    condition += ' OR #replace_attr = :replace_value';
    names = { '#replace_attr': replaceIf.attr };
    values = { ':replace_value': replaceIf.value };
  }

  try {
    await putItem(tableName, item, condition, values, names);
    return true;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export default { putItemIfAbsent };
