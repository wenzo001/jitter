import type { RedirectMode, RequestOptions, RequestSpec } from "./types";

export class CurlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurlParseError";
  }
}

const SHORT_FLAGS = new Set(["I", "G", "k", "L"]);
const SHORT_MAPPED = new Set(["X", "H", "d", "b", "A", "e", "u", "U", "x", "r", "m"]);
const SHORT_NOOP = new Set([
  "s", "S", "i", "v", "O", "j", "4", "6", "Z", "f", "g", "N", "R", "J", "q", "M", "h", "V",
  "0", "1", "2", "3", "p",
]);
const SHORT_NOOP_WITH_VALUE = new Set(["o", "D", "w", "c", "C", "y", "Y", "z"]);
const SHORT_REJECT = new Set(["F", "T", "E", "n", "a", "B", "l", "Q", "P", "t", "K"]);

const LONG_FLAGS = new Set([
  "head",
  "get",
  "insecure",
  "no-insecure",
  "location",
  "no-location",
  "location-trusted",
]);
const LONG_MAPPED = new Set([
  "request",
  "header",
  "data",
  "data-raw",
  "data-binary",
  "data-ascii",
  "data-urlencode",
  "json",
  "url",
  "url-query",
  "cookie",
  "user-agent",
  "referer",
  "user",
  "oauth2-bearer",
  "range",
  "max-time",
  "connect-timeout",
  "proxy",
  "proxy-user",
]);
const LONG_NOOP = new Set([
  "silent",
  "show-error",
  "include",
  "verbose",
  "compressed",
  "globoff",
  "fail",
  "fail-with-body",
  "no-keepalive",
  "keepalive",
  "http0.9",
  "http1.0",
  "http1.1",
  "http2",
  "http2-prior-knowledge",
  "http3",
  "ipv4",
  "ipv6",
  "tlsv1.0",
  "tlsv1.1",
  "tlsv1.2",
  "tlsv1.3",
  "retry-connrefused",
  "retry-all-errors",
  "disable",
  "progress-bar",
  "no-progress-meter",
  "styled-output",
  "no-styled-output",
  "raw",
  "tr-encoding",
  "tcp-nodelay",
  "no-tcp-nodelay",
  "buffer",
  "no-buffer",
  "parallel",
  "parallel-immediate",
  "remote-name",
  "remote-time",
  "remote-header-name",
  "junk-session-cookies",
  "create-dirs",
  "no-sessionid",
  "ssl-no-revoke",
  "cert-status",
  "no-cert-status",
  "compressed-ssh",
  "no-alpn",
  "no-npn",
  "basic",
  "fail-early",
  "clobber",
  "no-clobber",
]);
const LONG_NOOP_WITH_VALUE = new Set([
  "output",
  "dump-header",
  "write-out",
  "cookie-jar",
  "continue-at",
  "retry",
  "retry-delay",
  "retry-max-time",
  "max-redirs",
  "keepalive-time",
  "stderr",
  "trace",
  "trace-ascii",
  "trace-config",
  "tls-max",
  "ciphers",
  "time-cond",
  "speed-time",
  "speed-limit",
  "limit-rate",
  "max-filesize",
  "output-dir",
  "create-file-mode",
  "happy-eyeballs-timeout-ms",
  "parallel-max",
  "libcurl",
  "rate",
]);
const LONG_REJECT = new Set([
  "form",
  "form-string",
  "upload-file",
  "cacert",
  "capath",
  "cert",
  "key",
  "pass",
  "cert-type",
  "key-type",
  "crlfile",
  "resolve",
  "connect-to",
  "interface",
  "unix-socket",
  "abstract-unix-socket",
  "config",
  "netrc",
  "netrc-file",
  "netrc-optional",
  "digest",
  "ntlm",
  "ntlm-wb",
  "negotiate",
  "anyauth",
  "proxy-anyauth",
  "proxy-digest",
  "proxy-ntlm",
  "proxy-negotiate",
  "proxy-cert",
  "proxy-key",
  "proxy-cacert",
  "proxy-capath",
  "proxy-pass",
  "proxy-cert-type",
  "proxy-key-type",
  "proxy-crlfile",
  "noproxy",
  "request-target",
  "next",
  "dns-interface",
  "dns-ipv4-addr",
  "dns-ipv6-addr",
  "dns-servers",
  "doh-url",
  "doh-insecure",
  "hostpubmd5",
  "hostpubsha256",
  "engine",
  "egd-file",
  "random-file",
  "aws-sigv4",
  "mail-from",
  "mail-rcpt",
  "mail-auth",
  "telnet-option",
  "ftp-account",
  "ftp-alternative-to-user",
  "ftp-create-dirs",
  "ftp-method",
  "ftp-pasv",
  "ftp-port",
  "ftp-pret",
  "ftp-skip-pasv-ip",
  "ftp-ssl-ccc",
  "ftp-ssl-ccc-mode",
  "ftp-ssl-control",
  "socks4",
  "socks4a",
  "socks5",
  "socks5-gssapi-nec",
  "socks5-gssapi-service",
  "socks5-hostname",
  "preproxy",
  "proto",
  "proto-redir",
  "haproxy-protocol",
  "proxy-header",
  "proxy-http2",
]);

const REJECT_MESSAGES: Record<string, string> = {
  "-F": "不支持 multipart/form-data，请改用 --data-binary/--json 或结构化表单",
  "--form": "不支持 multipart/form-data，请改用 --data-binary/--json 或结构化表单",
  "--form-string": "不支持 multipart/form-data，请改用 --data-binary/--json 或结构化表单",
  "-T": "不支持从文件上传",
  "--upload-file": "不支持从文件上传",
  "-K": "不支持从 curl 配置文件读取",
  "--config": "不支持从 curl 配置文件读取",
  "-E": "不支持自定义 TLS 证书文件",
  "--cacert": "不支持自定义 TLS 证书文件",
  "--capath": "不支持自定义 TLS 证书目录",
  "--cert": "不支持自定义 TLS 证书文件",
  "--key": "不支持自定义 TLS 私钥文件",
  "--resolve": "不支持自定义 DNS 解析",
  "--connect-to": "不支持自定义连接目标",
  "--interface": "不支持指定网络接口",
  "--unix-socket": "不支持 Unix socket",
  "--digest": "只支持 Basic 认证（-u/--user）",
  "--ntlm": "只支持 Basic 认证（-u/--user）",
  "--negotiate": "只支持 Basic 认证（-u/--user）",
  "--noproxy": "暂不支持 --noproxy",
};

const SINGLE_VALUE_HEADERS = new Set([
  "authorization",
  "user-agent",
  "referer",
  "content-type",
  "range",
  "proxy-authorization",
  "host",
]);

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
  const trimmed = line.trim();
  const index = trimmed.indexOf(":");
  if (index === -1 && trimmed.endsWith(";")) {
    const name = trimmed.slice(0, -1).trim();
    if (name) {
      // curl's "Name;" idiom sends an empty header.
      return { name, value: "" };
    }
  }
  if (index <= 0) {
    throw new CurlParseError(`Header 格式无效: ${line}（应为 Name: value）`);
  }
  const name = trimmed.slice(0, index).trim();
  const value = trimmed.slice(index + 1).trim();
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
  if (!existing) {
    map.set(key, { ...entry });
    return;
  }
  if (SINGLE_VALUE_HEADERS.has(key)) {
    existing.name = entry.name;
    existing.value = entry.value;
    return;
  }
  if (key === "cookie") {
    existing.value = existing.value ? `${existing.value}; ${entry.value}` : entry.value;
    return;
  }
  existing.value = existing.value ? `${existing.value}, ${entry.value}` : entry.value;
}

function setHeader(
  map: Map<string, HeaderEntry>,
  name: string,
  value: string,
): void {
  map.set(name.toLowerCase(), { name, value });
}

function basicAuth(value: string): string {
  const index = value.indexOf(":");
  const user = index === -1 ? value : value.slice(0, index);
  const pass = index === -1 ? "" : value.slice(index + 1);
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

function parseSeconds(value: string, flag: string): number {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new CurlParseError(`参数 ${flag} 的取值必须是非负秒数`);
  }
  const milliseconds = Math.round(Number(trimmed) * 1000);
  if (milliseconds > 24 * 60 * 60 * 1000) {
    throw new CurlParseError(`参数 ${flag} 不能超过 24 小时`);
  }
  return milliseconds;
}

function encodeFormValue(value: string): string {
  if (value.startsWith("@") || /^[^=]+@/.test(value)) {
    throw new CurlParseError("不支持从文件读取 --data-urlencode 内容");
  }
  const index = value.indexOf("=");
  if (index > 0) {
    return `${value.slice(0, index)}=${encodeURIComponent(value.slice(index + 1))}`;
  }
  if (index === 0) {
    return encodeURIComponent(value.slice(1));
  }
  return encodeURIComponent(value);
}

function urlQueryValue(value: string): string {
  if (value.startsWith("@") || value.startsWith("+@")) {
    throw new CurlParseError("不支持从文件读取 --url-query 内容");
  }
  if (value.startsWith("+")) {
    const rest = value.slice(1);
    const index = rest.indexOf("=");
    if (index > 0) {
      return `${rest.slice(0, index)}=${encodeURIComponent(rest.slice(index + 1))}`;
    }
    if (index === 0) {
      return encodeURIComponent(rest.slice(1));
    }
    return encodeURIComponent(rest);
  }
  return value;
}

function appendQuery(url: string, query: string): string {
  if (!query) return url;
  const hash = url.indexOf("#");
  const base = hash === -1 ? url : url.slice(0, hash);
  const fragment = hash === -1 ? "" : url.slice(hash);
  const separator = base.includes("?")
    ? base.endsWith("?") || base.endsWith("&")
      ? ""
      : "&"
    : "?";
  return `${base}${separator}${query}${fragment}`;
}

interface ValidatedProxy {
  url: string;
  authorization?: string;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function validateProxy(value: string): ValidatedProxy {
  const trimmed = value.trim();
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new CurlParseError(`代理地址无效: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CurlParseError(`代理协议只支持 http/https: ${value}`);
  }
  let authorization: string | undefined;
  if (url.username !== "" || url.password !== "") {
    authorization = basicAuth(
      `${safeDecode(url.username)}:${safeDecode(url.password)}`,
    );
    url.username = "";
    url.password = "";
  }
  return {
    url: url.toString(),
    ...(authorization === undefined ? {} : { authorization }),
  };
}

function rejectFlag(flag: string): CurlParseError {
  const reason = REJECT_MESSAGES[flag];
  return new CurlParseError(
    reason ? `不支持的 curl 参数: ${flag}（${reason}）` : `不支持的 curl 参数: ${flag}`,
  );
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
  getMode: boolean,
  jsonMode: boolean,
  urlQueries: string[],
  options: RequestOptions,
): RequestSpec {
  if (getMode && jsonMode) {
    throw new CurlParseError("暂不支持 -G/--get 与 --json 组合");
  }

  const queryParts = [...urlQueries];
  if (getMode && hasData) {
    const data = dataParts.join("&");
    if (data !== "") queryParts.push(data);
  }
  const finalUrl =
    queryParts.length > 0 ? appendQuery(rawUrl, queryParts.join("&")) : rawUrl;

  let body: string | null = null;
  if (!getMode && hasData) {
    body = dataParts.join("&");
    if (jsonMode) {
      if (!headerMap.has("content-type")) {
        addHeader(headerMap, {
          name: "Content-Type",
          value: "application/json",
        });
      }
      if (!headerMap.has("accept")) {
        addHeader(headerMap, { name: "Accept", value: "application/json" });
      }
    } else if (!headerMap.has("content-type")) {
      addHeader(headerMap, {
        name: "Content-Type",
        value: "application/x-www-form-urlencoded",
      });
    }
  }

  const method =
    rawMethod === null
      ? getMode
        ? "GET"
        : hasData
          ? "POST"
          : "GET"
      : validateMethod(rawMethod);

  if ((method === "GET" || method === "HEAD") && body !== null) {
    throw new CurlParseError(`${method} 请求不能携带请求体`);
  }

  return {
    url: validateUrl(finalUrl),
    method,
    headers: headersToObject(headerMap),
    body,
    ...(Object.keys(options).length > 0 ? { options } : {}),
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
  let getMode = false;
  let insecure: boolean | null = null;
  let redirect: RedirectMode | null = null;
  let maxTimeMs: number | null = null;
  let connectTimeoutMs: number | null = null;
  let proxy: string | null = null;
  let proxyAuthorization: string | null = null;
  let proxyUser: string | null = null;
  let jsonMode = false;
  const explicitHeaders = new Set<string>();
  const headerMap = new Map<string, HeaderEntry>();
  const dataParts: string[] = [];
  const cookieParts: string[] = [];
  const urlQueries: string[] = [];
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

  const setConvenienceHeader = (name: string, value: string): void => {
    const key = name.toLowerCase();
    if (explicitHeaders.has(key)) return;
    setHeader(headerMap, name, value);
  };

  const applyFlag = (flag: string): void => {
    if (flag === "-I" || flag === "--head") {
      method = "HEAD";
      return;
    }
    if (flag === "-G" || flag === "--get") {
      getMode = true;
      return;
    }
    if (flag === "-k" || flag === "--insecure") {
      insecure = true;
      return;
    }
    if (flag === "--no-insecure") {
      insecure = false;
      return;
    }
    if (flag === "-L" || flag === "--location" || flag === "--location-trusted") {
      redirect = "follow";
      return;
    }
    if (flag === "--no-location") {
      redirect = "manual";
      return;
    }
    throw new CurlParseError(`不支持的 curl 参数: ${flag}`);
  };

  const applyValue = (flag: string, value: string): void => {
    if (flag === "-X" || flag === "--request") {
      method = value;
      return;
    }
    if (flag === "-H" || flag === "--header") {
      const entry = parseHeaderLine(value);
      addHeader(headerMap, entry);
      explicitHeaders.add(entry.name.toLowerCase());
      return;
    }
    if (flag === "-b" || flag === "--cookie") {
      const cookie = value.trim();
      if (cookie === "") return;
      if (!cookie.includes("=")) {
        throw new CurlParseError(
          "不支持从文件读取 cookie；-b/--cookie 请直接传入 name=value 形式的 cookie 内容",
        );
      }
      cookieParts.push(cookie);
      return;
    }
    if (flag === "-A" || flag === "--user-agent") {
      setConvenienceHeader("User-Agent", value);
      return;
    }
    if (flag === "-e" || flag === "--referer") {
      setConvenienceHeader("Referer", value);
      return;
    }
    if (flag === "-u" || flag === "--user") {
      setConvenienceHeader("Authorization", basicAuth(value));
      return;
    }
    if (flag === "--oauth2-bearer") {
      setConvenienceHeader("Authorization", `Bearer ${value}`);
      return;
    }
    if (flag === "-U" || flag === "--proxy-user") {
      proxyUser = value;
      return;
    }
    if (flag === "-x" || flag === "--proxy") {
      const validated = validateProxy(value);
      proxy = validated.url;
      if (validated.authorization) {
        proxyAuthorization = validated.authorization;
      }
      return;
    }
    if (flag === "-r" || flag === "--range") {
      setConvenienceHeader("Range", value);
      return;
    }
    if (flag === "-m" || flag === "--max-time") {
      maxTimeMs = parseSeconds(value, flag);
      return;
    }
    if (flag === "--connect-timeout") {
      connectTimeoutMs = parseSeconds(value, flag);
      return;
    }
    if (flag === "--data-urlencode") {
      dataParts.push(encodeFormValue(value));
      hasData = true;
      return;
    }
    if (flag === "--json") {
      if (value.startsWith("@")) {
        throw new CurlParseError("不支持从文件读取 --json 内容");
      }
      dataParts.push(value);
      hasData = true;
      jsonMode = true;
      return;
    }
    if (flag === "--url-query") {
      urlQueries.push(urlQueryValue(value));
      return;
    }
    if (flag === "--url") {
      if (url !== null) {
        throw new CurlParseError("只支持一个 URL");
      }
      url = value;
      return;
    }
    if (flag === "--data-raw") {
      dataParts.push(value);
      hasData = true;
      return;
    }
    if (
      flag === "-d" ||
      flag === "--data" ||
      flag === "--data-binary" ||
      flag === "--data-ascii"
    ) {
      if (value.startsWith("@")) {
        throw new CurlParseError("不支持从文件读取请求体（以 @ 开头），请直接粘贴内容");
      }
      dataParts.push(value);
      hasData = true;
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
      if (LONG_FLAGS.has(name)) {
        if (inline !== null) {
          throw new CurlParseError(`参数 --${name} 不接受取值`);
        }
        applyFlag(`--${name}`);
        i += 1;
        continue;
      }
      if (LONG_MAPPED.has(name)) {
        const value = inline ?? takeNext(`--${name}`);
        applyValue(`--${name}`, value);
        i += 1;
        continue;
      }
      if (LONG_NOOP.has(name)) {
        if (inline !== null) {
          throw new CurlParseError(`参数 --${name} 不接受取值`);
        }
        i += 1;
        continue;
      }
      if (LONG_NOOP_WITH_VALUE.has(name)) {
        if (inline === null) {
          takeNext(`--${name}`);
        }
        i += 1;
        continue;
      }
      if (LONG_REJECT.has(name)) {
        throw rejectFlag(`--${name}`);
      }
      throw new CurlParseError(`不支持的 curl 参数: --${name}`);
    }

    if (token.startsWith("-") && token !== "-") {
      let cursor = 1;
      while (cursor < token.length) {
        const flag = token[cursor]!;
        if (SHORT_FLAGS.has(flag)) {
          applyFlag(`-${flag}`);
          cursor += 1;
          continue;
        }
        if (SHORT_MAPPED.has(flag)) {
          const attached = token.slice(cursor + 1);
          const value = attached.length > 0 ? attached : takeNext(`-${flag}`);
          applyValue(`-${flag}`, value);
          break;
        }
        if (SHORT_NOOP.has(flag)) {
          cursor += 1;
          continue;
        }
        if (SHORT_NOOP_WITH_VALUE.has(flag)) {
          const attached = token.slice(cursor + 1);
          if (attached.length === 0) {
            takeNext(`-${flag}`);
          }
          break;
        }
        if (SHORT_REJECT.has(flag)) {
          throw rejectFlag(`-${flag}`);
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
  if (cookieParts.length > 0) {
    const cookie = cookieParts.join("; ");
    const existing = headerMap.get("cookie");
    if (existing) {
      existing.value = existing.value ? `${existing.value}; ${cookie}` : cookie;
    } else {
      headerMap.set("cookie", { name: "Cookie", value: cookie });
    }
  }

  const options: RequestOptions = {};
  if (insecure !== null) options.insecure = insecure;
  if (redirect !== null) options.redirect = redirect;
  const timeoutMs = maxTimeMs ?? connectTimeoutMs;
  if (timeoutMs !== null) options.timeoutMs = timeoutMs;
  if (proxyUser !== null) {
    if (proxy === null) {
      throw new CurlParseError(
        "使用 -U/--proxy-user 时必须同时提供 -x/--proxy（环境代理暂不支持自定义代理认证）",
      );
    }
    options.proxyAuthorization = basicAuth(proxyUser);
  } else if (proxyAuthorization !== null) {
    options.proxyAuthorization = proxyAuthorization;
  }
  if (proxy !== null) options.proxy = proxy;

  return assemble(
    url,
    method,
    headerMap,
    dataParts,
    hasData,
    getMode,
    jsonMode,
    urlQueries,
    options,
  );
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
