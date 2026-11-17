/**
 * 通知成立条件：一个受限的「类 JS 表达式」求值器。
 *
 * 设计要点：
 * - 不调用 eval / new Function，只解析并解释执行允许的运算符，避免执行任意代码。
 * - 所有属性访问都是安全取值：路径中途为 null/undefined 时得到 MISSING，
 *   不会抛错；含 MISSING 的比较一律不成立（包括 !=），符合「取不到就不成立」。
 * - `=` 与 `==` 同义（宽松相等），所以字符串 "0" 与数字 0 都匹配 `=0`。
 */

export class ConditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConditionError";
  }
}

const MAX_LENGTH = 1_000;
const MAX_TOKENS = 500;
const MAX_DEPTH = 64;
const MAX_STEPS = 10_000;

const MISSING = Symbol("condition.missing");
function isMissing(value: unknown): value is typeof MISSING {
  return value === MISSING;
}

type TokenType = "number" | "string" | "ident" | "op" | "eof";
interface Token {
  type: TokenType;
  value: string | number;
  pos: number;
}

const IDENT_START = /[\p{L}_$]/u;
const IDENT_PART = /[\p{L}\p{N}_$]/u;
const OP_TWO = new Set(["==", "!=", "<=", ">=", "&&", "||", "?."]);
const OP_ONE = new Set(["=", "!", "<", ">", "?", ":", ".", "[", "]", "(", ")", "+", "-", "*", "/", "%", ","]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const start = i;
      const quote = ch;
      i += 1;
      let value = "";
      let closed = false;
      while (i < source.length) {
        const current = source[i++]!;
        if (current === quote) {
          closed = true;
          break;
        }
        if (current !== "\\") {
          value += current;
          continue;
        }
        const escaped = source[i++];
        if (escaped === undefined) break;
        switch (escaped) {
          case "n": value += "\n"; break;
          case "r": value += "\r"; break;
          case "t": value += "\t"; break;
          case "u": {
            const hex = source.slice(i, i + 4);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              value += String.fromCharCode(Number.parseInt(hex, 16));
              i += 4;
            } else {
              value += "u";
            }
            break;
          }
          default: value += escaped;
        }
      }
      if (!closed) throw new ConditionError(`表达式语法错误：位置 ${start} 的字符串未闭合`);
      tokens.push({ type: "string", value, pos: start });
      continue;
    }

    const numberMatch = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i));
    if (numberMatch) {
      const raw = numberMatch[0];
      tokens.push({ type: "number", value: Number(raw), pos: i });
      i += raw.length;
      continue;
    }

    if (IDENT_START.test(ch)) {
      const start = i;
      i += 1;
      while (i < source.length && IDENT_PART.test(source[i]!)) i += 1;
      tokens.push({ type: "ident", value: source.slice(start, i), pos: start });
      continue;
    }

    const three = source.slice(i, i + 3);
    if (three === "===" || three === "!==") {
      tokens.push({ type: "op", value: three, pos: i });
      i += 3;
      continue;
    }
    const two = source.slice(i, i + 2);
    // 与 ECMAScript 一致：`?.` 后紧跟数字时不作可选链，保留为三元 `?` + 小数。
    const optionalChainFollowedByDigit = two === "?." && /[0-9]/.test(source[i + 2] ?? "");
    if (OP_TWO.has(two) && !optionalChainFollowedByDigit) {
      tokens.push({ type: "op", value: two, pos: i });
      i += 2;
      continue;
    }
    if (OP_ONE.has(ch)) {
      tokens.push({ type: "op", value: ch, pos: i });
      i += 1;
      continue;
    }
    throw new ConditionError(`表达式语法错误：位置 ${i} 出现不支持的字符 ${JSON.stringify(ch)}`);
  }
  tokens.push({ type: "eof", value: "", pos: source.length });
  return tokens;
}

type Node =
  | { type: "literal"; value: unknown }
  | { type: "ident"; name: string }
  | { type: "member"; object: Node; property: string | Node; computed: boolean }
  | { type: "unary"; operator: string; argument: Node }
  | { type: "binary"; operator: string; left: Node; right: Node }
  | { type: "ternary"; test: Node; consequent: Node; alternate: Node };

const PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "=": 3, "==": 3, "===": 3, "!=": 3, "!==": 3,
  "<": 4, "<=": 4, ">": 4, ">=": 4,
  "+": 5, "-": 5,
  "*": 6, "/": 6, "%": 6,
};

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.parseTernary();
    const token = this.peek();
    if (token.type !== "eof") {
      throw new ConditionError(`表达式语法错误：位置 ${token.pos} 出现多余的内容 ${JSON.stringify(String(token.value))}`);
    }
    return node;
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private take(): Token {
    return this.tokens[this.index++]!;
  }

  private isOperator(value: string): boolean {
    const token = this.peek();
    return token.type === "op" && token.value === value;
  }

  private expectOperator(value: string): void {
    if (!this.isOperator(value)) {
      const token = this.peek();
      throw new ConditionError(`表达式语法错误：位置 ${token.pos} 应为 ${value}`);
    }
    this.take();
  }

  private guard<T>(callback: () => T): T {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new ConditionError("表达式嵌套过深");
    try {
      return callback();
    } finally {
      this.depth -= 1;
    }
  }

  private parseTernary(): Node {
    return this.guard(() => {
      const test = this.parseBinary(1);
      if (!this.isOperator("?")) return test;
      this.take();
      const consequent = this.parseTernary();
      this.expectOperator(":");
      const alternate = this.parseTernary();
      return { type: "ternary", test, consequent, alternate };
    });
  }

  private parseBinary(minPrecedence: number): Node {
    let left = this.parseUnary();
    while (true) {
      const token = this.peek();
      if (token.type !== "op") break;
      const precedence = PRECEDENCE[String(token.value)];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.take();
      const right = this.parseBinary(precedence + 1);
      left = { type: "binary", operator: String(token.value), left, right };
    }
    return left;
  }

  private parseUnary(): Node {
    return this.guard(() => {
      const token = this.peek();
      if (token.type === "op" && (token.value === "!" || token.value === "-" || token.value === "+")) {
        this.take();
        return { type: "unary", operator: String(token.value), argument: this.parseUnary() };
      }
      return this.parsePostfix();
    });
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    while (true) {
      if (this.isOperator(".") || this.isOperator("?.")) {
        const chain = this.isOperator("?.");
        this.take();
        if (chain && this.isOperator("[")) {
          this.take();
          const property = this.parseTernary();
          this.expectOperator("]");
          node = { type: "member", object: node, property, computed: true };
          continue;
        }
        const token = this.peek();
        if (token.type !== "ident") {
          throw new ConditionError(`表达式语法错误：位置 ${token.pos} 应为属性名`);
        }
        this.take();
        node = { type: "member", object: node, property: String(token.value), computed: false };
        continue;
      }
      if (this.isOperator("[")) {
        this.take();
        const property = this.parseTernary();
        this.expectOperator("]");
        node = { type: "member", object: node, property, computed: true };
        continue;
      }
      break;
    }
    return node;
  }

  private parsePrimary(): Node {
    return this.guard(() => {
      const token = this.take();
      if (token.type === "number" || token.type === "string") {
        return { type: "literal", value: token.value };
      }
      if (token.type === "ident") {
        const name = String(token.value);
        switch (name) {
          case "true": return { type: "literal", value: true };
          case "false": return { type: "literal", value: false };
          case "null": return { type: "literal", value: null };
          case "undefined": return { type: "literal", value: undefined };
          default: return { type: "ident", name };
        }
      }
      if (token.type === "op" && token.value === "(") {
        const node = this.parseTernary();
        this.expectOperator(")");
        return node;
      }
      throw new ConditionError(`表达式语法错误：位置 ${token.pos} 缺少值`);
    });
  }
}

function parseExpression(source: string): Node {
  if (source.length > MAX_LENGTH) {
    throw new ConditionError(`条件表达式不能超过 ${MAX_LENGTH} 个字符`);
  }
  const tokens = tokenize(source);
  if (tokens.length > MAX_TOKENS) throw new ConditionError("条件表达式过长");
  return new Parser(tokens).parse();
}

/** 校验表达式语法；返回 null 表示可用（空串也表示「未设置」）。 */
export function validateCondition(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) return null;
  try {
    parseExpression(trimmed);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "条件表达式无效";
  }
}

export interface ConditionContext {
  /** 已解析的响应体（JSON.parse 的结果；非 JSON 时为 null）。 */
  json: unknown;
  /** HTTP 状态码。 */
  status: number | null;
  /** 原始响应体文本。 */
  body: string | null;
}

function truthy(value: unknown): boolean {
  return !isMissing(value) && Boolean(value);
}

/** 安全取值：中间环节缺失、原型链属性、非对象一律得到 MISSING。 */
function getProperty(object: unknown, key: string): unknown {
  if (isMissing(object) || object === null || object === undefined) return MISSING;
  if (key === "__proto__" || key === "prototype" || key === "constructor") return MISSING;
  if (typeof object === "string") {
    if (key === "length") return object.length;
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0 && index < object.length) return object[index];
    return MISSING;
  }
  if (typeof object !== "object") return MISSING;
  if (!Object.prototype.hasOwnProperty.call(object, key)) return MISSING;
  return (object as Record<string, unknown>)[key];
}

function lookupIdentifier(name: string, context: ConditionContext): unknown {
  if (name === "$status") return context.status ?? MISSING;
  if (name === "$body") return context.body ?? MISSING;
  if (name === "$json") return context.json ?? MISSING;
  const json = context.json;
  if (json !== null && typeof json === "object" && Object.prototype.hasOwnProperty.call(json, name)) {
    return (json as Record<string, unknown>)[name];
  }
  return MISSING;
}

function looseEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) {
    return left == null && right == null;
  }
  if (typeof left === "number" && typeof right === "string") return left === Number(right);
  if (typeof left === "string" && typeof right === "number") return Number(left) === right;
  if (typeof left === "boolean") return looseEqual(Number(left), right);
  if (typeof right === "boolean") return looseEqual(left, Number(right));
  return false;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (typeof value === "boolean") return Number(value);
  return Number.NaN;
}

function compare(operator: string, left: unknown, right: unknown): boolean | typeof MISSING {
  if (isMissing(left) || isMissing(right)) return MISSING;
  switch (operator) {
    case "=":
    case "==": return looseEqual(left, right);
    case "===": return left === right;
    case "!=": return !looseEqual(left, right);
    case "!==": return left !== right;
    case "<":
    case "<=":
    case ">":
    case ">=": {
      let result: boolean;
      if (typeof left === "string" && typeof right === "string") {
        result = operator === "<" ? left < right : operator === "<=" ? left <= right : operator === ">" ? left > right : left >= right;
      } else {
        const a = toNumber(left);
        const b = toNumber(right);
        if (Number.isNaN(a) || Number.isNaN(b)) return false;
        result = operator === "<" ? a < b : operator === "<=" ? a <= b : operator === ">" ? a > b : a >= b;
      }
      return result;
    }
    default:
      throw new ConditionError(`表达式语法错误：不支持的运算符 ${operator}`);
  }
}

class Evaluator {
  private steps = 0;

  constructor(private readonly context: ConditionContext) {}

  evaluate(node: Node): unknown {
    this.steps += 1;
    if (this.steps > MAX_STEPS) throw new ConditionError("表达式过于复杂");
    switch (node.type) {
      case "literal":
        return node.value;
      case "ident":
        return lookupIdentifier(node.name, this.context);
      case "member": {
        const object = this.evaluate(node.object);
        const key = node.computed ? this.evaluate(node.property as Node) : (node.property as string);
        if (isMissing(object) || isMissing(key)) return MISSING;
        return getProperty(object, typeof key === "string" ? key : String(key));
      }
      case "unary": {
        const value = this.evaluate(node.argument);
        // 缺失沿运算链传播，保证 `!(x==0)` 与 `x!=0` 结论一致（都不成立）。
        if (isMissing(value)) return MISSING;
        if (node.operator === "!") return !truthy(value);
        const number = toNumber(value);
        if (Number.isNaN(number)) return MISSING;
        return node.operator === "-" ? -number : number;
      }
      case "binary": {
        const left = this.evaluate(node.left);
        const { operator } = node;
        if (operator === "&&") return truthy(left) ? this.evaluate(node.right) : left;
        if (operator === "||") return truthy(left) ? left : this.evaluate(node.right);
        const right = this.evaluate(node.right);
        if (["=", "==", "===", "!=", "!==", "<", "<=", ">", ">="].includes(operator)) {
          return compare(operator, left, right);
        }
        if (isMissing(left) || isMissing(right)) return MISSING;
        // 与 JS 一致：任一操作数为字符串时 `+` 做拼接，否则做数字相加。
        if (operator === "+" && (typeof left === "string" || typeof right === "string")) {
          return String(left) + String(right);
        }
        const a = toNumber(left);
        const b = toNumber(right);
        if (Number.isNaN(a) || Number.isNaN(b)) return MISSING;
        switch (operator) {
          case "+": return a + b;
          case "-": return a - b;
          case "*": return a * b;
          case "/": return b === 0 ? MISSING : a / b;
          case "%": return b === 0 ? MISSING : a % b;
          default: throw new ConditionError(`表达式语法错误：不支持的运算符 ${operator}`);
        }
      }
      case "ternary":
        return truthy(this.evaluate(node.test))
          ? this.evaluate(node.consequent)
          : this.evaluate(node.alternate);
    }
  }
}

/**
 * 求值条件表达式。语法错误、运行时异常都视为「不成立」，绝不向外抛出。
 * 调用方仍需使用 validateCondition 在建任务时把语法错误反馈给用户。
 */
export function evaluateCondition(source: string, context: ConditionContext): boolean {
  const trimmed = source.trim();
  if (!trimmed) return false;
  try {
    return truthy(new Evaluator(context).evaluate(parseExpression(trimmed)));
  } catch {
    return false;
  }
}
