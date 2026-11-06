import type { RequestSpec } from "./types";

export class CurlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurlParseError";
  }
}

const SHORT_NOOP = new Set(["s", "S", "i", "v", "L"]);
const LONG_NOOP = new Set(["silent", "show-error", "include", "verbose", "compressed", "location"]);
const SHORT_WITH_VALUE = new Set(["X", "H", "d"]);
const LONG_WITH_VALUE = new Set(["request", "header", "data", "data-raw", "data-binary", "data-ascii", "url"]);

interface HeaderEntry {
  name: string;
  value: string;
}

/**
 * Shell-like tokenizer: single quotes are literal, double quotes support
 * backslash escapes, unquoted backslashes escape one character, and a
 * backslash-newline is a line continuation. No expansion is performed.
 */
export function tokenizeCurl(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  let i = 0;

  const push = () => {
    if (started) {
      tokens.push(current);
      current = "";
      started = false;
    }
  };

  while (i < input.length) {
    const ch = input[i]!;

    if (quote === null) {
      if (ch === "\\") {
        const next = input[i + 1];
        if (next === undefined) {
          current += "\\";
          started = true;
          i += 1;
        } else if (next === "\n") {
          i += 2;
        } else if (next === "\r" && input[i + 2] === "\n") {
          i += 3;
        } else {
          current += next;
          started = true;
          i += 2;
        }
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        started = true;
        i += 1;
        continue;
      }
      if (/\s/.test(ch)) {
        push();
        i += 1;
        continue;
      }
      current += ch;
      started = true;
      i += 1;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
        started = true;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      quote = null;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      const next = input[i + 1];
      if (next === undefined) {
        current += "\\";
        started = true;
        i += 1;
      } else if (next === "\n") {
        i += 2;
      } else if (next === "\r" && input[i + 2] === "\n") {
        i += 3;
      } else if (next === '"' || next === "\\" || next === "$" || next === "`") {
        current += next;
        started = true;
        i += 2;
      } else {
        current += "\\" + next;
        started = true;
        i += 2;
      }
      continue;
    }
    current += ch;
    started = true;
    i += 1;
  }

  if (quote !== null) {
    throw new CurlParseError("curl 命令中存在未闭合的引号");
  }
  push();
  return tokens;
}

function validateUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CurlParseError(`URL 无效: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CurlParseError("URL 协议只支持 http/https");
  }
  return raw;
}

function validateMethod(raw: string): string {
  const method = raw.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(method)) {
    throw new CurlParseError(`请求方法无效: ${raw}`);
  }
  if (method === "CONNECT" || method === "TRACE" || method === "TRACK") {
    throw new CurlParseError(`不支持请求方法: ${method}`);
  }
  return method;
}

function parseHeaderLine(line: string): HeaderEntry {
  const index = line.indexOf(":");
  if (index <= 0) {
    throw new CurlParseError(`Header 格式无效: ${line}（应为 Name: value）`);
  }
  const name = line.slice(0, index).trim();
  const value = line.slice(index + 1).trim();
  if (!name) {
    throw new CurlParseError(`Header 格式无效: ${line}（应为 Name: value）`);
  }
  return { name, value };
}

function addHeader(
  map: Map<string, HeaderEntry>,
  entry: HeaderEntry,
): void {
  const key = entry.name.toLowerCase();
  const existing = map.get(key);
  if (existing) {
    existing.value = existing.value ? `${existing.value}, ${entry.value}` : entry.value;
  } else {
    map.set(key, { ...entry });
  }
}

function headersToObject(map: Map<string, HeaderEntry>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of map.values()) {
    result[entry.name] = entry.value;
  }
  try {
    // Constructing Headers is the authoritative validation for fetch.
    new Headers(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CurlParseError(`Header 无效: ${message}`);
  }
  return result;
}

function assemble(
  rawUrl: string,
  rawMethod: string | null,
  headerMap: Map<string, HeaderEntry>,
  dataParts: string[],
  hasData: boolean,
): RequestSpec {
  const method = rawMethod === null ? (hasData ? "POST" : "GET") : validateMethod(rawMethod);
  if ((method === "GET" || method === "HEAD") && hasData) {
    throw new CurlParseError(`${method} 请求不能携带请求体`);
  }
  if (hasData && !headerMap.has("content-type")) {
    addHeader(headerMap, {
      name: "Content-Type",
      value: "application/x-www-form-urlencoded",
    });
  }
  return {
    url: validateUrl(rawUrl),
    method,
    headers: headersToObject(headerMap),
    body: hasData ? dataParts.join("&") : null,
  };
}

export function parseCurlCommand(input: string): RequestSpec {
  const tokens = tokenizeCurl(input.trim());
  if (tokens.length === 0) {
    throw new CurlParseError("curl 命令为空");
  }
  if (tokens[0] === "curl") {
    tokens.shift();
  }

  let url: string | null = null;
  let method: string | null = null;
  const headerMap = new Map<string, HeaderEntry>();
  const dataParts: string[] = [];
  let hasData = false;
  let endOfOptions = false;
  let i = 0;

  const takeNext = (flag: string): string => {
    const value = tokens[i + 1];
    if (value === undefined) {
      throw new CurlParseError(`参数 ${flag} 缺少取值`);
    }
    i += 1;
    return value;
  };

  const applyValue = (flag: string, value: string): void => {
    if (flag === "-X" || flag === "--request") {
      method = value;
      return;
    }
    if (flag === "-H" || flag === "--header") {
      addHeader(headerMap, parseHeaderLine(value));
      return;
    }
    if (flag.startsWith("-d") || flag.startsWith("--data")) {
      const rejectsFileBody =
        flag === "-d" ||
        flag === "--data" ||
        flag === "--data-binary" ||
        flag === "--data-ascii";
      if (rejectsFileBody && value.startsWith("@")) {
        throw new CurlParseError("不支持从文件读取请求体（以 @ 开头），请直接粘贴内容");
      }
      dataParts.push(value);
      hasData = true;
      return;
    }
    if (flag === "--url") {
      if (url !== null) {
        throw new CurlParseError("只支持一个 URL");
      }
      url = value;
      return;
    }
    throw new CurlParseError(`不支持的 curl 参数: ${flag}`);
  };

  while (i < tokens.length) {
    const token = tokens[i]!;

    if (endOfOptions) {
      if (url !== null) {
        throw new CurlParseError("只支持一个 URL");
      }
      url = token;
      i += 1;
      continue;
    }

    if (token === "--") {
      endOfOptions = true;
      i += 1;
      continue;
    }

    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
      const inline = equals === -1 ? null : token.slice(equals + 1);
      if (LONG_NOOP.has(name)) {
        if (inline !== null) {
          throw new CurlParseError(`参数 --${name} 不接受取值`);
        }
        i += 1;
        continue;
      }
      if (LONG_WITH_VALUE.has(name)) {
        const value = inline ?? takeNext(`--${name}`);
        applyValue(`--${name}`, value);
        i += 1;
        continue;
      }
      throw new CurlParseError(`不支持的 curl 参数: --${name}`);
    }

    if (token.startsWith("-") && token !== "-") {
      let cursor = 1;
      while (cursor < token.length) {
        const flag = token[cursor]!;
        if (SHORT_NOOP.has(flag)) {
          cursor += 1;
          continue;
        }
        if (SHORT_WITH_VALUE.has(flag)) {
          const attached = token.slice(cursor + 1);
          const value = attached.length > 0 ? attached : takeNext(`-${flag}`);
          applyValue(`-${flag}`, value);
          break;
        }
        throw new CurlParseError(`不支持的 curl 参数: -${flag}`);
      }
      i += 1;
      continue;
    }

    if (url !== null) {
      throw new CurlParseError("只支持一个 URL");
    }
    url = token;
    i += 1;
  }

  if (url === null) {
    throw new CurlParseError("未找到 URL");
  }
  return assemble(url, method, headerMap, dataParts, hasData);
}

export interface StructuredRequestInput {
  url: string;
  method?: string | null;
  headers?: string | Record<string, string> | null;
  body?: string | null;
}

export function normalizeStructured(input: StructuredRequestInput): RequestSpec {
  const rawUrl = (input.url ?? "").trim();
  if (!rawUrl) {
    throw new CurlParseError("请填写 URL");
  }

  const headerMap = new Map<string, HeaderEntry>();
  if (typeof input.headers === "string") {
    for (const line of input.headers.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      addHeader(headerMap, parseHeaderLine(trimmed));
    }
  } else if (input.headers) {
    for (const [name, value] of Object.entries(input.headers)) {
      if (typeof value !== "string") {
        throw new CurlParseError(`Header ${name} 的值必须是字符串`);
      }
      addHeader(headerMap, { name, value });
    }
  }

  const method = validateMethod(input.method?.trim() || "GET");
  const body = input.body === undefined || input.body === null ? null : String(input.body);
  if ((method === "GET" || method === "HEAD") && body !== null) {
    throw new CurlParseError(`${method} 请求不能携带请求体`);
  }

  return {
    url: validateUrl(rawUrl),
    method,
    headers: headersToObject(headerMap),
    body,
  };
}
