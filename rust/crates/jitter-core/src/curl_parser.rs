//! shell 风格 tokenizer + 宽 curl 参数映射。
//!
//! 与 TypeScript 版（`src/curl-parser.ts`）行为一致：
//! - 单引号内全部字面量；双引号支持反斜杠转义；裸反斜杠转义一个字符；
//!   反斜杠-换行是续行。不做任何变量展开。
//! - 支持常用的数据/头/方法/代理参数，拒绝明确不支持的功能并给出中文说明。

use base64::Engine as _;
use http::header::{HeaderName, HeaderValue};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use crate::types::JsonMap;
use url::Url;

use serde_json::Value as Json;

use crate::types::{RedirectMode, RequestOptions, RequestSpec};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurlParseError(pub String);

impl std::fmt::Display for CurlParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CurlParseError {}

fn err<T>(message: impl Into<String>) -> Result<T, CurlParseError> {
    Err(CurlParseError(message.into()))
}

const SHORT_FLAGS: [&str; 4] = ["I", "G", "k", "L"];
const SHORT_MAPPED: [&str; 11] = ["X", "H", "d", "b", "A", "e", "u", "U", "x", "r", "m"];
const SHORT_NOOP: [&str; 23] = [
    "s", "S", "i", "v", "O", "j", "4", "6", "Z", "f", "g", "N", "R", "J", "q", "M", "h", "V",
    "0", "1", "2", "3", "p",
];
const SHORT_NOOP_WITH_VALUE: [&str; 8] = ["o", "D", "w", "c", "C", "y", "Y", "z"];
const SHORT_REJECT: [&str; 11] = ["F", "T", "E", "n", "a", "B", "l", "Q", "P", "t", "K"];

const LONG_FLAGS: [&str; 8] = [
    "head",
    "get",
    "insecure",
    "no-insecure",
    "location",
    "no-location",
    "location-trusted",
    // curl 8.x 新名：与 --location 等价，跟随重定向。
    "follow",
];
const LONG_MAPPED: [&str; 23] = [
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
    // 限制可用协议；只允许 http/https，其余协议报错。
    // curl 里 --proto 是「只允许这些协议」、--proto-redir 是「重定向只允许这些协议」、
    // --proto-default 是「URL 缺协议时用它」，三者语义并不等价，这里统一近似成
    // 「只允许 http/https」的白名单，见 validate_protocol_list 的说明。
    "proto",
    "proto-redir",
    "proto-default",
];
const LONG_NOOP: [&str; 94] = [
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
    // 以下参数只影响 curl 的本地行为（输出、传输细节、TLS 细节、诊断），
    // 不会改变我们发出的 http/https 请求，直接忽略即可。
    "append",
    "crlf",
    "disallow-username-in-url",
    "doh-cert-status",
    "false-start",
    "form-escape",
    "http0",
    "http1",
    "http3-only",
    "ignore-content-length",
    "manual",
    "mptcp",
    "out-null",
    // 本程序原样把 URL 交给底层请求，不会压缩路径里的 ..，等价于 curl 的 --path-as-is。
    "path-as-is",
    "proxy-basic",
    "proxy-http3",
    "proxy-ssl-allow-beast",
    "proxy-ssl-auto-client-cert",
    "proxy-tlsv1",
    "proxytunnel",
    "remote-name-all",
    "remove-on-error",
    "show-headers",
    "skip-existing",
    "ssl",
    "ssl-allow-beast",
    "ssl-auto-client-cert",
    "ssl-reqd",
    "ssl-revoke-best-effort",
    "sslv2",
    "sslv3",
    "suppress-connect-headers",
    "tcp-fastopen",
    "tls-earlydata",
    "tlsv1",
    "trace-ids",
    "trace-time",
    "use-ascii",
    "xattr",
    // --help/--version 只是打印信息后退出，粘贴进任务表单时忽略即可。
    "help",
    "version",
];
const LONG_NOOP_WITH_VALUE: [&str; 54] = [
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
    // 以下参数带值但只影响 curl 本地行为：把值吃掉后忽略。
    "alt-svc",
    "curves",
    "dump-ca-embed",
    "etag-save",
    "expect100-timeout",
    "haproxy-clientip",
    "ip-tos",
    "keepalive-cnt",
    "local-port",
    "parallel-max-host",
    "proxy-ciphers",
    "proxy-service-name",
    "proxy-tls13-ciphers",
    "proxy-tlsauthtype",
    "proxy-tlspassword",
    "proxy-tlsuser",
    "pubkey",
    "quote",
    "service-name",
    "sigalgs",
    "ssl-sessions",
    "tls13-ciphers",
    "tlsauthtype",
    "tlspassword",
    "tlsuser",
    "upload-flags",
    "vlan-priority",
];
const LONG_REJECT: [&str; 107] = [
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
    "haproxy-protocol",
    "proxy-header",
    "proxy-http2",
    // 以下功能会改变请求或连接语义，但本程序做不到，明确报错并说明原因。
    "ca-native",
    "delegation",
    "disable-eprt",
    "disable-epsv",
    "ech",
    "etag-compare",
    "hsts",
    "ipfs-gateway",
    "knownhosts",
    "krb",
    "list-only",
    "login-options",
    "mail-rcpt-allowfails",
    "metalink",
    "pinnedpubkey",
    "post301",
    "post302",
    "post303",
    "proxy-ca-native",
    "proxy-insecure",
    "proxy-pinnedpubkey",
    "proxy1",
    "proxy1.0",
    "sasl-authzid",
    "sasl-ir",
    "socks5-basic",
    "socks5-gssapi",
    "tftp-blksize",
    "tftp-no-options",
    "variable",
];

fn reject_message(flag: &str) -> Option<&'static str> {
    Some(match flag {
        "-F" | "--form" | "--form-string" => {
            "不支持 multipart/form-data，请改用 --data-binary/--json 或结构化表单"
        }
        "-T" | "--upload-file" => "不支持从文件上传",
        "-K" | "--config" => "不支持从 curl 配置文件读取",
        "-E" | "--cacert" => "不支持自定义 TLS 证书文件",
        "--capath" => "不支持自定义 TLS 证书目录",
        "--cert" => "不支持自定义 TLS 证书文件",
        "--key" => "不支持自定义 TLS 私钥文件",
        "--resolve" => "不支持自定义 DNS 解析",
        "--connect-to" => "不支持自定义连接目标",
        "--interface" => "不支持指定网络接口",
        "--unix-socket" | "--abstract-unix-socket" => "不支持 Unix socket",
        "--digest" | "--ntlm" | "--negotiate" => "只支持 Basic 认证（-u/--user）",
        "--noproxy" => "暂不支持 --noproxy",
        "--ca-native" | "--proxy-ca-native" => "本程序使用内置 CA 证书，不支持系统证书库",
        "--delegation" => "暂不支持 GSS-API 委派",
        "--ech" => "暂不支持 Encrypted Client Hello",
        "--hsts" => "暂不支持 HSTS",
        "--ipfs-gateway" => "暂不支持 IPFS 网关",
        "--knownhosts" => "暂不支持 knownhosts 主机密钥校验",
        "--krb" => "暂不支持 Kerberos 认证",
        "--list-only" => "暂不支持列表模式",
        "--login-options" => "暂不支持登录选项",
        "--mail-rcpt-allowfails" => "暂不支持邮件相关选项",
        "--metalink" => "暂不支持 metalink",
        "--sasl-authzid" => "暂不支持 SASL 认证身份",
        "--sasl-ir" => "暂不支持 SASL 初始响应",
        "--disable-eprt" | "--disable-epsv" | "--tftp-blksize" | "--tftp-no-options" => {
            "本程序只发 HTTP 请求"
        }
        "--etag-compare" => "不支持基于 ETag 的条件请求",
        "--pinnedpubkey" | "--proxy-pinnedpubkey" => "不支持证书公钥固定",
        "--post301" | "--post302" | "--post303" => "不支持重定向后改写请求方法",
        "--proxy1" | "--proxy1.0" => "不支持为 HTTP/1.0 请求单独指定代理",
        "--proxy-insecure" => "不支持单独放宽代理的证书校验",
        "--socks5-basic" | "--socks5-gssapi" => "本程序不支持 SOCKS 代理",
        "--variable" => "不支持 curl 的变量替换",
        _ => return None,
    })
}

fn reject_flag(flag: &str) -> CurlParseError {
    match reject_message(flag) {
        Some(reason) => CurlParseError(format!("不支持的 curl 参数: {flag}（{reason}）")),
        None => CurlParseError(format!("不支持的 curl 参数: {flag}")),
    }
}

const SINGLE_VALUE_HEADERS: [&str; 7] = [
    "authorization",
    "user-agent",
    "referer",
    "content-type",
    "range",
    "proxy-authorization",
    "host",
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct HeaderEntry {
    name: String,
    value: String,
}

/// 保持插入顺序的头集合（JS 的 `Map` 是有序的）。
#[derive(Debug, Clone, Default)]
struct HeaderMap {
    entries: Vec<HeaderEntry>,
}

impl HeaderMap {
    fn key(name: &str) -> String {
        name.to_lowercase()
    }

    fn index_of(&self, key: &str) -> Option<usize> {
        self.entries.iter().position(|entry| HeaderMap::key(&entry.name) == key)
    }

    fn get_mut(&mut self, key: &str) -> Option<&mut HeaderEntry> {
        let index = self.index_of(key)?;
        self.entries.get_mut(index)
    }

    fn has(&self, key: &str) -> bool {
        self.index_of(key).is_some()
    }

    fn set(&mut self, name: &str, value: String) {
        let key = HeaderMap::key(name);
        match self.index_of(&key) {
            Some(index) => self.entries[index] = HeaderEntry {
                name: name.to_string(),
                value,
            },
            None => self.entries.push(HeaderEntry {
                name: name.to_string(),
                value,
            }),
        }
    }

    fn add(&mut self, entry: HeaderEntry) {
        let key = HeaderMap::key(&entry.name);
        match self.index_of(&key) {
            None => {
                self.entries.push(entry);
            }
            Some(index) => {
                let existing = &mut self.entries[index];
                if SINGLE_VALUE_HEADERS.contains(&key.as_str()) {
                    existing.name = entry.name;
                    existing.value = entry.value;
                    return;
                }
                if key == "cookie" {
                    existing.value = if existing.value.is_empty() {
                        entry.value
                    } else {
                        format!("{}; {}", existing.value, entry.value)
                    };
                    return;
                }
                existing.value = if existing.value.is_empty() {
                    entry.value
                } else {
                    format!("{}, {}", existing.value, entry.value)
                };
            }
        }
    }
}

/// JS 的 `encodeURIComponent`：不转义 `A-Z a-z 0-9 - _ . ! ~ * ' ( )`。
const ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'$')
    .add(b'%')
    .add(b'&')
    .add(b'+')
    .add(b',')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}')
    .add(b'\'');

fn encode_uri_component(value: &str) -> String {
    utf8_percent_encode(value, ENCODE_SET).to_string()
}

fn safe_decode(value: &str) -> String {
    percent_decode_str(value).decode_utf8_lossy().to_string()
}

/// Shell 风格的 tokenizer。
// `started` 在每次 push 后复位，编译器对宏展开里的最后一次赋值判定为「没被读到」
// （末尾那次 push!() 之后确实不再读），属于误报。
#[allow(unused_assignments)]
pub fn tokenize_curl(input: &str) -> Result<Vec<String>, CurlParseError> {
    let chars: Vec<char> = input.chars().collect();
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut quote: Option<char> = None;
    let mut i = 0usize;

    macro_rules! push {
        () => {
            if started {
                tokens.push(std::mem::take(&mut current));
                started = false;
            }
        };
    }

    while i < chars.len() {
        let ch = chars[i];

        if quote.is_none() {
            if ch == '\\' {
                match chars.get(i + 1) {
                    None => {
                        current.push('\\');
                        started = true;
                        i += 1;
                    }
                    Some('\n') => {
                        i += 2;
                    }
                    Some('\r') if chars.get(i + 2) == Some(&'\n') => {
                        i += 3;
                    }
                    Some(next) => {
                        current.push(*next);
                        started = true;
                        i += 2;
                    }
                }
                continue;
            }
            if ch == '\'' || ch == '"' {
                quote = Some(ch);
                started = true;
                i += 1;
                continue;
            }
            if ch.is_whitespace() {
                push!();
                i += 1;
                continue;
            }
            current.push(ch);
            started = true;
            i += 1;
            continue;
        }

        if quote == Some('\'') {
            if ch == '\'' {
                quote = None;
            } else {
                current.push(ch);
                started = true;
            }
            i += 1;
            continue;
        }

        // 双引号
        if ch == '"' {
            quote = None;
            i += 1;
            continue;
        }
        if ch == '\\' {
            match chars.get(i + 1) {
                None => {
                    current.push('\\');
                    started = true;
                    i += 1;
                }
                Some('\n') => {
                    i += 2;
                }
                Some('\r') if chars.get(i + 2) == Some(&'\n') => {
                    i += 3;
                }
                Some(next) if matches!(next, '"' | '\\' | '$' | '`') => {
                    current.push(*next);
                    started = true;
                    i += 2;
                }
                Some(next) => {
                    current.push('\\');
                    current.push(*next);
                    started = true;
                    i += 2;
                }
            }
            continue;
        }
        current.push(ch);
        started = true;
        i += 1;
    }

    if quote.is_some() {
        return err("curl 命令中存在未闭合的引号");
    }
    push!();
    Ok(tokens)
}

fn validate_url(raw: &str) -> Result<String, CurlParseError> {
    let parsed = Url::parse(raw).map_err(|_| CurlParseError(format!("URL 无效: {raw}")))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return err("URL 协议只支持 http/https");
    }
    Ok(raw.to_string())
}

fn validate_method(raw: &str) -> Result<String, CurlParseError> {
    let method = raw.trim().to_uppercase();
    let valid = !method.is_empty()
        && method
            .chars()
            .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit());
    if !valid {
        return err(format!("请求方法无效: {raw}"));
    }
    if method == "CONNECT" || method == "TRACE" || method == "TRACK" {
        return err(format!("不支持请求方法: {method}"));
    }
    Ok(method)
}

fn parse_header_line(line: &str) -> Result<HeaderEntry, CurlParseError> {
    let trimmed = line.trim();
    let index = trimmed.find(':');
    if index.is_none() && trimmed.ends_with(';') {
        let name = trimmed[..trimmed.len() - 1].trim();
        if !name.is_empty() {
            // curl 的 "Name;" 写法表示发送一个空值 header。
            return Ok(HeaderEntry {
                name: name.to_string(),
                value: String::new(),
            });
        }
    }
    let index = match index {
        Some(index) if index > 0 => index,
        _ => return err(format!("Header 格式无效: {line}（应为 Name: value）")),
    };
    let name = trimmed[..index].trim().to_string();
    let value = trimmed[index + 1..].trim().to_string();
    if name.is_empty() {
        return err(format!("Header 格式无效: {line}（应为 Name: value）"));
    }
    Ok(HeaderEntry { name, value })
}

fn basic_auth(value: &str) -> String {
    let (user, pass) = match value.find(':') {
        Some(index) => (&value[..index], &value[index + 1..]),
        None => (value, ""),
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"));
    format!("Basic {encoded}")
}

fn parse_seconds(value: &str, flag: &str) -> Result<i64, CurlParseError> {
    let trimmed = value.trim();
    let valid = !trimmed.is_empty()
        && trimmed
            .chars()
            .all(|ch| ch.is_ascii_digit() || ch == '.')
        && trimmed.matches('.').count() <= 1
        && !trimmed.starts_with('.')
        && !trimmed.ends_with('.');
    if !valid {
        return err(format!("参数 {flag} 的取值必须是非负秒数"));
    }
    let number: f64 = trimmed.parse().unwrap_or(f64::NAN);
    if number.is_nan() {
        return err(format!("参数 {flag} 的取值必须是非负秒数"));
    }
    let milliseconds = (number * 1000.0).round() as i64;
    if milliseconds > 24 * 60 * 60 * 1000 {
        return err(format!("参数 {flag} 不能超过 24 小时"));
    }
    Ok(milliseconds)
}

fn encode_form_value(value: &str) -> Result<String, CurlParseError> {
    // `value.startsWith("@") || /^[^=]+@/`：等号之前出现 @ 视为从文件读取。
    let at_before_equals = match value.find('=') {
        Some(index) => value[..index].contains('@'),
        None => value.contains('@'),
    };
    if value.starts_with('@') || at_before_equals {
        return err("不支持从文件读取 --data-urlencode 内容");
    }
    match value.find('=') {
        Some(index) if index > 0 => Ok(format!(
            "{}={}",
            &value[..index],
            encode_uri_component(&value[index + 1..])
        )),
        Some(_) => Ok(encode_uri_component(&value[1..])),
        None => Ok(encode_uri_component(value)),
    }
}

fn url_query_value(value: &str) -> Result<String, CurlParseError> {
    if value.starts_with('@') || value.starts_with("+@") {
        return err("不支持从文件读取 --url-query 内容");
    }
    if let Some(rest) = value.strip_prefix('+') {
        let index = rest.find('=');
        return match index {
            Some(index) if index > 0 => Ok(format!(
                "{}={}",
                &rest[..index],
                encode_uri_component(&rest[index + 1..])
            )),
            Some(_) => Ok(encode_uri_component(&rest[1..])),
            None => Ok(encode_uri_component(rest)),
        };
    }
    Ok(value.to_string())
}

fn append_query(url: &str, query: &str) -> String {
    if query.is_empty() {
        return url.to_string();
    }
    let hash = url.find('#');
    let (base, fragment) = match hash {
        Some(index) => (&url[..index], &url[index..]),
        None => (url, ""),
    };
    let separator = if base.contains('?') {
        if base.ends_with('?') || base.ends_with('&') {
            ""
        } else {
            "&"
        }
    } else {
        "?"
    };
    format!("{base}{separator}{query}{fragment}")
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct ValidatedProxy {
    url: String,
    authorization: Option<String>,
}

fn validate_proxy(value: &str) -> Result<ValidatedProxy, CurlParseError> {
    let trimmed = value.trim();
    // `/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//`：有协议前缀才原样使用，否则补 http://。
    fn has_scheme_prefix(value: &str) -> bool {
        let bytes = value.as_bytes();
        if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
            return false;
        }
        let mut index = 1;
        while index < bytes.len()
            && (bytes[index].is_ascii_alphanumeric()
                || bytes[index] == b'+'
                || bytes[index] == b'.'
                || bytes[index] == b'-')
        {
            index += 1;
        }
        index + 2 < bytes.len() && bytes[index] == b':' && bytes[index + 1] == b'/' && bytes[index + 2] == b'/'
    }
    let with_scheme = if has_scheme_prefix(trimmed) {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let mut url =
        Url::parse(&with_scheme).map_err(|_| CurlParseError(format!("代理地址无效: {value}")))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return err(format!("代理协议只支持 http/https: {value}"));
    }
    let mut authorization = None;
    if !url.username().is_empty() || url.password().is_some() {
        let password = url.password().unwrap_or("");
        authorization = Some(basic_auth(&format!(
            "{}:{}",
            safe_decode(url.username()),
            safe_decode(password)
        )));
        let _ = url.set_username("");
        let _ = url.set_password(None);
    }
    Ok(ValidatedProxy {
        url: url.to_string(),
        authorization,
    })
}

fn headers_to_object(map: &HeaderMap) -> Result<JsonMap, CurlParseError> {
    let mut result = JsonMap::new();
    for entry in &map.entries {
        result.insert(entry.name.clone(), Json::String(entry.value.clone()));
    }
    // 用 http crate 做权威校验（与 fetch 的 Headers 一致）。
    for entry in &map.entries {
        let name = HeaderName::try_from(entry.name.as_str())
            .map_err(|error| CurlParseError(format!("Header 无效: {}", header_message(&error))))?;
        let value = HeaderValue::try_from(entry.value.as_str())
            .map_err(|error| CurlParseError(format!("Header 无效: {}", header_value_message(&error))))?;
        let _ = (name, value);
    }
    Ok(result)
}

fn header_message(_error: &http::header::InvalidHeaderName) -> &'static str {
    "header 名称非法"
}

fn header_value_message(_error: &http::header::InvalidHeaderValue) -> &'static str {
    "header 值包含非法字符"
}

#[allow(clippy::too_many_arguments)]
fn assemble(
    raw_url: &str,
    raw_method: Option<&str>,
    header_map: &mut HeaderMap,
    data_parts: &[String],
    has_data: bool,
    get_mode: bool,
    json_mode: bool,
    url_queries: &[String],
    options: RequestOptions,
) -> Result<RequestSpec, CurlParseError> {
    if get_mode && json_mode {
        return err("暂不支持 -G/--get 与 --json 组合");
    }

    let mut query_parts: Vec<String> = url_queries.to_vec();
    if get_mode && has_data {
        let data = data_parts.join("&");
        if !data.is_empty() {
            query_parts.push(data);
        }
    }
    let final_url = if query_parts.is_empty() {
        raw_url.to_string()
    } else {
        append_query(raw_url, &query_parts.join("&"))
    };

    let mut body: Option<String> = None;
    if !get_mode && has_data {
        let data = data_parts.join("&");
        body = Some(data);
        if json_mode {
            if !header_map.has("content-type") {
                header_map.add(HeaderEntry {
                    name: "Content-Type".to_string(),
                    value: "application/json".to_string(),
                });
            }
            if !header_map.has("accept") {
                header_map.add(HeaderEntry {
                    name: "Accept".to_string(),
                    value: "application/json".to_string(),
                });
            }
        } else if !header_map.has("content-type") {
            header_map.add(HeaderEntry {
                name: "Content-Type".to_string(),
                value: "application/x-www-form-urlencoded".to_string(),
            });
        }
    }

    let method = match raw_method {
        Some(raw) => validate_method(raw)?,
        None => {
            if get_mode || !has_data {
                "GET".to_string()
            } else {
                "POST".to_string()
            }
        }
    };

    if (method == "GET" || method == "HEAD") && body.is_some() {
        return err(format!("{method} 请求不能携带请求体"));
    }

    Ok(RequestSpec {
        url: validate_url(&final_url)?,
        method,
        headers: headers_to_object(header_map)?,
        body,
        options: if options == RequestOptions::default() {
            None
        } else {
            Some(options)
        },
    })
}

pub fn parse_curl_command(input: &str) -> Result<RequestSpec, CurlParseError> {
    let mut tokens = tokenize_curl(input.trim())?;
    if tokens.is_empty() {
        return err("curl 命令为空");
    }
    if tokens[0] == "curl" {
        tokens.remove(0);
    }

    let mut url: Option<String> = None;
    let mut method: Option<String> = None;
    let mut get_mode = false;
    let mut insecure: Option<bool> = None;
    let mut redirect: Option<RedirectMode> = None;
    let mut max_time_ms: Option<i64> = None;
    let mut connect_timeout_ms: Option<i64> = None;
    let mut proxy: Option<String> = None;
    let mut proxy_authorization: Option<String> = None;
    let mut proxy_user: Option<String> = None;
    let mut json_mode = false;
    let mut explicit_headers: Vec<String> = Vec::new();
    let mut header_map = HeaderMap::default();
    let mut data_parts: Vec<String> = Vec::new();
    let mut cookie_parts: Vec<String> = Vec::new();
    let mut url_queries: Vec<String> = Vec::new();
    let mut has_data = false;
    let mut end_of_options = false;
    let mut i = 0usize;

    let take_next = |tokens: &[String], i: &mut usize, flag: &str| -> Result<String, CurlParseError> {
        match tokens.get(*i + 1) {
            Some(value) => {
                *i += 1;
                Ok(value.clone())
            }
            None => err(format!("参数 {flag} 缺少取值")),
        }
    };

    macro_rules! next_value {
        ($flag:expr) => {
            (take_next)(&tokens, &mut i, $flag)?
        };
    }

    while i < tokens.len() {
        let token = tokens[i].clone();

        if end_of_options {
            if url.is_some() {
                return err("只支持一个 URL");
            }
            url = Some(token);
            i += 1;
            continue;
        }

        if token == "--" {
            end_of_options = true;
            i += 1;
            continue;
        }

        if let Some(name) = token.strip_prefix("--") {
            let (name, inline) = match name.find('=') {
                Some(equals) => (&name[..equals], Some(name[equals + 1..].to_string())),
                None => (name, None),
            };
            if LONG_FLAGS.contains(&name) {
                if inline.is_some() {
                    return err(format!("参数 --{name} 不接受取值"));
                }
                match name {
                    "head" => method = Some("HEAD".to_string()),
                    "get" => get_mode = true,
                    "insecure" => insecure = Some(true),
                    "no-insecure" => insecure = Some(false),
                    "location" | "location-trusted" | "follow" => {
                        redirect = Some(RedirectMode::Follow)
                    }
                    "no-location" => redirect = Some(RedirectMode::Manual),
                    _ => {}
                }
                i += 1;
                continue;
            }
            if LONG_MAPPED.contains(&name) {
                let flag = format!("--{name}");
                let value = match inline {
                    Some(value) => value,
                    None => next_value!(flag.as_str()),
                };
                apply_value(
                    &flag,
                    &value,
                    &mut url,
                    &mut method,
                    &mut header_map,
                    &mut explicit_headers,
                    &mut data_parts,
                    &mut cookie_parts,
                    &mut url_queries,
                    &mut has_data,
                    &mut json_mode,
                    &mut max_time_ms,
                    &mut connect_timeout_ms,
                    &mut proxy,
                    &mut proxy_authorization,
                    &mut proxy_user,
                )?;
                i += 1;
                continue;
            }
            if LONG_NOOP.contains(&name) {
                if inline.is_some() {
                    return err(format!("参数 --{name} 不接受取值"));
                }
                i += 1;
                continue;
            }
            if LONG_NOOP_WITH_VALUE.contains(&name) {
                if inline.is_none() {
                    let flag = format!("--{name}");
                    next_value!(flag.as_str());
                }
                i += 1;
                continue;
            }
            if LONG_REJECT.contains(&name) {
                return Err(reject_flag(&format!("--{name}")));
            }
            return err(format!("不支持的 curl 参数: --{name}"));
        }

        if token.starts_with('-') && token != "-" {
            let chars: Vec<char> = token.chars().collect();
            let mut cursor = 1usize;
            while cursor < chars.len() {
                let flag = chars[cursor];
                let flag_str = flag.to_string();
                if SHORT_FLAGS.contains(&flag_str.as_str()) {
                    match flag {
                        'I' => method = Some("HEAD".to_string()),
                        'G' => get_mode = true,
                        'k' => insecure = Some(true),
                        'L' => redirect = Some(RedirectMode::Follow),
                        _ => {}
                    }
                    cursor += 1;
                    continue;
                }
                if SHORT_MAPPED.contains(&flag_str.as_str()) {
                    let attached: String = chars[cursor + 1..].iter().collect();
                    let dash_flag = format!("-{flag}");
                    let value = if attached.is_empty() {
                        next_value!(dash_flag.as_str())
                    } else {
                        attached
                    };
                    apply_value(
                        &dash_flag,
                        &value,
                        &mut url,
                        &mut method,
                        &mut header_map,
                        &mut explicit_headers,
                        &mut data_parts,
                        &mut cookie_parts,
                        &mut url_queries,
                        &mut has_data,
                        &mut json_mode,
                        &mut max_time_ms,
                        &mut connect_timeout_ms,
                        &mut proxy,
                        &mut proxy_authorization,
                        &mut proxy_user,
                    )?;
                    break;
                }
                if SHORT_NOOP.contains(&flag_str.as_str()) {
                    cursor += 1;
                    continue;
                }
                if SHORT_NOOP_WITH_VALUE.contains(&flag_str.as_str()) {
                    let attached: String = chars[cursor + 1..].iter().collect();
                    if attached.is_empty() {
                        let dash_flag = format!("-{flag}");
                        next_value!(dash_flag.as_str());
                    }
                    break;
                }
                if SHORT_REJECT.contains(&flag_str.as_str()) {
                    return Err(reject_flag(&format!("-{flag}")));
                }
                return err(format!("不支持的 curl 参数: -{flag}"));
            }
            i += 1;
            continue;
        }

        if url.is_some() {
            return err("只支持一个 URL");
        }
        url = Some(token);
        i += 1;
    }

    let url = match url {
        Some(url) => url,
        None => return err("未找到 URL"),
    };

    if !cookie_parts.is_empty() {
        let cookie = cookie_parts.join("; ");
        match header_map.get_mut("cookie") {
            Some(existing) => {
                existing.value = if existing.value.is_empty() {
                    cookie
                } else {
                    format!("{}; {}", existing.value, cookie)
                };
            }
            None => header_map.set("Cookie", cookie),
        }
    }

    let mut options = RequestOptions::default();
    if let Some(insecure) = insecure {
        options.insecure = Some(insecure);
    }
    if let Some(redirect) = redirect {
        options.redirect = Some(redirect);
    }
    let timeout_ms = max_time_ms.or(connect_timeout_ms);
    if let Some(timeout_ms) = timeout_ms {
        options.timeout_ms = Some(timeout_ms);
    }
    if proxy_user.is_some() {
        if proxy.is_none() {
            return err(
                "使用 -U/--proxy-user 时必须同时提供 -x/--proxy（环境代理暂不支持自定义代理认证）",
            );
        }
        options.proxy_authorization = Some(basic_auth(&proxy_user.unwrap_or_default()));
    } else if let Some(authorization) = proxy_authorization {
        options.proxy_authorization = Some(authorization);
    }
    if let Some(proxy) = proxy {
        options.proxy = Some(proxy);
    }

    assemble(
        &url,
        method.as_deref(),
        &mut header_map,
        &data_parts,
        has_data,
        get_mode,
        json_mode,
        &url_queries,
        options,
    )
}

/// 校验 curl 的协议限制参数（`--proto` / `--proto-redir` / `--proto-default`）。
///
/// curl 的语义并不等价：`--proto` 是「只允许这些协议」，`--proto-redir` 是「重定向时
/// 只允许这些协议」，`--proto-default` 是「URL 缺协议时用这个协议」，而且 `--proto`
/// 还支持 `-ftp` 这样的禁用前缀。本程序只发 http/https 请求，所以统一近似成同一套
/// 白名单：值里出现 http/https 之外的协议就报错，只含 http/https 就接受。
fn validate_protocol_list(flag: &str, value: &str) -> Result<(), CurlParseError> {
    let protocols: Vec<String> = value
        .split(',')
        .map(|protocol| protocol.trim().to_lowercase())
        .filter(|protocol| !protocol.is_empty())
        .collect();
    if protocols.is_empty() {
        return err(format!("参数 {flag} 缺少协议"));
    }
    for protocol in &protocols {
        if protocol != "http" && protocol != "https" {
            return err(format!(
                "不支持的协议：{protocol}（本程序只发 http/https 请求）"
            ));
        }
    }
    Ok(())
}

/// 应用一个带取值的 curl 参数。
#[allow(clippy::too_many_arguments)]
fn apply_value(
    flag: &str,
    value: &str,
    url: &mut Option<String>,
    method: &mut Option<String>,
    header_map: &mut HeaderMap,
    explicit_headers: &mut Vec<String>,
    data_parts: &mut Vec<String>,
    cookie_parts: &mut Vec<String>,
    url_queries: &mut Vec<String>,
    has_data: &mut bool,
    json_mode: &mut bool,
    max_time_ms: &mut Option<i64>,
    connect_timeout_ms: &mut Option<i64>,
    proxy: &mut Option<String>,
    proxy_authorization: &mut Option<String>,
    proxy_user: &mut Option<String>,
) -> Result<(), CurlParseError> {
    match flag {
        "-X" | "--request" => {
            *method = Some(value.to_string());
            Ok(())
        }
        "-H" | "--header" => {
            let entry = parse_header_line(value)?;
            let key = entry.name.to_lowercase();
            header_map.add(entry.clone());
            explicit_headers.push(key);
            Ok(())
        }
        "-b" | "--cookie" => {
            let cookie = value.trim();
            if cookie.is_empty() {
                return Ok(());
            }
            if !cookie.contains('=') {
                return err(
                    "不支持从文件读取 cookie；-b/--cookie 请直接传入 name=value 形式的 cookie 内容",
                );
            }
            cookie_parts.push(cookie.to_string());
            Ok(())
        }
        "-A" | "--user-agent" => {
            set_convenience_header(header_map, explicit_headers, "User-Agent", value);
            Ok(())
        }
        "-e" | "--referer" => {
            set_convenience_header(header_map, explicit_headers, "Referer", value);
            Ok(())
        }
        "-u" | "--user" => {
            set_convenience_header(header_map, explicit_headers, "Authorization", &basic_auth(value));
            Ok(())
        }
        "--oauth2-bearer" => {
            set_convenience_header(
                header_map,
                explicit_headers,
                "Authorization",
                &format!("Bearer {value}"),
            );
            Ok(())
        }
        "-U" | "--proxy-user" => {
            *proxy_user = Some(value.to_string());
            Ok(())
        }
        "-x" | "--proxy" => {
            let validated = validate_proxy(value)?;
            *proxy = Some(validated.url);
            if let Some(authorization) = validated.authorization {
                *proxy_authorization = Some(authorization);
            }
            Ok(())
        }
        "-r" | "--range" => {
            set_convenience_header(header_map, explicit_headers, "Range", value);
            Ok(())
        }
        "-m" | "--max-time" => {
            *max_time_ms = Some(parse_seconds(value, flag)?);
            Ok(())
        }
        "--connect-timeout" => {
            *connect_timeout_ms = Some(parse_seconds(value, flag)?);
            Ok(())
        }
        "--data-urlencode" => {
            data_parts.push(encode_form_value(value)?);
            *has_data = true;
            Ok(())
        }
        "--json" => {
            if value.starts_with('@') {
                return err("不支持从文件读取 --json 内容");
            }
            data_parts.push(value.to_string());
            *has_data = true;
            *json_mode = true;
            Ok(())
        }
        "--url-query" => {
            url_queries.push(url_query_value(value)?);
            Ok(())
        }
        "--proto" | "--proto-redir" | "--proto-default" => validate_protocol_list(flag, value),
        "--url" => {
            if url.is_some() {
                return err("只支持一个 URL");
            }
            *url = Some(value.to_string());
            Ok(())
        }
        "--data-raw" => {
            data_parts.push(value.to_string());
            *has_data = true;
            Ok(())
        }
        "-d" | "--data" | "--data-binary" | "--data-ascii" => {
            if value.starts_with('@') {
                return err("不支持从文件读取请求体（以 @ 开头），请直接粘贴内容");
            }
            data_parts.push(value.to_string());
            *has_data = true;
            Ok(())
        }
        _ => err(format!("不支持的 curl 参数: {flag}")),
    }
}

fn set_convenience_header(
    header_map: &mut HeaderMap,
    explicit_headers: &[String],
    name: &str,
    value: &str,
) {
    let key = name.to_lowercase();
    if explicit_headers.contains(&key) {
        return;
    }
    header_map.set(name, value.to_string());
}

/// 结构化表单输入。
#[derive(Debug, Clone, Default)]
pub struct StructuredRequestInput {
    pub url: String,
    pub method: Option<String>,
    /// `None` = 未设置；`Some(None)` = 明确设置为空。
    pub headers: Option<JsonMap>,
    /// 头的多行文本（`Name: value` 每行一条）。
    pub header_lines: Option<String>,
    pub body: Option<String>,
}

/// 结构化输入 → 请求规格（与 TS 版 `normalizeStructured` 一致）。
pub fn normalize_structured(input: &StructuredRequestInput) -> Result<RequestSpec, CurlParseError> {
    let raw_url = input.url.trim().to_string();
    if raw_url.is_empty() {
        return err("请填写 URL");
    }

    let mut header_map = HeaderMap::default();
    if let Some(header_lines) = &input.header_lines {
        for line in header_lines.split(['\r', '\n']) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let entry = parse_header_line(trimmed)?;
            header_map.add(entry);
        }
    } else if let Some(headers) = &input.headers {
        for (name, value) in headers {
            let value = match value {
                Json::String(text) => text.clone(),
                other => {
                    return err(format!(
                        "Header {name} 的值必须是字符串（收到 {}）",
                        other
                    ))
                }
            };
            header_map.add(HeaderEntry { name: name.clone(), value });
        }
    }

    let method = validate_method(input.method.as_deref().unwrap_or("GET").trim())?;
    let body = input.body.clone();
    if (method == "GET" || method == "HEAD") && body.is_some() {
        return err(format!("{method} 请求不能携带请求体"));
    }

    Ok(RequestSpec {
        url: validate_url(&raw_url)?,
        method,
        headers: headers_to_object(&header_map)?,
        body,
        options: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// curl 官方长选项全集（取自 `curl --help all`）。
    /// 留着这张表是为了让「某个官方参数没被归类」在测试里就能被发现，
    /// 而不是等到用户粘贴命令时才报「不支持的 curl 参数」。
    const CURL_LONG_OPTIONS: &[&str] = &[
        "--abstract-unix-socket",
        "--alt-svc",
        "--anyauth",
        "--append",
        "--aws-sigv4",
        "--basic",
        "--ca-native",
        "--cacert",
        "--capath",
        "--cert",
        "--cert-status",
        "--cert-type",
        "--ciphers",
        "--compressed",
        "--compressed-ssh",
        "--config",
        "--connect-timeout",
        "--connect-to",
        "--continue-at",
        "--cookie",
        "--cookie-jar",
        "--create-dirs",
        "--create-file-mode",
        "--crlf",
        "--crlfile",
        "--curves",
        "--data",
        "--data-ascii",
        "--data-binary",
        "--data-raw",
        "--data-urlencode",
        "--delegation",
        "--digest",
        "--disable",
        "--disable-eprt",
        "--disable-epsv",
        "--disallow-username-in-url",
        "--dns-interface",
        "--dns-ipv4-addr",
        "--dns-ipv6-addr",
        "--dns-servers",
        "--doh-cert-status",
        "--doh-insecure",
        "--doh-url",
        "--dump-ca-embed",
        "--dump-header",
        "--ech",
        "--egd-file",
        "--engine",
        "--etag-compare",
        "--etag-save",
        "--expect100-timeout",
        "--fail",
        "--fail-early",
        "--fail-with-body",
        "--false-start",
        "--follow",
        "--form",
        "--form-escape",
        "--form-string",
        "--ftp-account",
        "--ftp-alternative-to-user",
        "--ftp-create-dirs",
        "--ftp-method",
        "--ftp-pasv",
        "--ftp-port",
        "--ftp-pret",
        "--ftp-skip-pasv-ip",
        "--ftp-ssl-ccc",
        "--ftp-ssl-ccc-mode",
        "--ftp-ssl-control",
        "--get",
        "--globoff",
        "--happy-eyeballs-timeout-ms",
        "--haproxy-clientip",
        "--haproxy-protocol",
        "--head",
        "--header",
        "--help",
        "--hostpubmd5",
        "--hostpubsha256",
        "--hsts",
        "--http0",
        "--http0.9",
        "--http1",
        "--http1.0",
        "--http1.1",
        "--http2",
        "--http2-prior-knowledge",
        "--http3",
        "--http3-only",
        "--ignore-content-length",
        "--insecure",
        "--interface",
        "--ip-tos",
        "--ipfs-gateway",
        "--ipv4",
        "--ipv6",
        "--json",
        "--junk-session-cookies",
        "--keepalive-cnt",
        "--keepalive-time",
        "--key",
        "--key-type",
        "--knownhosts",
        "--krb",
        "--libcurl",
        "--limit-rate",
        "--list-only",
        "--local-port",
        "--location",
        "--location-trusted",
        "--login-options",
        "--mail-auth",
        "--mail-from",
        "--mail-rcpt",
        "--mail-rcpt-allowfails",
        "--manual",
        "--max-filesize",
        "--max-redirs",
        "--max-time",
        "--metalink",
        "--mptcp",
        "--negotiate",
        "--netrc",
        "--netrc-file",
        "--netrc-optional",
        "--next",
        "--no-alpn",
        "--no-buffer",
        "--no-clobber",
        "--no-keepalive",
        "--no-npn",
        "--no-progress-meter",
        "--no-sessionid",
        "--noproxy",
        "--ntlm",
        "--ntlm-wb",
        "--oauth2-bearer",
        "--out-null",
        "--output",
        "--output-dir",
        "--parallel",
        "--parallel-immediate",
        "--parallel-max",
        "--parallel-max-host",
        "--pass",
        "--path-as-is",
        "--pinnedpubkey",
        "--post301",
        "--post302",
        "--post303",
        "--preproxy",
        "--progress-bar",
        "--proto",
        "--proto-default",
        "--proto-redir",
        "--proxy",
        "--proxy-anyauth",
        "--proxy-basic",
        "--proxy-ca-native",
        "--proxy-cacert",
        "--proxy-capath",
        "--proxy-cert",
        "--proxy-cert-type",
        "--proxy-ciphers",
        "--proxy-crlfile",
        "--proxy-digest",
        "--proxy-header",
        "--proxy-http2",
        "--proxy-http3",
        "--proxy-insecure",
        "--proxy-key",
        "--proxy-key-type",
        "--proxy-negotiate",
        "--proxy-ntlm",
        "--proxy-pass",
        "--proxy-pinnedpubkey",
        "--proxy-service-name",
        "--proxy-ssl-allow-beast",
        "--proxy-ssl-auto-client-cert",
        "--proxy-tls13-ciphers",
        "--proxy-tlsauthtype",
        "--proxy-tlspassword",
        "--proxy-tlsuser",
        "--proxy-tlsv1",
        "--proxy-user",
        "--proxy1.0",
        "--proxytunnel",
        "--pubkey",
        "--quote",
        "--random-file",
        "--range",
        "--rate",
        "--raw",
        "--referer",
        "--remote-header-name",
        "--remote-name",
        "--remote-name-all",
        "--remote-time",
        "--remove-on-error",
        "--request",
        "--request-target",
        "--resolve",
        "--retry",
        "--retry-all-errors",
        "--retry-connrefused",
        "--retry-delay",
        "--retry-max-time",
        "--sasl-authzid",
        "--sasl-ir",
        "--service-name",
        "--show-error",
        "--show-headers",
        "--sigalgs",
        "--silent",
        "--skip-existing",
        "--socks4",
        "--socks4a",
        "--socks5",
        "--socks5-basic",
        "--socks5-gssapi",
        "--socks5-gssapi-nec",
        "--socks5-gssapi-service",
        "--socks5-hostname",
        "--speed-limit",
        "--speed-time",
        "--ssl",
        "--ssl-allow-beast",
        "--ssl-auto-client-cert",
        "--ssl-no-revoke",
        "--ssl-reqd",
        "--ssl-revoke-best-effort",
        "--ssl-sessions",
        "--sslv2",
        "--sslv3",
        "--stderr",
        "--styled-output",
        "--suppress-connect-headers",
        "--tcp-fastopen",
        "--tcp-nodelay",
        "--telnet-option",
        "--tftp-blksize",
        "--tftp-no-options",
        "--time-cond",
        "--tls-earlydata",
        "--tls-max",
        "--tls13-ciphers",
        "--tlsauthtype",
        "--tlspassword",
        "--tlsuser",
        "--tlsv1",
        "--tlsv1.0",
        "--tlsv1.1",
        "--tlsv1.2",
        "--tlsv1.3",
        "--tr-encoding",
        "--trace",
        "--trace-ascii",
        "--trace-config",
        "--trace-ids",
        "--trace-time",
        "--unix-socket",
        "--upload-file",
        "--upload-flags",
        "--url",
        "--url-query",
        "--use-ascii",
        "--user",
        "--user-agent",
        "--variable",
        "--verbose",
        "--version",
        "--vlan-priority",
        "--write-out",
        "--xattr",

    ];

    /// 官方长选项必须落在某一张分类表里，否则运行时会走进「不支持」分支。
    #[test]
    fn every_official_long_option_is_classified() {
        for option in CURL_LONG_OPTIONS {
            let name = option.trim_start_matches("--");
            assert!(
                LONG_FLAGS.contains(&name)
                    || LONG_MAPPED.contains(&name)
                    || LONG_NOOP.contains(&name)
                    || LONG_NOOP_WITH_VALUE.contains(&name)
                    || LONG_REJECT.contains(&name),
                "curl 官方参数 {option} 没有被归类"
            );
        }
    }

    /// 不是 curl 官方参数的选项仍然要失败。
    #[test]
    fn unknown_long_options_are_still_rejected() {
        let error = parse_curl_command("curl --definitely-not-a-curl-option https://example.com")
            .err()
            .expect("应当报错");
        assert_eq!(
            error.0,
            "不支持的 curl 参数: --definitely-not-a-curl-option"
        );
    }
}
