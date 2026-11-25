<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { getDatabaseRows, listDatabaseTables } from '@/api/database'
import type { DatabaseRows, DatabaseTable } from '@/types/system'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const { t } = useI18n()

const PAGE_SIZE = 100

const tables = ref<DatabaseTable[]>([])
const current = ref<string>('')
const rows = ref<DatabaseRows | null>(null)
const page = ref(1)
const loading = ref(false)
const error = ref('')

const tableOptions = computed(() =>
  tables.value.map((table) => ({
    value: table.name,
    label: t('database.tableOption', { name: table.name, rows: table.row_count }),
  })),
)

const columns = computed(() => {
  const list = rows.value?.columns ?? []
  return list.map((column) => ({
    title: column.name,
    dataIndex: column.name,
    key: column.name,
    ellipsis: true,
    width: column.decl_type === 'TEXT' ? 260 : 140,
  }))
})

/** 单元格文本：对象/数组转成紧凑 JSON，空值显示占位符。 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 取某列的原始值（表格插槽里 record / column 的类型是 unknown）。 */
function cellValue(record: unknown, column: { dataIndex?: unknown }): unknown {
  const key = String(column?.dataIndex ?? '')
  if (!key || !record || typeof record !== 'object') return null
  return (record as Record<string, unknown>)[key]
}

const total = computed(() => rows.value?.total ?? 0)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

async function loadTables(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const data = await listDatabaseTables()
    tables.value = data.tables ?? []
    if (!current.value && tables.value.length) current.value = tables.value[0].name
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadRows(): Promise<void> {
  if (!current.value) {
    rows.value = null
    return
  }
  loading.value = true
  error.value = ''
  try {
    rows.value = await getDatabaseRows(current.value, PAGE_SIZE, (page.value - 1) * PAGE_SIZE)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    rows.value = null
  } finally {
    loading.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    page.value = 1
    void loadTables().then(loadRows)
  },
)

watch(current, () => {
  page.value = 1
  if (props.open) void loadRows()
})

function onPageChange(next: number): void {
  page.value = next
  void loadRows()
}

const storage = computed(() => {
  const list = tables.value ?? []
  const rowsTotal = list.reduce((sum, table) => sum + table.row_count, 0)
  return { tables: list.length, rows: rowsTotal }
})
</script>

<template>
  <a-modal
    :open="open"
    :title="$t('database.title')"
    width="min(1100px, 96vw)"
    :footer="null"
    @update:open="emit('update:open', $event)"
  >
    <div class="db-toolbar">
      <a-select
        v-model:value="current"
        :options="tableOptions"
        style="min-width: 260px"
        :placeholder="t('database.placeholder')"
        :loading="loading"
      />
      <span class="muted">
        {{ $t('database.summary', { tables: storage.tables, rows: storage.rows, size: PAGE_SIZE }) }}
      </span>
    </div>

    <a-alert v-if="error" type="error" show-icon :message="error" style="margin-bottom: 10px" />

    <a-spin :spinning="loading">
      <div v-if="rows && rows.rows.length" class="db-table-wrap">
        <a-table
          size="small"
          :columns="columns"
          :data-source="rows.rows"
          :pagination="false"
          :row-key="(_record: unknown, index?: number) => index ?? 0"
          :scroll="{ x: 'max-content' }"
          class="db-table"
        >
          <template #bodyCell="{ column, record }">
            <span class="db-cell-text" :title="cellText(cellValue(record, column))">
              {{ cellText(cellValue(record, column)) }}
            </span>
          </template>
        </a-table>
      </div>
      <div v-else-if="!loading" class="empty">{{ $t('database.empty') }}</div>
    </a-spin>

    <div v-if="total > 0" class="db-footer">
      <a-pagination
        :current="page"
        :page-size="PAGE_SIZE"
        :total="total"
        :show-total="(value: number) => t('database.total', { count: value })"
        size="small"
        @change="onPageChange"
      />
    </div>
  </a-modal>
</template>

<style scoped>
.db-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.db-table-wrap {
  max-height: calc(100vh - 300px);
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.db-table :deep(th) {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #f8fafc;
  font-family: var(--mono);
  font-size: 11.5px;
  white-space: nowrap;
}

.db-cell {
  font-family: var(--mono);
  font-size: 11.5px;
  max-width: 320px;
}

.db-cell-text {
  display: inline-block;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.db-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
</style>
