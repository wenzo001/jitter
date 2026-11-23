/**
 * 环境代理的自愈直连。
 *
 * 长期运行的进程（比如 PM2）可能继承到过期代理——代理软件换了本地端口但进程没重启，
 * 于是浏览器用系统新代理正常、Jitter 却卡在旧端口直到超时。
 *
 * Bun 没有「单次请求忽略环境代理」的开关，唯一能直连的办法是把进程的代理环境变量
 * 临时清掉，所以先做快照，若直连重试也失败就把代理放回去。
 */

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

export type EnvProxySnapshot = Record<string, string>;

export function snapshotEnvProxy(): EnvProxySnapshot {
  const snapshot: EnvProxySnapshot = {};
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.trim() !== "") snapshot[key] = value;
  }
  return snapshot;
}

export function clearEnvProxy(): void {
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
}

export function restoreEnvProxy(snapshot: EnvProxySnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

/** 是否是「连接被重置」这类传输层错误（值得直连重试）。 */
export function isConnectionResetError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return false;
  const code = (error as Error & { code?: unknown }).code;
  if (code === "ECONNRESET" || code === "EPIPE") return true;
  const message = error.message.toLowerCase();
  return (
    message.includes("socket connection was closed unexpectedly") ||
    message.includes("connection reset by peer") ||
    message.includes("econnreset") ||
    message.includes("proxy")
  );
}

/**
 * 先按当前环境（可能带代理）执行；遇到连接错误就清掉代理变量直连重试一次。
 * 直连也失败时把代理放回去，避免其他请求彻底没有代理可用。
 */
export async function withProxyFallback<T>(
  run: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean = isConnectionResetError,
): Promise<T> {
  const snapshot = snapshotEnvProxy();
  try {
    return await run();
  } catch (error) {
    if (!shouldRetry(error)) throw error;
    clearEnvProxy();
    try {
      return await run();
    } catch (directError) {
      restoreEnvProxy(snapshot);
      throw directError;
    }
  }
}
