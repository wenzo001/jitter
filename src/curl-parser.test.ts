import { describe, expect, test } from "bun:test";
import { CurlParseError, normalizeStructured, parseCurlCommand } from "./curl-parser";

function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof CurlParseError) return error.message;
    throw error;
  }
  throw new Error("expected a CurlParseError");
}

describe("parseCurlCommand", () => {
  test("parses a simple GET url", () => {
    expect(parseCurlCommand("curl https://example.com/api?a=1")).toEqual({
      url: "https://example.com/api?a=1",
      method: "GET",
      headers: {},
      body: null,
    });
  });

  test("parses method, headers and quoted data", () => {
    const parsed = parseCurlCommand(
      `curl -X POST 'https://example.com/hook' -H 'Content-Type: application/json' -H "Authorization: Bearer abc" -d '{"a": 1}'`,
    );
    expect(parsed.method).toBe("POST");
    expect(parsed.headers["Content-Type"]).toBe("application/json");
    expect(parsed.headers.Authorization).toBe("Bearer abc");
    expect(parsed.body).toBe('{"a": 1}');
  });

  test("handles backslash line continuations", () => {
    const input = "curl -X POST \\\n  https://example.com/x \\\n  -H 'X-Test: yes' \\\n  -d 'a=1&b=2'";
    const parsed = parseCurlCommand(input);
    expect(parsed.url).toBe("https://example.com/x");
    expect(parsed.headers["X-Test"]).toBe("yes");
    expect(parsed.body).toBe("a=1&b=2");
  });

  test("infers POST and a form content type from data", () => {
    const parsed = parseCurlCommand("curl https://example.com/form -d 'a=1'");
    expect(parsed.method).toBe("POST");
    expect(parsed.headers["content-type"] ?? parsed.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  test("joins multiple data options with &", () => {
    const parsed = parseCurlCommand("curl https://example.com -d a=1 -d b=2");
    expect(parsed.body).toBe("a=1&b=2");
  });

  test("supports attached short option values", () => {
    const parsed = parseCurlCommand("curl -XPUT -H'X-A: 1' -d'a=1' https://example.com");
    expect(parsed.method).toBe("PUT");
    expect(parsed.headers["X-A"]).toBe("1");
    expect(parsed.body).toBe("a=1");
  });

  test("supports long options with equals", () => {
    const parsed = parseCurlCommand(
      `curl --request=PATCH --header='X-A: 1' --data-raw='{"x":1}' https://example.com`,
    );
    expect(parsed.method).toBe("PATCH");
    expect(parsed.headers["X-A"]).toBe("1");
    expect(parsed.body).toBe('{"x":1}');
  });

  test("supports --url and -- terminator", () => {
    expect(parseCurlCommand("curl --url https://example.com/a").url).toBe("https://example.com/a");
    expect(parseCurlCommand("curl -- https://example.com/b").url).toBe("https://example.com/b");
  });

  test("keeps an explicitly empty data body", () => {
    const parsed = parseCurlCommand("curl -X POST https://example.com -d ''");
    expect(parsed.body).toBe("");
  });

  test("allows a literal @ body with --data-raw", () => {
    const parsed = parseCurlCommand("curl --data-raw '@literal' https://example.com");
    expect(parsed.body).toBe("@literal");
  });

  test("maps -b/--cookie to the Cookie header", () => {
    const short = parseCurlCommand("curl -b 'session=abc; theme=dark' https://example.com");
    expect(short.headers.Cookie).toBe("session=abc; theme=dark");

    const long = parseCurlCommand("curl --cookie 'a=1' https://example.com");
    expect(long.headers.Cookie).toBe("a=1");
  });

  test("combines multiple -b values and an explicit Cookie header", () => {
    const parsed = parseCurlCommand(
      "curl -H 'Cookie: first=1' -b 'a=1' -b 'b=2' https://example.com",
    );
    expect(parsed.headers.Cookie).toBe("first=1; a=1; b=2");
  });

  test("supports attached -b values", () => {
    const parsed = parseCurlCommand("curl -bsession=abc https://example.com");
    expect(parsed.headers.Cookie).toBe("session=abc");
  });

  test("ignores an empty -b value", () => {
    expect(parseCurlCommand("curl -b '' https://example.com").headers.Cookie).toBeUndefined();
  });

  test("rejects a -b file path instead of reading it", () => {
    expect(errorOf(() => parseCurlCommand("curl -b cookies.txt https://example.com"))).toContain(
      "cookie",
    );
  });

  test("parses a browser-style copy-as-curl command with cookies", () => {
    const parsed = parseCurlCommand(
      `curl 'https://example.com/api' -H 'User-Agent: Mozilla/5.0' -H 'Accept: application/json' --compressed -b 'session=abc; theme=dark'`,
    );
    expect(parsed.url).toBe("https://example.com/api");
    expect(parsed.headers["User-Agent"]).toBe("Mozilla/5.0");
    expect(parsed.headers.Cookie).toBe("session=abc; theme=dark");
  });

  test("accepts harmless output-only flags", () => {
    const parsed = parseCurlCommand("curl -sS -i -v --compressed -L https://example.com");
    expect(parsed.url).toBe("https://example.com");
  });

  test("keeps colons inside header values", () => {
    const parsed = parseCurlCommand("curl -H 'X-Time: 12:30:00' https://example.com");
    expect(parsed.headers["X-Time"]).toBe("12:30:00");
  });

  test("rejects unsupported flags with the flag name", () => {
    expect(
      errorOf(() => parseCurlCommand("curl -F 'a=b' https://example.com")),
    ).toContain("-F");
    expect(
      errorOf(() =>
        parseCurlCommand("curl --resolve example.com:443:127.0.0.1 https://example.com"),
      ),
    ).toContain("--resolve");
  });

  test("maps -u to Basic Authorization", () => {
    const parsed = parseCurlCommand("curl -u user:pass https://example.com");
    expect(parsed.headers.Authorization).toBe(
      `Basic ${Buffer.from("user:pass").toString("base64")}`,
    );
  });

  test("maps common request-shaping flags and options", () => {
    const parsed = parseCurlCommand(
      `curl -X POST -A 'Agent/1.0' -e 'https://ref.example' -u user:pass --oauth2-bearer token -r 0-99 --max-time 2.5 --connect-timeout 1 --insecure -x http://proxy.example:8080 -U proxy:pass https://example.com`,
    );
    expect(parsed.method).toBe("POST");
    expect(parsed.headers["User-Agent"]).toBe("Agent/1.0");
    expect(parsed.headers.Referer).toBe("https://ref.example");
    expect(parsed.headers.Authorization).toBe("Bearer token");
    expect(parsed.headers.Range).toBe("0-99");
    expect(parsed.headers["Proxy-Authorization"]).toBeUndefined();
    expect(parsed.options).toEqual({
      insecure: true,
      timeoutMs: 2500,
      proxy: "http://proxy.example:8080/",
      proxyAuthorization: `Basic ${Buffer.from("proxy:pass").toString("base64")}`,
    });
  });

  test("requires -x when -U is used and strips proxy URL credentials", () => {
    expect(
      errorOf(() => parseCurlCommand("curl -U proxy:pass https://example.com")),
    ).toContain("-x");

    const parsed = parseCurlCommand(
      "curl -x http://user:pass@proxy.example:8080 -U override:pass https://example.com",
    );
    expect(parsed.options?.proxy).toBe("http://proxy.example:8080/");
    expect(parsed.options?.proxyAuthorization).toBe(
      `Basic ${Buffer.from("override:pass").toString("base64")}`,
    );
    expect(parsed.headers["Proxy-Authorization"]).toBeUndefined();
  });

  test("explicit -H wins over convenience auth/user-agent flags", () => {
    const first = parseCurlCommand(
      "curl -H 'Authorization: Custom' -u user:pass -H 'User-Agent: Explicit' -A Agent https://example.com",
    );
    expect(first.headers.Authorization).toBe("Custom");
    expect(first.headers["User-Agent"]).toBe("Explicit");

    const second = parseCurlCommand(
      "curl -u user:pass -H 'Authorization: Custom' -A Agent -H 'User-Agent: Explicit' https://example.com",
    );
    expect(second.headers.Authorization).toBe("Custom");
    expect(second.headers["User-Agent"]).toBe("Explicit");
  });

  test("supports curl's empty-header idiom", () => {
    const parsed = parseCurlCommand("curl -H 'X-Empty;' https://example.com");
    expect(parsed.headers["X-Empty"]).toBe("");
  });

  test("maps --json to a JSON POST", () => {
    const parsed = parseCurlCommand(`curl --json '{"a":1}' https://example.com`);
    expect(parsed.method).toBe("POST");
    expect(parsed.body).toBe('{"a":1}');
    expect(parsed.headers["Content-Type"]).toBe("application/json");
    expect(parsed.headers.Accept).toBe("application/json");
  });

  test("concatenates multiple --json and -d parts in order", () => {
    const multiple = parseCurlCommand(
      `curl --json '{"a":1}' --json '{"b":2}' https://example.com`,
    );
    expect(multiple.body).toBe('{"a":1}&{"b":2}');

    const mixed = parseCurlCommand(
      `curl --json '{"a":1}' -d b=2 https://example.com`,
    );
    expect(mixed.body).toBe('{"a":1}&b=2');
  });

  test("rejects -G combined with --json instead of silently dropping it", () => {
    expect(
      errorOf(() =>
        parseCurlCommand(`curl -G --json '{"a":1}' https://example.com`),
      ),
    ).toContain("--json");
  });

  test("-G moves data into the query and clears the body", () => {
    const parsed = parseCurlCommand("curl -G -d a=1 -d b=2 https://example.com/path?x=1");
    expect(parsed.method).toBe("GET");
    expect(parsed.body).toBeNull();
    expect(parsed.url).toBe("https://example.com/path?x=1&a=1&b=2");
  });

  test("maps --data-urlencode and --url-query", () => {
    const data = parseCurlCommand(
      "curl --data-urlencode 'q=hello world' https://example.com",
    );
    expect(data.body).toBe("q=hello%20world");

    const query = parseCurlCommand(
      "curl --url-query 'a=1' --url-query '+b=hello world' https://example.com/path",
    );
    expect(query.url).toBe("https://example.com/path?a=1&b=hello%20world");
    expect(query.method).toBe("GET");
  });

  test("maps -I to HEAD and redirect flags to options", () => {
    expect(parseCurlCommand("curl -I https://example.com").method).toBe("HEAD");
    expect(parseCurlCommand("curl --no-location https://example.com").options).toEqual({
      redirect: "manual",
    });
    expect(parseCurlCommand("curl -L https://example.com").options).toEqual({
      redirect: "follow",
    });
  });

  test("maps --connect-timeout as a timeout fallback", () => {
    expect(
      parseCurlCommand("curl --connect-timeout 3 https://example.com").options?.timeoutMs,
    ).toBe(3000);
  });

  test("rejects non-decimal or overlong timeouts", () => {
    expect(
      errorOf(() => parseCurlCommand("curl --max-time 1e3 https://example.com")),
    ).toContain("秒数");
    expect(
      errorOf(() => parseCurlCommand("curl --max-time 0x10 https://example.com")),
    ).toContain("秒数");
    expect(
      errorOf(() => parseCurlCommand("curl --max-time 86401 https://example.com")),
    ).toContain("24");
  });

  test("accepts a bare host:port proxy", () => {
    expect(
      parseCurlCommand("curl -x 127.0.0.1:8080 https://example.com").options?.proxy,
    ).toBe("http://127.0.0.1:8080/");
  });

  test("accepts common output and behavior flags as no-ops", () => {
    const parsed = parseCurlCommand(
      `curl -sS -o out.txt -D headers.txt -w '%{http_code}' --retry 3 --max-redirs 5 --http2 --compressed --fail --globoff https://example.com`,
    );
    expect(parsed.url).toBe("https://example.com");
    expect(parsed.body).toBeNull();
  });

  test("rejects unsupported proxy protocols", () => {
    expect(
      errorOf(() =>
        parseCurlCommand("curl -x socks5://127.0.0.1:1080 https://example.com"),
      ),
    ).toContain("http/https");
  });

  test("rejects a missing url", () => {
    expect(errorOf(() => parseCurlCommand("curl -X POST -d a=1"))).toContain("URL");
  });

  test("rejects @file bodies instead of reading files", () => {
    expect(errorOf(() => parseCurlCommand("curl https://example.com -d @body.json"))).toContain("@");
  });

  test("rejects GET with a body", () => {
    expect(errorOf(() => parseCurlCommand("curl -X GET https://example.com -d a=1"))).toContain("GET");
  });

  test("rejects non-http protocols", () => {
    expect(errorOf(() => parseCurlCommand("curl file:///etc/passwd"))).toContain("http");
  });

  test("rejects unterminated quotes", () => {
    expect(errorOf(() => parseCurlCommand("curl 'https://example.com"))).toContain("引号");
  });
});

describe("normalizeStructured", () => {
  test("defaults to GET", () => {
    expect(normalizeStructured({ url: "https://example.com" })).toEqual({
      url: "https://example.com",
      method: "GET",
      headers: {},
      body: null,
    });
  });

  test("parses header lines and a body", () => {
    const parsed = normalizeStructured({
      url: "https://example.com",
      method: "post",
      headers: "Content-Type: application/json\n\nX-A: 1",
      body: '{"ok":true}',
    });
    expect(parsed.method).toBe("POST");
    expect(parsed.headers["Content-Type"]).toBe("application/json");
    expect(parsed.headers["X-A"]).toBe("1");
    expect(parsed.body).toBe('{"ok":true}');
  });

  test("accepts a header object", () => {
    const parsed = normalizeStructured({ url: "https://example.com", headers: { "X-A": "1" } });
    expect(parsed.headers["X-A"]).toBe("1");
  });

  test("rejects malformed header lines", () => {
    expect(errorOf(() => normalizeStructured({ url: "https://example.com", headers: "no-colon" }))).toContain(
      "Header",
    );
  });

  test("rejects GET with a body", () => {
    expect(
      errorOf(() => normalizeStructured({ url: "https://example.com", method: "GET", body: "x" })),
    ).toContain("GET");
  });
});
