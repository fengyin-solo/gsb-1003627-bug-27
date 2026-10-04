import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import type { BoardSnapshot, Database, EntryRow } from './types'
import { WEATHER_READING_FIELDS, isMissingValue } from './weather'

// 本地持久化：记录与看板快照放在同一份 localStorage 里，同次落库、同次退回。
const STORAGE_KEY = 'forest-fire-patrol:entries'

const WEATHER_NUMERIC_FIELDS = new Set<string>(WEATHER_READING_FIELDS)

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isPendingStatus(key: string, status: string): boolean {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    return false
  }
  if (meta.pendingStatuses) {
    return meta.pendingStatuses.includes(status)
  }
  return status !== meta.statuses[meta.statuses.length - 1]
}

function isAbnormalStatus(key: string, status: string): boolean | null {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta || !meta.abnormalStatuses) {
    return null
  }
  return meta.abnormalStatuses.includes(status)
}

/**
 * 入库归一化：
 * - 气象观测数值字段的历史缺测写法（"缺测"、-999 等）统一转 null，保持原采样缺测语义；
 * - pending / abnormal 一律以当前状态重新推导，看板和列表只能拿到同一份事实。
 */
function normalizeRow(key: string, row: EntryRow): EntryRow {
  const normalized: EntryRow = { ...row }
  if (key === 'weather') {
    for (const field of WEATHER_NUMERIC_FIELDS) {
      if (!(field in normalized)) {
        continue
      }
      if (field === '风速风向') {
        if (isMissingValue(normalized[field])) {
          normalized[field] = null
        }
        continue
      }
      // 数值字段：缺测归一为 null；形如 "26.4" 的历史文本还原成数值；其余文本保留原样供人工修正。
      if (isMissingValue(normalized[field])) {
        normalized[field] = null
      } else if (typeof normalized[field] === 'string') {
        const trimmed = normalized[field].trim()
        const numeric = Number(trimmed)
        normalized[field] = trimmed !== '' && Number.isFinite(numeric) ? numeric : normalized[field]
      }
    }
  }
  const status = String(normalized.status ?? '')
  normalized.status = status
  normalized.pending = isPendingStatus(key, status)
  const abnormal = isAbnormalStatus(key, status)
  normalized.abnormal = abnormal === null ? Boolean(normalized.abnormal) : abnormal
  return normalized
}

export function buildBoard(entries: Record<string, EntryRow[]>, updatedAt: string): BoardSnapshot {
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const list = entries[meta.key] ?? []
    return {
      key: meta.key,
      name: meta.name,
      created: list.length,
      pending: list.filter((row) => row.pending).length,
      abnormal: list.filter((row) => row.abnormal).length,
    }
  })
  return {
    updatedAt,
    modules,
    cards: [
      { label: '业务模块', value: modules.length },
      { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
      { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
      { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
    ],
  }
}

function seedDatabase(): Database {
  const entries: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(SEED_ROWS)) {
    entries[key] = rows.map((row) => normalizeRow(key, row))
  }
  return { entries, board: buildBoard(entries, new Date(0).toISOString()) }
}

/** 兼容旧版本：localStorage 里可能直接存的是 Record<string, EntryRow[]>。 */
function migrate(raw: unknown): Database | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const value = raw as Record<string, unknown>
  if (value['entries'] && typeof value['entries'] === 'object') {
    const db = value as unknown as Database
    if (!db.board) {
      db.board = buildBoard(db.entries, new Date(0).toISOString())
    }
    return db
  }
  const entries: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(value)) {
    if (Array.isArray(rows)) {
      entries[key] = (rows as EntryRow[]).map((row) => normalizeRow(key, row))
    }
  }
  if (Object.keys(entries).length === 0) {
    return null
  }
  return { entries, board: buildBoard(entries, new Date(0).toISOString()) }
}

function readStorage(): Database {
  const fallback = seedDatabase()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  try {
    const db = migrate(JSON.parse(raw))
    if (!db) {
      throw new Error('bad storage')
    }
    // 历史数据进内存时也走一遍归一化，旧缺测值即时兼容。
    for (const key of Object.keys(db.entries)) {
      db.entries[key] = db.entries[key].map((row) => normalizeRow(key, row))
    }
    db.board = buildBoard(db.entries, db.board?.updatedAt ?? new Date(0).toISOString())
    return db
  } catch {
    persist(fallback)
    return fallback
  }
}

function persist(db: Database): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  // 先序列化再写入：序列化失败不会污染任何状态；setItem 抛错（配额/隐私模式）时调用方整体回退。
  const serialized = JSON.stringify(db)
  window.localStorage.setItem(STORAGE_KEY, serialized)
}

let cache: Database | null = null

export function db(): Database {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return db().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/** 单模块提交：记录与看板快照同次落库，任一步失败一起退回落库前状态。 */
export function commit(nextEntries: Record<string, EntryRow[]>): Database {
  const previous = db()
  const snapshot = clone(previous)
  // 所有进入提交的数据统一归一化：历史缺测转 null、pending/abnormal 由状态重算，
  // 保证记录与看板在同一份事实上生成，杜绝「记录已改、看板还是旧标记」。
  const normalizedEntries: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(nextEntries)) {
    normalizedEntries[key] = rows.map((row) => normalizeRow(key, row))
  }
  const candidate: Database = {
    entries: normalizedEntries,
    board: buildBoard(normalizedEntries, new Date().toISOString()),
  }
  try {
    persist(candidate)
  } catch (error) {
    // 落库失败：内存恢复到提交前，记录与看板都不留半成品。
    cache = snapshot
    throw new Error(error instanceof Error ? `数据落库失败，已整体退回：${error.message}` : '数据落库失败，已整体退回')
  }
  cache = candidate
  return candidate
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commit({ ...allRows(), [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? []).map((row) => normalizeRow(key, row))
  commit({ ...allRows(), [key]: rows })
  return rows
}

export function boardSnapshot(): BoardSnapshot {
  return db().board
}

export function resetAll(): Database {
  const fallback = seedDatabase()
  commit(fallback.entries)
  return db()
}

export function storageKey(): string {
  return STORAGE_KEY
}
