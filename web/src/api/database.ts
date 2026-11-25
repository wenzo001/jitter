import { request } from './client'
import type { DatabaseRows, DatabaseTable } from '@/types/system'

/** 全部可见表（含列结构与行数）。 */
export function listDatabaseTables(): Promise<{ tables: DatabaseTable[] }> {
  return request('/api/database/tables', { timeoutMs: 10_000 })
}

/** 某张表的一页数据（只读）。 */
export function getDatabaseRows(
  table: string,
  limit = 100,
  offset = 0,
): Promise<DatabaseRows> {
  const query = new URLSearchParams({ table, limit: String(limit), offset: String(offset) })
  return request(`/api/database/rows?${query.toString()}`, { timeoutMs: 15_000 })
}
