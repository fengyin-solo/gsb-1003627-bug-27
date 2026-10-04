import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  commitAll,
  listRows,
  readBoard,
  readTodos,
  resetRows,
  STORAGE_KEYS,
} from '@/data/local-store'
import type {
  ActionResult,
  BoardSnapshot,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  SyncTodo,
} from '@/data/types'
import {
  buildBoard,
  FIREWATCH_KEY,
  listAbnormalRecords,
  normalizeWeatherRows,
  pullWeatherToFirewatch,
  syncCheckpointTodos,
  suggestCorrection,
  validateCorrection,
  buildArchivedRow,
  buildCorrectedRow,
  type CorrectionDraft,
} from '@/data/domain/weather'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
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
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const source = key === 'weather' ? normalizeWeatherRows(listRows(key)) : listRows(key)
  const matched = filterRows(source, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 统一落库口径：记录、看板、检查站待办三份数据一次性提交，任何一份写失败整体退回。
function commitState(entries: Record<string, EntryRow[]>): void {
  const board = buildBoard(entries)
  const todos = syncCheckpointTodos(readTodos(), entries.weather ?? [])
  commitAll({
    [STORAGE_KEYS.entries]: entries,
    [STORAGE_KEYS.board]: board,
    [STORAGE_KEYS.todos]: todos,
  })
}

function updateRow(key: string, id: number, patch: (row: EntryRow) => EntryRow): ActionResult {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const next = [...rows]
  next[index] = patch(next[index])
  try {
    commitState({ ...allRows(), [key]: next })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '落库失败，记录与看板已一起退回' }
  }
  return { ok: true, message: '' }
}

// 气象专用流转：规则与其它模块不同，单独走这里。
const WEATHER_TERMINAL = new Set(['已修正', '已归档'])

export function runWeatherAction(id: number, action: '提交审核' | '标记异常'): ActionResult {
  const rows = normalizeWeatherRows(listRows('weather'))
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的气象观测记录` }
  }
  const status = String(row.status)
  if (WEATHER_TERMINAL.has(status)) {
    return { ok: false, message: `记录已「${status}」，不能再执行操作` }
  }
  if (action === '提交审核') {
    if (status !== '已录入') {
      return { ok: false, message: `当前状态「${status}」不能提交审核，仅「已录入」可提交` }
    }
  }
  if (action === '标记异常') {
    if (status === '异常值') {
      return { ok: false, message: '该记录已是异常值，请直接修正或归档' }
    }
  }
  const target: string = action === '提交审核' ? '已审核' : '异常值'
  const result = updateRow('weather', id, (current) => ({
    ...current,
    status: target,
    abnormal: target === '异常值' ? true : current.abnormal,
    pending: !WEATHER_TERMINAL.has(target),
  }))
  if (result.ok) {
    result.message =
      action === '标记异常'
        ? '已标记为异常值，检查站现场核查待办已同步生成；该记录只能修正或归档'
        : '已提交审核'
  }
  return result
}

export function weatherCorrectionSuggestion(id: number): CorrectionDraft | null {
  const rows = normalizeWeatherRows(listRows('weather'))
  const row = rows.find((item) => Number(item.id) === id)
  return row ? suggestCorrection(rows, row) : null
}

export function correctWeatherRecord(id: number, draft: CorrectionDraft): ActionResult {
  const rows = normalizeWeatherRows(listRows('weather'))
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的气象观测记录` }
  }
  if (String(row.status) !== '异常值') {
    return { ok: false, message: '只有「异常值」记录允许修正' }
  }
  const invalid = validateCorrection(draft)
  if (invalid) {
    return { ok: false, message: invalid }
  }
  const corrected = buildCorrectedRow(row, draft)
  const next = [...rows]
  next[next.findIndex((item) => Number(item.id) === id)] = corrected
  try {
    commitState({ ...allRows(), weather: next })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '修正落库失败，记录与看板已一起退回' }
  }
  return { ok: true, message: '记录已按补值修正，异常标记已清除，检查站待办已同步销项' }
}

export function archiveWeatherRecord(id: number, note: string): ActionResult {
  const rows = normalizeWeatherRows(listRows('weather'))
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的气象观测记录` }
  }
  if (String(row.status) !== '异常值') {
    return { ok: false, message: '只有「异常值」记录允许归档' }
  }
  const archived = buildArchivedRow(row, note)
  const next = [...rows]
  next[next.findIndex((item) => Number(item.id) === id)] = archived
  try {
    commitState({ ...allRows(), weather: next })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '归档落库失败，记录与看板已一起退回' }
  }
  return { ok: true, message: '异常记录已按原始采样归档，检查站待办已同步销项' }
}

// 火险取数：气象原始记录覆盖火险缓存读数，与看板同次落库，任一站取数失败整笔退回。
export function pullFirewatchFromWeather(): ActionResult & { summary?: string[] } {
  const entries = allRows()
  let pulled: ReturnType<typeof pullWeatherToFirewatch>
  try {
    pulled = pullWeatherToFirewatch(entries.weather ?? [], entries[FIREWATCH_KEY] ?? [])
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '火险取数失败，未写入任何数据' }
  }
  try {
    commitState({ ...entries, [FIREWATCH_KEY]: pulled.fireRows })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '火险取数落库失败，记录与看板已一起退回' }
  }
  return { ok: true, message: `已按气象原始记录刷新 ${pulled.updatedCount} 个监测点读数，看板同次更新`, summary: pulled.sourceSummary }
}

export function syncCheckpointTodosNow(): ActionResult {
  try {
    commitState(allRows())
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '待办同步失败，未写入' }
  }
  return { ok: true, message: '检查站跨模块待办已按气象异常记录同步' }
}

export function checkpointTodos(onlyOpen = false): SyncTodo[] {
  const todos = syncCheckpointTodos(readTodos(), normalizeWeatherRows(listRows('weather')))
  return onlyOpen ? todos.filter((todo) => todo.status === '待处理') : todos
}

export function abnormalWeatherEntries(): EntryRow[] {
  return listAbnormalRecords(listRows('weather'))
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const current = rows.find((row) => Number(row.id) === id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  if (String(current.status) === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...current,
    status: target,
    pending: target !== lastStatus,
    // 异常标记一旦置上必须随状态显式清除：只认本动作是否负向，且到达正常态时复位。
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)) || (current.abnormal && target !== lastStatus),
  }
  if (target === lastStatus) {
    updated.abnormal = false
  }
  const next = [...rows]
  next[next.indexOf(current)] = updated
  try {
    commitState({ ...allRows(), [key]: next })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '落库失败，记录与看板已一起退回' }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  const rows = key === 'weather' ? normalizeWeatherRows(listRows(key)) : listRows(key)
  for (const row of rows) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
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

export function currentBoard(): BoardSnapshot {
  // 看板只读已提交快照，绝不临时各算各的，保证与记录是同一版。
  return readBoard() ?? buildBoard(allRows())
}

export function loadOverview(): OverviewResult {
  const board = currentBoard()
  return { cards: board.cards, modules: board.modules, updatedAt: board.updatedAt }
}
