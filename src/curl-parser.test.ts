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

  test("accepts harmless output-only flags", () => {
    const parsed = parseCurlCommand("curl -sS -i -v --compressed -L https://example.com");
    expect(parsed.url).toBe("https://example.com");
  });

  test("keeps colons inside header values", () => {
    const parsed = parseCurlCommand("curl -H 'X-Time: 12:30:00' https://example.com");
    expect(parsed.headers["X-Time"]).toBe("12:30:00");
  });

  test("rejects unknown flags with the flag name", () => {
    expect(errorOf(() => parseCurlCommand("curl -u user:pass https://example.com"))).toContain("-u");
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
