import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

export class PortInUseError extends Error {
  readonly code = "PORT_IN_USE";

  constructor(
    readonly startPort: number,
    readonly endPort: number,
    cause?: unknown,
  ) {
    const detail =
      cause instanceof Error && cause.message ? `（${cause.message}）` : "";
    super(
      startPort === endPort
        ? `端口 ${startPort} 被占用，无法启动${detail}`
        : `端口 ${startPort}–${endPort} 均被占用，无法启动${detail}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "PortInUseError";
  }
}

export function isLocalBindHost(host: string): boolean {
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1"
  ) {
    return true;
  }
  if (isIP(host) === 0) {
    // Hostname: let the OS resolve it; EADDRINUSE from bind is still reported.
    return true;
  }
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.address === host) return true;
    }
  }
  return false;
}

export function isAddressInUse(error: unknown): boolean {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (code === "EADDRINUSE") return true;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && /EADDRINUSE|address already in use|port .* in use/i.test(message)) {
      return true;
    }
  }
  return /EADDRINUSE|address already in use/i.test(String(error));
}

export interface ListenWithRetryOptions<T> {
  port: number;
  autoIncrement: boolean;
  maxAttempts: number;
  listen: (port: number) => T;
  onRetry?: (from: number, to: number, error: unknown) => void;
}

export interface ListenResult<T> {
  handle: T;
  port: number;
  attempts: number;
}

/**
 * Calls `listen` with the configured port. On EADDRINUSE it tries port + 1
 * (up to maxAttempts) when autoIncrement is enabled, and never retries other
 * errors. The caller should print the actual bound port from the returned
 * server handle, because port 0 lets the platform choose one.
 */
export function listenWithPortRetry<T>(options: ListenWithRetryOptions<T>): ListenResult<T> {
  const attemptsLimit = Math.max(1, Math.trunc(options.maxAttempts));
  const startPort = options.port;
  let port = startPort;

  for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
    try {
      return { handle: options.listen(port), port, attempts: attempt };
    } catch (error) {
      if (!isAddressInUse(error)) {
        throw error;
      }
      if (
        !options.autoIncrement ||
        port === 0 ||
        port >= 65535 ||
        attempt >= attemptsLimit
      ) {
        throw new PortInUseError(startPort, port, error);
      }
      const next = port + 1;
      options.onRetry?.(port, next, error);
      port = next;
    }
  }

  throw new PortInUseError(startPort, port);
}
