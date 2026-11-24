import { request, postJson } from './client'
import type { TestBenchPayload, TestBenchResponse, TestRunDetail, TestRunSummary } from '@/types/testbench'

export function runTestBench(payload: TestBenchPayload): Promise<TestBenchResponse> {
  return postJson('/api/test/run', payload, 100_000)
}

export function listTestRuns(taskId: string): Promise<{ runs: TestRunSummary[] }> {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/test-runs`)
}

export function getTestRun(id: number): Promise<{ run: TestRunDetail }> {
  return request(`/api/test-runs/${id}`)
}
