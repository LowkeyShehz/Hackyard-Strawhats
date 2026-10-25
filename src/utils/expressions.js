/**
 * Nirman Mitra — DynamoDB expression evaluator
 * Evaluates the DynamoDB expressions the data helpers take (conditions, key conditions and
 * updates) against plain items, so the Postgres backend keeps every call site and the same
 * conditional-write semantics.
 *
 * Conditions: attribute_exists(a), attribute_not_exists(a), begins_with(a, :v),
 *   a = | <> | < | <= | > | >= :v and a BETWEEN :x AND :y, combined with AND, OR, NOT and ( ).
 * Updates: SET a = x [+|- y] where x, y are :v, a, if_not_exists(a, :v) or list_append(x, y),
 *   and REMOVE a, b.
 * Only top-level attributes are supported. Anything else throws, so an unsupported expression
 * fails loudly instead of being silently ignored.
 */

function validationError(message) {
  return Object.assign(new Error(`ValidationException: ${message}`), { name: 'ValidationException' });
}

const KEYWORDS = new Set(['AND', 'OR', 'NOT', 'BETWEEN', 'SET', 'REMOVE', 'ADD', 'DELETE']);

function tokenize(text) {
  const tokens = [];
  const re = /\s*(<>|<=|>=|[=<>(),+-]|:[A-Za-z0-9_]+|#[A-Za-z0-9_]+|[A-Za-z_][A-Za-z0-9_]*)/y;
  let pos = 0;
  while (pos < text.length) {
    if (/^\s*$/.test(text.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) throw validationError(`unsupported expression syntax near "${text.slice(pos).trim()}"`);
    const tok = m[1];
    tokens.push(KEYWORDS.has(tok.toUpperCase()) ? tok.toUpperCase() : tok);
    pos = re.lastIndex;
  }
  return tokens;
}

/** Recursive-descent parser over one expression's tokens */
class Parser {
  constructor(text, names = {}, values = {}) {
    this.tokens = tokenize(text);
    this.i = 0;
    this.names = names || {};
    this.values = values || {};
  }

  peek() { return this.tokens[this.i]; }
  next() { return this.tokens[this.i++]; }
  done() { return this.i >= this.tokens.length; }

  expect(tok) {
    const got = this.next();
    if (got !== tok) throw validationError(`expected "${tok}" but found "${got ?? 'end'}"`);
  }

  attrName(tok) {
    if (tok?.startsWith('#')) {
      if (!(tok in this.names)) throw validationError(`ExpressionAttributeNames missing ${tok}`);
      return this.names[tok];
    }
    if (!tok || !/^[A-Za-z_]/.test(tok) || KEYWORDS.has(tok)) throw validationError(`expected an attribute, found "${tok ?? 'end'}"`);
    return tok;
  }

  value(tok) {
    if (!(tok in this.values)) throw validationError(`ExpressionAttributeValues missing ${tok}`);
    return this.values[tok];
  }

  /** Operand: a value placeholder, an attribute, or one of the update functions */
  operand() {
    const tok = this.next();
    if (tok?.startsWith(':')) {
      const v = this.value(tok);
      return { type: 'value', eval: () => v };
    }
    if (tok === 'if_not_exists' || tok === 'list_append') {
      this.expect('(');
      const a = tok === 'if_not_exists' ? this.pathOperand() : this.operand();
      this.expect(',');
      const b = this.operand();
      this.expect(')');
      if (tok === 'if_not_exists') return { type: 'fn', eval: (item) => (item?.[a.name] !== undefined ? item[a.name] : b.eval(item)) };
      return { type: 'fn', eval: (item) => [...(a.eval(item) ?? []), ...(b.eval(item) ?? [])] };
    }
    const name = this.attrName(tok);
    return { type: 'path', name, eval: (item) => item?.[name] };
  }

  pathOperand() {
    const op = this.operand();
    if (op.type !== 'path') throw validationError('expected an attribute');
    return op;
  }

  // ── Conditions ────────────────────────────────────────

  condition() {
    let left = this.conjunction();
    while (this.peek() === 'OR') {
      this.next();
      const l = left;
      const r = this.conjunction();
      left = { op: 'OR', args: [l, r], eval: (item) => l.eval(item) || r.eval(item) };
    }
    return left;
  }

  conjunction() {
    let left = this.negation();
    while (this.peek() === 'AND') {
      this.next();
      const l = left;
      const r = this.negation();
      left = { op: 'AND', args: [l, r], eval: (item) => l.eval(item) && r.eval(item) };
    }
    return left;
  }

  negation() {
    if (this.peek() === 'NOT') {
      this.next();
      const inner = this.negation();
      return { op: 'NOT', args: [inner], eval: (item) => !inner.eval(item) };
    }
    return this.primary();
  }

  primary() {
    const tok = this.peek();
    if (tok === '(') {
      this.next();
      const inner = this.condition();
      this.expect(')');
      return inner;
    }
    if (tok === 'attribute_exists' || tok === 'attribute_not_exists' || tok === 'begins_with') {
      this.next();
      this.expect('(');
      const path = this.pathOperand();
      let prefix;
      if (tok === 'begins_with') {
        this.expect(',');
        prefix = this.operand();
      }
      this.expect(')');
      if (tok === 'attribute_exists') return { op: 'exists', path: path.name, eval: (item) => item?.[path.name] !== undefined };
      if (tok === 'attribute_not_exists') return { op: 'not_exists', path: path.name, eval: (item) => item?.[path.name] === undefined };
      return {
        op: 'begins_with',
        path: path.name,
        eval: (item) => {
          const v = path.eval(item);
          const p = prefix.eval(item);
          return typeof v === 'string' && typeof p === 'string' && v.startsWith(p);
        },
      };
    }

    const left = this.operand();
    const op = this.next();
    if (op === 'BETWEEN') {
      const lo = this.operand();
      this.expect('AND');
      const hi = this.operand();
      return {
        op: 'BETWEEN',
        path: left.name,
        eval: (item) => compare(left.eval(item), lo.eval(item)) >= 0 && compare(left.eval(item), hi.eval(item)) <= 0,
      };
    }
    if (!['=', '<>', '<', '<=', '>', '>='].includes(op)) throw validationError(`unsupported operator "${op ?? 'end'}"`);
    const right = this.operand();
    return {
      op,
      path: left.type === 'path' ? left.name : undefined,
      operand: right,
      eval: (item) => {
        const a = left.eval(item);
        const b = right.eval(item);
        if (op === '=') return a !== undefined && equal(a, b);
        if (op === '<>') return a === undefined || !equal(a, b);
        const c = compare(a, b);
        if (Number.isNaN(c)) return false;
        return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
      },
    };
  }

  // ── Updates ───────────────────────────────────────────

  update() {
    const actions = [];
    while (!this.done()) {
      const clause = this.next();
      if (clause === 'SET') {
        do {
          const target = this.attrName(this.next());
          this.expect('=');
          const first = this.operand();
          let valueOf = first.eval;
          if (this.peek() === '+' || this.peek() === '-') {
            const sign = this.next() === '+' ? 1 : -1;
            const second = this.operand();
            valueOf = (item) => {
              const a = first.eval(item);
              const b = second.eval(item);
              if (typeof a !== 'number' || typeof b !== 'number') throw validationError(`arithmetic on non-number for ${target}`);
              return a + sign * b;
            };
          }
          actions.push((item, out) => { out[target] = valueOf(item); });
        } while (this.peek() === ',' && this.next());
      } else if (clause === 'REMOVE') {
        do {
          const target = this.attrName(this.next());
          actions.push((_item, out) => { delete out[target]; });
        } while (this.peek() === ',' && this.next());
      } else {
        throw validationError(`unsupported update clause "${clause}"`);
      }
    }
    return actions;
  }
}

function equal(a, b) {
  if (a === b) return true;
  if (typeof a === 'object' && typeof b === 'object' && a && b) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/** DynamoDB ordering: numbers numerically, strings by code unit; mixed or missing types never compare */
export function compare(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return NaN;
}

/**
 * Parse a condition expression. The result's eval(item) is true when the condition holds;
 * a missing item (no row yet) is passed as undefined, matching DynamoDB.
 */
export function parseCondition(expression, names, values) {
  const parser = new Parser(expression, names, values);
  const tree = parser.condition();
  if (!parser.done()) throw validationError(`unexpected "${parser.peek()}" in condition`);
  return tree;
}

/** True when the condition holds for item (undefined = no item) */
export function conditionHolds(item, expression, values, names) {
  return parseCondition(expression, names, values).eval(item);
}

/**
 * Apply an update expression to an item. Returns a new item; the input is left unchanged.
 * Every right-hand side reads the item as it was before the update, as in DynamoDB.
 */
export function applyUpdate(item, expression, values, names) {
  const parser = new Parser(expression, names, values);
  const actions = parser.update();
  const before = item ? structuredClone(item) : {};
  const out = structuredClone(before);
  for (const action of actions) action(before, out);
  return out;
}

/**
 * The hash-key value of a key condition such as `hk = :v AND rk <= :x`, and a predicate for the
 * whole condition (checked per item after the hash-key lookup).
 * @returns {{ hashValue: *, matches: (item: object) => boolean }}
 */
export function parseKeyCondition(expression, hashKey, names, values) {
  const tree = parseCondition(expression, names, values);
  const terms = [];
  const collect = (node) => {
    if (node.op === 'AND') node.args.forEach(collect);
    else terms.push(node);
  };
  collect(tree);
  const hashTerm = terms.find((t) => t.op === '=' && t.path === hashKey);
  if (!hashTerm || terms.some((t) => t.op === 'OR' || t.op === 'NOT')) {
    throw validationError(`key condition must be "${hashKey} = :value" with an optional range condition`);
  }
  return { hashValue: hashTerm.operand.eval(undefined), matches: tree.eval };
}

export default { parseCondition, conditionHolds, applyUpdate, parseKeyCondition, compare };
