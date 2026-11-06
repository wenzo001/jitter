import { describe, expect, test } from "bun:test";
import { PortInUseError, isAddressInUse, isLocalBindHost, listenWithPortRetry } from "./port";

function addressInUse(port = 3000): Error {
  const error = new Error(`Failed to start server. Is port ${port} in use?`);
  (error as Error & { code: string }).code = "EADDRINUSE";
  return error;
}

describe("isAddressInUse", () => {
  test("recognizes the Bun error code and message", () => {
    expect(isAddressInUse(addressInUse())).toBe(true);
    expect(isAddressInUse(new Error("address already in use"))).toBe(true);
    expect(isAddressInUse(new Error("EADDRINUSE"))).toBe(true);
  });

  test("does not classify unrelated errors", () => {
    expect(isAddressInUse(new Error("permission denied"))).toBe(false);
    expect(isAddressInUse(null)).toBe(false);
    expect(isAddressInUse("boom")).toBe(false);
  });
});

test("distinguishes local bind hosts from non-local IPs", () => {
  expect(isLocalBindHost("127.0.0.1")).toBe(true);
  expect(isLocalBindHost("0.0.0.0")).toBe(true);
  expect(isLocalBindHost("localhost")).toBe(true);
  expect(isLocalBindHost("203.0.113.1")).toBe(false);
});

describe("listenWithPortRetry", () => {
  test("retries port + 1 until it binds", () => {
    const tried: number[] = [];
    const retries: Array<[number, number]> = [];
    const result = listenWithPortRetry({
      port: 3000,
      autoIncrement: true,
      maxAttempts: 5,
      listen: (port) => {
        tried.push(port);
        if (port < 3002) throw addressInUse(port);
        return { port };
      },
      onRetry: (from, to) => retries.push([from, to]),
    });

    expect(result.port).toBe(3002);
    expect(result.attempts).toBe(3);
    expect(tried).toEqual([3000, 3001, 3002]);
    expect(retries).toEqual([
      [3000, 3001],
      [3001, 3002],
    ]);
  });

  test("fails immediately when auto-increment is disabled", () => {
    expect(() =>
      listenWithPortRetry({
        port: 3000,
        autoIncrement: false,
        maxAttempts: 5,
        listen: () => {
          throw addressInUse();
        },
      }),
    ).toThrow(PortInUseError);
  });

  test("stops after maxAttempts and reports the attempted range", () => {
    try {
      listenWithPortRetry({
        port: 3000,
        autoIncrement: true,
        maxAttempts: 3,
        listen: (port) => {
          throw addressInUse(port);
        },
      });
      throw new Error("expected listenWithPortRetry to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PortInUseError);
      expect((error as Error).message).toContain("3000–3002");
    }
  });

  test("does not retry non-port errors", () => {
    expect(() =>
      listenWithPortRetry({
        port: 3000,
        autoIncrement: true,
        maxAttempts: 5,
        listen: () => {
          throw new Error("permission denied");
        },
      }),
    ).toThrow("permission denied");
  });

  test("works with real Bun.serve when a port is occupied", async () => {
    const blocker = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("blocked"),
    });

    try {
      const blockerPort = blocker.port;
      if (blockerPort === undefined) {
        throw new Error("test blocker did not bind a port");
      }
      const result = listenWithPortRetry<ReturnType<typeof Bun.serve>>({
        port: blockerPort,
        autoIncrement: true,
        maxAttempts: 5,
        listen: (port) =>
          Bun.serve({
            port,
            hostname: "127.0.0.1",
            fetch: () => new Response("ok"),
          }),
      });

      expect(result.port).toBeGreaterThan(blockerPort);
      expect(result.attempts).toBeGreaterThanOrEqual(2);
      const response = await fetch(`http://127.0.0.1:${result.port}/`);
      expect(await response.text()).toBe("ok");
      result.handle.stop(true);
    } finally {
      blocker.stop(true);
    }
  });
});
