<template>
  <section class="page" data-module="weather">
    <header class="page-head">
      <div>
        <h2>气象观测管理</h2>
        <p class="page-desc">维护气象观测记录，围绕记录编号、观测站点、观测时间、气温做登记、筛选与状态流转。读数以原始采样为准，缺测不按零值处理。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记气象观测记录</button>
        <button class="btn" type="button" @click="exportRows">导出气象观测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

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
          <td v-for="column in columns" :key="column">
            <span v-if="isMissingCell(row[column])" class="missing-tag">缺测</span>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            <span :class="{ 'abnormal-tag': weatherAbnormalRow(row) }">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <!-- 异常记录只能修正或归档；收尾记录不再提供任何动作 -->
            <template v-if="weatherAbnormalRow(row)">
              <button class="link" type="button" @click="openCorrect(row)">修正</button>
              <button class="link" type="button" @click="openArchive(row)">归档</button>
            </template>
            <button
              v-else-if="String(row.status) === '已录入'"
              class="link"
              type="button"
              @click="doAction('提交审核', row)"
            >
              提交审核
            </button>
            <button
              v-else-if="!isTerminal(String(row.status))"
              class="link"
              type="button"
              @click="doAction('标记异常', row)"
            >
              标记异常
            </button>
            <span v-else class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无气象观测数据，可先登记气象观测记录</td>
        </tr>
      </tbody>
    </table>

    <!-- 异常面板：数据直接取自已落库记录并按记录编号去重，只展示最新一版，刷新后不重复挂旧值 -->
    <section class="panel abnormal-panel">
      <header class="panel-head">
        <h3>异常记录待处理（{{ abnormalRows.length }}）</h3>
        <span class="muted-text">异常记录只能进入修正或归档；修正/归档后检查站现场核查待办同步销项</span>
      </header>
      <table v-if="abnormalRows.length" class="data-table">
        <thead>
          <tr>
            <th>记录编号</th><th>观测站点</th><th>观测时间</th>
            <th>气温</th><th>相对湿度</th><th>风速风向</th><th>降水量</th>
            <th>处理</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in abnormalRows" :key="`ab-${String(row.id)}`">
            <td>{{ row['记录编号'] }}</td>
            <td>{{ row['观测站点'] }}</td>
            <td>{{ row['观测时间'] }}</td>
            <td v-for="field in measureFields" :key="field">
              <span v-if="isMissingCell(row[field])" class="missing-tag">缺测</span>
              <template v-else>{{ row[field] }}</template>
            </td>
            <td class="row-actions">
              <button class="link" type="button" @click="openCorrect(row)">修正</button>
              <button class="link" type="button" @click="openArchive(row)">归档</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">当前没有待处理的异常记录</p>
    </section>

    <!-- 修正弹窗：缺测项按同站点相邻采样插值预填，观测员确认后才落值；原始采样留痕 -->
    <div v-if="correctTarget" class="modal-mask" @click.self="closeCorrect">
      <div class="modal-card">
        <h3>修正异常记录 {{ String(correctTarget['记录编号']) }}</h3>
        <p class="muted-text">
          观测站点 {{ String(correctTarget['观测站点']) }} · {{ String(correctTarget['观测时间']) }}。
          建议补值取自同站点相邻有效采样插值（缺测不参与计算），可人工调整后确认。
        </p>
        <div class="form-grid">
          <label>
            <span>气温（℃）</span>
            <input v-model.number="correctForm.temp" type="number" step="0.1" />
          </label>
          <label>
            <span>相对湿度（%）</span>
            <input v-model.number="correctForm.humidity" type="number" step="1" min="0" max="100" />
          </label>
          <label>
            <span>风力等级（0-17级）</span>
            <input v-model.number="correctForm.windLevel" type="number" step="1" min="0" max="17" />
          </label>
          <label>
            <span>风向</span>
            <input v-model="correctForm.windDir" placeholder="如：西北风" />
          </label>
          <label>
            <span>降水量（mm）</span>
            <input v-model.number="correctForm.precip" type="number" step="0.1" min="0" />
          </label>
          <label class="full-row">
            <span>修正说明</span>
            <input v-model="correctForm.note" placeholder="可选，说明补值依据" />
          </label>
        </div>
        <p v-if="modalError" class="error-text">{{ modalError }}</p>
        <footer class="modal-actions">
          <button class="btn" type="button" @click="fillSuggestion">重新取插值建议</button>
          <span class="spacer" />
          <button class="btn ghost" type="button" @click="closeCorrect">取消</button>
          <button class="btn primary" type="button" @click="submitCorrect">确认修正并落库</button>
        </footer>
      </div>
    </div>

    <div v-if="archiveTarget" class="modal-mask" @click.self="closeArchive">
      <div class="modal-card">
        <h3>归档异常记录 {{ String(archiveTarget['记录编号']) }}</h3>
        <p class="muted-text">归档后读数维持原始采样（缺测仍为缺测，不补零），记录不再参与状态流转。</p>
        <label class="full-row">
          <span>归档说明</span>
          <input v-model="archiveNote" placeholder="可选，说明无法现场复核的原因" />
        </label>
        <p v-if="modalError" class="error-text">{{ modalError }}</p>
        <footer class="modal-actions">
          <span class="spacer" />
          <button class="btn ghost" type="button" @click="closeArchive">取消</button>
          <button class="btn primary" type="button" @click="submitArchive">确认归档</button>
        </footer>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条气象观测记录 · 看板更新于 {{ boardUpdatedAt || '尚未提交' }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  abnormalWeatherEntries,
  archiveWeatherRecord,
  correctWeatherRecord,
  currentBoard,
  downloadEntries,
  listEntries,
  moduleMeta,
  runWeatherAction,
  weatherCorrectionSuggestion,
} from '@/api/local-service'
import { MISSING_TOKEN } from '@/data/types'
import type { CorrectionDraft } from '@/data/domain/weather'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('weather')
const columns = ["记录编号", "观测站点", "观测时间", "气温", "相对湿度", "风速风向", "降水量", "记录状态"]
const measureFields = ["气温", "相对湿度", "风速风向", "降水量"]
const statuses = ["已录入", "已审核", "异常值", "已修正", "已归档"]
const TERMINAL = new Set(["已修正", "已归档"])

const rows = ref<EntryRow[]>([])
const abnormalRows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const boardUpdatedAt = ref('')

const stats = ref([
  { label: "今日观测数", value: 0 },
  { label: "待审核记录", value: 0 },
  { label: "异常记录数", value: 0 },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function isTerminal(status: string): boolean {
  return TERMINAL.has(status)
}

function weatherAbnormalRow(row: EntryRow): boolean {
  return String(row.status) === '异常值' || row.abnormal === true
}

function isMissingCell(value: unknown): boolean {
  return value === MISSING_TOKEN
}

function refreshStats() {
  const board = currentBoard()
  const weatherMetric = board.modules.find((item) => item.name === meta.name)
  stats.value = [
    { label: '今日观测数', value: weatherMetric?.values['今日观测数'] ?? 0 },
    { label: '待审核记录', value: weatherMetric?.values['待审核记录'] ?? 0 },
    { label: '异常记录数', value: weatherMetric?.values['异常记录数'] ?? 0 },
  ]
  boardUpdatedAt.value = board.updatedAt
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '气象观测记录登记入口尚未接入审批流'
}

function doAction(action: '提交审核' | '标记异常', row: EntryRow) {
  errorMessage.value = ''
  modalError.value = ''
  const result = runWeatherAction(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

// ---------- 修正 ----------

const correctTarget = ref<EntryRow | null>(null)
const correctForm = ref<CorrectionDraft>({ temp: null, humidity: null, precip: null, windDir: '', windLevel: null, note: '' })
const modalError = ref('')

function openCorrect(row: EntryRow) {
  correctTarget.value = row
  modalError.value = ''
  fillSuggestion()
}

function fillSuggestion() {
  if (!correctTarget.value) {
    return
  }
  const draft = weatherCorrectionSuggestion(Number(correctTarget.value.id))
  if (draft) {
    correctForm.value = draft
  }
}

function closeCorrect() {
  correctTarget.value = null
  modalError.value = ''
}

function submitCorrect() {
  if (!correctTarget.value) {
    return
  }
  const result = correctWeatherRecord(Number(correctTarget.value.id), correctForm.value)
  if (!result.ok) {
    modalError.value = result.message
    return
  }
  closeCorrect()
  reload()
}

// ---------- 归档 ----------

const archiveTarget = ref<EntryRow | null>(null)
const archiveNote = ref('')

function openArchive(row: EntryRow) {
  archiveTarget.value = row
  archiveNote.value = ''
  modalError.value = ''
}

function closeArchive() {
  archiveTarget.value = null
  modalError.value = ''
}

function submitArchive() {
  if (!archiveTarget.value) {
    return
  }
  const result = archiveWeatherRecord(Number(archiveTarget.value.id), archiveNote.value)
  if (!result.ok) {
    modalError.value = result.message
    return
  }
  closeArchive()
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    abnormalRows.value = abnormalWeatherEntries()
    refreshStats()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '气象观测列表读取失败'
  }
}

onMounted(reload)
</script>
