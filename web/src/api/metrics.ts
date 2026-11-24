import { request } from './client'
import type { MetricsReport } from '@/types/system'

export function getMetrics(): Promise<MetricsReport> {
  return request('/api/metrics')
}
