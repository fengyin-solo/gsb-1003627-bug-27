import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, boardSnapshot, commit, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, OverviewResult, PageResult } from '@/data/types'
import {
  ABNORMAL_WEATHER_STATUS,
  ARCHIVED_WEATHER_STATUS,
  CORRECTED_WEATHER_STATUS,
  FIREWATCH_KEY,
  WEATHER_KEY,
  WEATHER_READING_FIELDS,
  deriveFirewatchRow,
  parseReading,
  prepareWeatherRows,
  stationTimeKey,
} from '@/data/weather'

export function moduleMeta(key: string) {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '缺测').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function error(message: string): ActionResult {
  return { ok: false, message }
}

function fail(error: unknown, fallback: string): ActionResult {
  return { ok: false, message: error instanceof Error ? error.message : fallback }
}

/**
 * 通用状态流转：按模块元数据里的状态机校验，未登记的流转一律拒绝。
 * 记录与看板快照在 saveRows 内同事务落库，失败时 local-store 已整体退回。
 */
export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return error(`${meta.entity}没有登记「${action}」这个动作`)
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return error(`没有找到编号为 ${id} 的${meta.entity}`)
  }
  const current = String(rows[index].status)

  const allowed = meta.transitions?.[current]
  if (allowed) {
    if (!allowed.includes(action)) {
      return error(`${meta.entity}当前为「${current}」，不能执行「${action}」${allowed.length ? `，可执行：${allowed.join('、')}` : '，该状态已终结'}`)
    }
  } else if (current === target) {
    return error(`${meta.entity}已经是「${target}」，不用重复操作`)
  }

  const nextRows = [...rows]
  nextRows[index] = { ...rows[index], status: target }
  try {
    saveRows(key, nextRows)
  } catch (cause) {
    return fail(cause, '数据落库失败，已整体退回')
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export type CorrectionInput = Partial<Record<(typeof WEATHER_READING_FIELDS)[number], string>>

/**
 * 修正气象异常记录：异常态唯一出口之一（另一个是归档）。
 * 留空表示该字段仍然缺测，落 null 而不是 0；修正后进入「已修正」终态，
 * 并在同一事务内以原始记录为准重算火险取数与看板，落库失败全部退回。
 */
export function correctWeather(id: number, input: CorrectionInput): ActionResult {
  const rows = listRows(WEATHER_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return error(`没有找到编号为 ${id} 的气象观测记录`)
  }
  if (String(rows[index].status) !== ABNORMAL_WEATHER_STATUS) {
    return error('只有「异常值」状态的记录才能执行修正')
  }

  const corrected: EntryRow = { ...rows[index] }
  for (const field of WEATHER_READING_FIELDS) {
    if (!(field in input)) {
      continue
    }
    const raw = input[field]?.trim() ?? ''
    if (raw === '') {
      corrected[field] = null
      continue
    }
    if (field === '风速风向') {
      corrected[field] = normalizeWindInput(rows[index][field], raw)
      continue
    }
    const numeric = parseReading(raw)
    if (numeric === null) {
      return error(`「${field}」无法识别为数值；确属缺测请留空`)
    }
    corrected[field] = numeric
  }
  corrected.status = CORRECTED_WEATHER_STATUS
  corrected['记录状态'] = '异常已修正'

  const nextWeather = [...rows]
  nextWeather[index] = corrected
  try {
    syncFirewatchFromWeather(nextWeather)
  } catch (cause) {
    return fail(cause, '修正落库失败，已整体退回')
  }
  return { ok: true, message: '气象观测记录已修正，火险取数与看板已同次刷新' }
}

/** 只填了风速数字时沿用原记录里的风向文本；带「级/风/m/s」的写法原样保留。 */
function normalizeWindInput(original: EntryRow[string], raw: string): string {
  if (/风|级|m\/s/i.test(raw)) {
    return raw
  }
  const numeric = parseReading(raw)
  if (numeric === null) {
    return raw
  }
  const originalWind = typeof original === 'string' ? /[东南西北]{1,3}风?/.exec(original)?.[0] : null
  return originalWind ? `${numeric}m/s ${originalWind}` : `${numeric}m/s`
}

/**
 * 气象动作（标记异常/提交审核/归档等）：动作与火险取数、看板同一事务提交。
 * 任一步失败，气象动作连同火险看板一起退回操作前状态。
 */
export function runWeatherAction(id: number, action: string): ActionResult {
  const meta = moduleMeta(WEATHER_KEY)
  const target = meta.actionTargets[action]
  if (!target) {
    return error(`${meta.entity}没有登记「${action}」这个动作`)
  }
  const rows = listRows(WEATHER_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return error(`没有找到编号为 ${id} 的${meta.entity}`)
  }
  const current = String(rows[index].status)
  const allowed = meta.transitions?.[current]
  if (allowed) {
    if (!allowed.includes(action)) {
      return error(`${meta.entity}当前为「${current}」，不能执行「${action}」${allowed.length ? `，可执行：${allowed.join('、')}` : '，该状态已终结'}`)
    }
  } else if (current === target) {
    return error(`${meta.entity}已经是「${target}」，不用重复操作`)
  }

  const nextWeather = [...rows]
  nextWeather[index] = { ...rows[index], status: target }
  try {
    syncFirewatchFromWeather(nextWeather)
  } catch (cause) {
    return fail(cause, '操作落库失败，气象记录与火险看板已一起退回')
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」，火险取数已同步` }
}

/** 归档气象记录：异常态的另一个出口；归档为终态，退出异常面板与待办，并同步火险取数。 */
export function archiveWeather(id: number): ActionResult {
  return runWeatherAction(id, '归档记录')
}

export type AnomalyItem = {
  id: number
  code: string
  station: string
  time: string
  status: string
  pending: boolean
  /** 原始采样缺测的字段（区别于有效零值） */
  missingFields: string[]
  values: Record<string, string | number | null>
}

/** 异常面板：直接取气象记录里的异常态行作为唯一事实源，按编号去重，不保留任何旧副本。 */
export function listWeatherAnomalies(): AnomalyItem[] {
  return listRows(WEATHER_KEY)
    .filter((row) => String(row.status) === ABNORMAL_WEATHER_STATUS)
    .map((row) => {
      const missingFields = WEATHER_READING_FIELDS.filter((field) => row[field] === null || row[field] === undefined)
      return {
        id: row.id,
        code: String(row['记录编号'] ?? `WEAT-${row.id}`),
        station: String(row['观测站点'] ?? '未知站点'),
        time: String(row['观测时间'] ?? ''),
        status: String(row.status),
        pending: row.pending,
        missingFields: [...missingFields],
        values: Object.fromEntries(WEATHER_READING_FIELDS.map((field) => [field, (row[field] ?? null) as string | number | null])),
      }
    })
    .sort((a, b) => a.time.localeCompare(b.time))
}

export type WeatherStats = {
  todayCount: number
  pendingCount: number
  abnormalCount: number
  correctedCount: number
  archivedCount: number
  missingCount: number
}

export function weatherStats(today: string): WeatherStats {
  const rows = listRows(WEATHER_KEY)
  return {
    todayCount: rows.filter((row) => String(row['观测时间'] ?? '').startsWith(today)).length,
    pendingCount: rows.filter((row) => row.pending).length,
    abnormalCount: rows.filter((row) => String(row.status) === ABNORMAL_WEATHER_STATUS).length,
    correctedCount: rows.filter((row) => String(row.status) === CORRECTED_WEATHER_STATUS).length,
    archivedCount: rows.filter((row) => String(row.status) === ARCHIVED_WEATHER_STATUS).length,
    missingCount: rows.filter((row) => WEATHER_READING_FIELDS.some((field) => row[field] === null || row[field] === undefined)).length,
  }
}

type SourceTag = 'original' | 'filled' | 'missing'

/**
 * 以气象原始记录为准，重算并落库火险监测取数。
 * - 仅按「监测区域（站点）+ 监测时间」更新能对上气象记录的监测点，不新造监测点；
 * - 缺测字段先由同站相邻采样补值（取数来源标注「补」），补不出来保持「缺测」，绝不写 0；
 * - 火险等级/监测状态由气象因子重新判定，覆盖看板手工抬级或旧版错误零值。
 * 气象记录、火险取数、看板快照在同一事务内提交，落库失败由 commit 整体退回。
 */
export function syncFirewatchFromWeather(weatherOverride?: EntryRow[]): { updated: number; missing: number } {
  const all = allRows()
  const weatherRows = weatherOverride ?? all[WEATHER_KEY] ?? []
  const fireRows = (all[FIREWATCH_KEY] ?? []).map((row) => ({ ...row }))

  const prepared = prepareWeatherRows(weatherRows)
  const preparedByKey = new Map(
    prepared.map((item) => [stationTimeKey(item.row['观测站点'], item.row['观测时间']), item]),
  )

  let updated = 0
  let missing = 0
  for (const row of fireRows) {
    const matched = preparedByKey.get(stationTimeKey(row['监测区域'], row['监测时间']))
    if (!matched) {
      continue
    }
    const derived = deriveFirewatchRow(matched, matched.windText)
    row['气温读数'] = derived.temp
    row['相对湿度'] = derived.humidity
    row['风力等级'] = derived.windLevel
    row['降水量'] = derived.rain
    row['火险等级'] = derived.level
    row.status = derived.level
    row['取数来源'] = sourceSummary(derived.sources)
    row['监测状态'] = derived.level === '缺测' ? '气象因子不足，等级缺测' : `按${matched.row['记录编号']}原始观测重算`
    updated += 1
    if (derived.level === '缺测' || Object.values(derived.sources).some((source: SourceTag) => source === 'missing')) {
      missing += 1
    }
  }

  commit({ ...all, [WEATHER_KEY]: weatherRows, [FIREWATCH_KEY]: fireRows })
  return { updated, missing }
}

function sourceSummary(sources: Record<string, SourceTag>): string {
  const labels: Record<string, string> = { 气温读数: '气温', 相对湿度: '湿度', 风力等级: '风', 降水量: '降水' }
  return Object.entries(sources)
    .map(([field, source]) => {
      const tag = source === 'original' ? '原' : source === 'filled' ? '补' : '缺'
      return `${labels[field] ?? field}:${tag}`
    })
    .join(' ')
}

/** 火险页面手动「重新取数」：重算后返回可读结果。 */
export function refreshFirewatch(): ActionResult & { updated?: number; missing?: number } {
  try {
    const { updated, missing } = syncFirewatchFromWeather()
    return { ok: true, updated, missing, message: `已按气象原始记录重算 ${updated} 个监测点，其中 ${missing} 个存在缺测因子` }
  } catch (cause) {
    return fail(cause, '火险取数落库失败，已整体退回')
  }
}

export type FirewatchStats = {
  total: number
  redCount: number
  warningCount: number
  missingCount: number
}

export function firewatchStats(): FirewatchStats {
  const rows = listRows(FIREWATCH_KEY)
  return {
    total: rows.length,
    redCount: rows.filter((row) => String(row.status) === '红色预警').length,
    warningCount: rows.filter((row) => ['蓝色预警', '黄色预警', '橙色预警', '红色预警'].includes(String(row.status))).length,
    missingCount: rows.filter((row) => row['气温读数'] === null || row['气温读数'] === undefined || String(row['火险等级']) === '缺测').length,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push(
      [row.id, ...meta.fields.map((field) => (row[field] === null || row[field] === undefined ? '缺测' : row[field])), row.status].join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const board = boardSnapshot()
  return {
    cards: board.cards,
    modules: board.modules.map((item) => ({ name: item.name, created: item.created, pending: item.pending, abnormal: item.abnormal })),
    updatedAt: board.updatedAt,
  }
}
