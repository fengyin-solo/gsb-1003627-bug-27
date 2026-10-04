<template>
  <section class="page" data-module="weather">
    <header class="page-head">
      <div>
        <h2>气象观测管理</h2>
        <p class="page-desc">气象观测记录是火险取数的唯一事实源：异常记录只能修正或归档，修正与取数、看板同次落库。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出气象观测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">今日观测数</span>
        <strong class="stat-value">{{ stats.todayCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待处理记录</span>
        <strong class="stat-value">{{ stats.pendingCount }}</strong>
      </article>
      <article class="stat-card" :class="{ 'stat-alert': stats.abnormalCount > 0 }">
        <span class="stat-label">异常记录数</span>
        <strong class="stat-value">{{ stats.abnormalCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">含缺测字段记录</span>
        <strong class="stat-value">{{ stats.missingCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已修正 / 已归档</span>
        <strong class="stat-value">{{ stats.correctedCount }} / {{ stats.archivedCount }}</strong>
      </article>
    </div>

    <div class="tab-bar" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-btn"
        :class="{ active: activeTab === tab.key }"
        type="button"
        role="tab"
        @click="switchTab(tab.key)"
      >
        {{ tab.label }}
        <span v-if="tab.key === 'anomaly'" class="tab-count">{{ anomalies.length }}</span>
      </button>
    </div>

    <!-- 录入列表 -->
    <template v-if="activeTab === 'list'">
      <p class="status-legend">
        <span v-for="item in statusSummary" :key="item.status" class="legend-item">
          {{ item.status }}：{{ item.count }}
        </span>
      </p>

      <form class="filter-bar" @submit.prevent="reload">
        <label v-for="field in filterFields" :key="field" class="filter-item">
          <span>{{ field }}</span>
          <input v-model="filters[field]" :placeholder="`按${field}检索`" />
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)">
            <td v-for="column in columns" :key="column" :class="{ 'cell-missing': isMissingCell(row[column]) }">
              {{ displayCell(row[column]) }}
            </td>
            <td>
              <span class="status-tag" :data-status="row.status">{{ row.status }}</span>
            </td>
            <td class="row-actions">
              <button
                v-for="action in allowedActions(row.status)"
                :key="action"
                class="link"
                :class="{ 'link-danger': action === '标记异常', 'link-primary': action === '修正数据' }"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
              <span v-if="!allowedActions(row.status).length" class="muted-text">终态，无可用动作</span>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + 2" class="empty-state">暂无符合条件的气象观测记录</td>
          </tr>
        </tbody>
      </table>
    </template>

    <!-- 异常面板 -->
    <template v-else>
      <p class="panel-note">
        异常面板直接读取气象原始记录中的异常态数据，按记录编号去重；修正或归档后立即从面板移除，不会保留旧值。
      </p>
      <table class="data-table anomaly-table">
        <thead>
          <tr>
            <th>记录编号</th>
            <th>观测站点</th>
            <th>观测时间</th>
            <th>气温(℃)</th>
            <th>相对湿度(%)</th>
            <th>风速风向</th>
            <th>降水量(mm)</th>
            <th>缺测字段</th>
            <th>处置动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in anomalies" :key="String(item.id)">
            <td>{{ item.code }}</td>
            <td>{{ item.station }}</td>
            <td>{{ item.time }}</td>
            <td :class="{ 'cell-missing': item.missingFields.includes('气温') }">{{ displayCell(item.values['气温']) }}</td>
            <td :class="{ 'cell-missing': item.missingFields.includes('相对湿度') }">{{ displayCell(item.values['相对湿度']) }}</td>
            <td :class="{ 'cell-missing': item.missingFields.includes('风速风向') }">{{ displayCell(item.values['风速风向']) }}</td>
            <td :class="{ 'cell-missing': item.missingFields.includes('降水量') }">{{ displayCell(item.values['降水量']) }}</td>
            <td>
              <span v-if="item.missingFields.length" class="missing-tags">
                <span v-for="field in item.missingFields" :key="field" class="tag tag-missing">{{ field }}</span>
              </span>
              <span v-else class="muted-text">无</span>
            </td>
            <td class="row-actions">
              <button class="link link-primary" type="button" @click="openCorrect(item.id)">修正数据</button>
              <button class="link link-danger" type="button" @click="archive(item.id)">归档记录</button>
            </td>
          </tr>
          <tr v-if="!anomalies.length">
            <td colspan="9" class="empty-state">异常面板已清空：异常记录只能进入修正或归档，没有滞留的旧记录</td>
          </tr>
        </tbody>
      </table>
    </template>

    <!-- 修正弹窗 -->
    <div v-if="correcting" class="modal-mask" @click.self="closeCorrect">
      <div class="modal">
        <h3>修正气象观测记录 · {{ correcting.code }}</h3>
        <p class="modal-sub">{{ correcting.station }} · {{ correcting.time }}（留空表示该字段仍缺测，不会写成 0）</p>
        <div class="form-grid">
          <label v-for="field in editableFields" :key="field" class="form-item">
            <span>{{ field }}{{ correcting.missingFields.includes(field) ? '（原缺测）' : '' }}</span>
            <input v-model="form[field]" :placeholder="field === '风速风向' ? '如 3级 西北风 或 4.2' : '数值；留空=缺测'" />
          </label>
        </div>
        <footer class="modal-foot">
          <button class="btn ghost" type="button" @click="closeCorrect">取消</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="submitCorrect">
            {{ submitting ? '提交中…' : '提交修正并同步火险' }}
          </button>
        </footer>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条气象观测记录 · 记录与看板同次落库，失败一起退回</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  archiveWeather,
  correctWeather,
  downloadEntries,
  listEntries,
  listWeatherAnomalies,
  moduleMeta,
  runWeatherAction,
  weatherStats,
} from '@/api/local-service'
import { displayValue, todayString } from '@/data/format'
import type { AnomalyItem } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('weather')
const columns = ['记录编号', '观测站点', '观测时间', '气温', '相对湿度', '风速风向', '降水量', '记录状态']
const filterFields = columns.slice(0, 3)
const editableFields = ['气温', '相对湿度', '风速风向', '降水量'] as const
const tabs = [
  { key: 'list', label: '录入列表' },
  { key: 'anomaly', label: '异常面板' },
] as const

type TabKey = (typeof tabs)[number]['key']
const activeTab = ref<TabKey>('list')

const rows = ref<EntryRow[]>([])
const anomalies = ref<AnomalyItem[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const submitting = ref(false)
const filters = ref<Record<string, string>>({})

const stats = ref({
  todayCount: 0,
  pendingCount: 0,
  abnormalCount: 0,
  correctedCount: 0,
  archivedCount: 0,
  missingCount: 0,
})

const statusSummary = computed(() =>
  meta.statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

/** 按状态机给出当前状态可用动作；异常态只有「修正数据 / 归档记录」。 */
function allowedActions(status: string): string[] {
  return meta.transitions?.[status] ?? []
}

function displayCell(value: unknown): string {
  return displayValue(value)
}

function isMissingCell(value: unknown): boolean {
  return displayValue(value) === '缺测'
}

function switchTab(tab: TabKey) {
  activeTab.value = tab
  if (tab === 'anomaly') {
    loadAnomalies()
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function flash(message: string, ok: boolean) {
  errorMessage.value = ok ? '' : message
  successMessage.value = ok ? message : ''
}

function runAction(action: string, row: EntryRow) {
  if (action === '修正数据') {
    openCorrect(Number(row.id))
    return
  }
  if (action === '归档记录') {
    archive(Number(row.id))
    return
  }
  const result = runWeatherAction(Number(row.id), action)
  flash(result.message, result.ok)
  if (result.ok) {
    reloadAll()
  }
}

function archive(id: number) {
  const result = archiveWeather(id)
  flash(result.message, result.ok)
  if (result.ok) {
    reloadAll()
  }
}

const correcting = ref<AnomalyItem | null>(null)
const form = reactive<Record<string, string>>({})

function openCorrect(id: number) {
  loadAnomalies()
  const item = anomalies.value.find((row) => row.id === id)
  if (!item) {
    flash('该记录已不在异常面板中（可能已被修正或归档）', false)
    return
  }
  correcting.value = item
  for (const field of editableFields) {
    const value = item.values[field]
    form[field] = value === null || value === undefined ? '' : String(value)
  }
}

function closeCorrect() {
  correcting.value = null
}

function submitCorrect() {
  if (!correcting.value) {
    return
  }
  submitting.value = true
  try {
    const result = correctWeather(correcting.value.id, { ...form })
    flash(result.message, result.ok)
    if (result.ok) {
      closeCorrect()
      reloadAll()
    }
  } finally {
    submitting.value = false
  }
}

function loadAnomalies() {
  anomalies.value = listWeatherAnomalies()
}

function loadStats() {
  stats.value = weatherStats(todayString())
}

function reload() {
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '气象观测列表读取失败'
  }
}

function reloadAll() {
  reload()
  loadAnomalies()
  loadStats()
}

onMounted(reloadAll)
</script>
