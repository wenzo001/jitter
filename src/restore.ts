/**
 * 恢复的进程级接线。
 *
 * 数据库的生命周期属于 index.ts（它启动调度器、持有连接），所以 api.ts 不直接
 * 动数据库：恢复时先做安全快照（backup.ts），再把替换动作交给宿主注册的回调。
 */

type RestoreHandler = (backupPath: string) => boolean;

let handler: RestoreHandler | null = null;

/** 宿主进程注册真正的恢复实现。 */
export function setRestoreHandler(next: RestoreHandler | null): void {
  handler = next;
}

/** 请求恢复；没有注册实现时返回 false（例如单测环境）。 */
export function requestRestore(backupPath: string): boolean {
  if (!handler) return false;
  return handler(backupPath);
}
