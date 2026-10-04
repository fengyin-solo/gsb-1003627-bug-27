<template>
  <section class="page" data-module="firewatch">
    <header class="page-head">
      <div>
        <h2>火险监测管理</h2>
        <p class="page-desc">火险读数统一从气象原始观测取数：冲突时以原始记录为准，历史缺测按原采样兼容，缺测不按零值计算。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" :disabled="syncing" @click="syncFromWeather">
          {{ syncing ? '取数中…' : '按气象原始记录重新取数' }}
        </button>
        <button class="btn" type="button" @click="exportRows">导出火险监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">监测点数</span>
        <strong class="stat-value">{{ stats.total }}</strong>
      </article>
      <article class="stat-card" :class="{ 'stat-alert': stats.redCount > 0 }">
        <span class="stat-label">红色预警数</span>
        <strong class="stat-value">{{ stats.redCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">在预警点数</span>
        <strong class="stat-value">{{ stats.warningCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">含缺测因子点</span>
        <strong class="stat-value">{{ stats.missingCount }}</strong>
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
          <td v-for="column in columns" :key="column" :class="{ 'cell-missing': isMissingCell(row[column]) }">
            {{ displayCell(row[column]) }}
          </td>
          <td>
            <span class="status-tag" :data-status="row.status">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无火险监测数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 个火险监测点 · 取数与气象记录、看板同事务落库，失败整体退回</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  filterRows,
  firewatchStats,
  listEntries,
  moduleMeta,
  refreshFirewatch,
  runAction as applyAction,
} from '@/api/local-service'
import { listRows } from '@/data/local-store'
import { displayValue } from '@/data/format'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('firewatch')
const columns = ['监测点编号', '监测区域', '火险等级', '风力等级', '相对湿度', '气温读数', '降水量', '监测时间', '取数来源', '监测状态']
const actions = ['更新等级', '解除预警', '升级预警']
const statuses = ['正常', '蓝色预警', '黄色预警', '橙色预警', '红色预警', '缺测']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const syncing = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = ['监测点编号', '监测区域', '火险等级']
const stats = ref({ total: 0, redCount: 0, warningCount: 0, missingCount: 0 })

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function displayCell(value: unknown): string {
  return displayValue(value)
}

function isMissingCell(value: unknown): boolean {
  return displayValue(value) === '缺测'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function syncFromWeather() {
  errorMessage.value = ''
  successMessage.value = ''
  syncing.value = true
  try {
    const result = refreshFirewatch()
    if (result.ok) {
      successMessage.value = result.message
    } else {
      errorMessage.value = result.message
    }
    reload()
  } finally {
    syncing.value = false
  }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  successMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  successMessage.value = result.message
  reload()
}

function reload() {
  // 直接读存储里的取数结果，保证页面与气象侧落库的是同一份数据。
  const matched = filterRows(listRows(meta.key), filters.value)
  rows.value = matched
  total.value = matched.length
  stats.value = firewatchStats()
}

onMounted(reload)
</script>
