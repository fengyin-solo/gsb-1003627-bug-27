import { SEED_ROWS } from './seed'
import type { BoardSnapshot, EntryRow, SyncTodo } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const ENTRIES_KEY = 'forest-fire-patrol:entries'
const BOARD_KEY = 'forest-fire-patrol:board'
const TODO_KEY = 'forest-fire-patrol:checkpoint-todos'
// 事务日志：先落 WAL 再覆盖正式键，正式键写成功才清 WAL；刷新/中断时靠它判断并整体回滚。
const WAL_KEY = 'forest-fire-patrol:tx-wal'

export const STORAGE_KEYS = {
  entries: ENTRIES_KEY,
  board: BOARD_KEY,
  todos: TODO_KEY,
  wal: WAL_KEY,
} as const

type StorageValue = Record<string, EntryRow[]> | BoardSnapshot | SyncTodo[]

export type CommitMap = {
  [ENTRIES_KEY]?: Record<string, EntryRow[]>
  [BOARD_KEY]?: BoardSnapshot
  [TODO_KEY]?: SyncTodo[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function rawGet(key: string): string | null {
  return hasStorage() ? window.localStorage.getItem(key) : null
}

function rawSet(key: string, value: string): void {
  if (!hasStorage()) {
    return
  }
  window.localStorage.setItem(key, value)
}

// 模拟后端事务提交：记录与看板必须同次落库。
// 步骤：① 把待提交内容连同各键旧值写入 WAL；② 逐键覆盖；③ 清 WAL。
// 任一步抛错（配额、序列化失败等）都按 WAL 里的旧值回滚，保证不会出现记录变了看板没变。
export function commitAll(updates: CommitMap): void {
  if (!hasStorage()) {
    Object.entries(updates).forEach(([key, value]) => {
      memoryCache[key] = clone(value) as StorageValue
    })
    return
  }
  const payloads: Record<string, string> = {}
  const previous: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(updates)) {
    payloads[key] = JSON.stringify(value)
    previous[key] = window.localStorage.getItem(key)
  }
  try {
    window.localStorage.setItem(WAL_KEY, JSON.stringify({ previous, payloads }))
  } catch (error) {
    throw new Error(`事务提交失败（写入日志阶段）：${(error as Error).message}`)
  }
  const applied: string[] = []
  try {
    for (const [key, value] of Object.entries(payloads)) {
      window.localStorage.setItem(key, value)
      applied.push(key)
    }
    window.localStorage.removeItem(WAL_KEY)
  } catch (error) {
    // 覆盖到一半失败：已写的键按 WAL 旧值退回，没写的本来就还是旧值。
    applied.forEach((key) => {
      const old = previous[key]
      if (old === null) {
        window.localStorage.removeItem(key)
      } else {
        window.localStorage.setItem(key, old)
      }
    })
    window.localStorage.removeItem(WAL_KEY)
    throw new Error(`事务提交失败，已全部回滚：${(error as Error).message}`)
  }
  Object.entries(updates).forEach(([key, value]) => {
    memoryCache[key] = clone(value) as StorageValue
  })
}

// 打开时先看上次是否烂尾：WAL 还在说明正式键没写完，按旧值整笔退回。
function recoverPendingTx(): void {
  if (!hasStorage()) {
    return
  }
  const raw = window.localStorage.getItem(WAL_KEY)
  if (!raw) {
    return
  }
  try {
    const wal = JSON.parse(raw) as {
      previous: Record<string, string | null>
      payloads: Record<string, string>
    }
    Object.keys(wal.payloads ?? {}).forEach((key) => {
      const old = wal.previous[key]
      if (old === undefined || old === null) {
        window.localStorage.removeItem(key)
      } else {
        window.localStorage.setItem(key, old)
      }
    })
  } catch {
    // WAL 自身损坏时不动正式键，交给后续默认播种逻辑兜底。
  }
  window.localStorage.removeItem(WAL_KEY)
}

// 非 localStorage 环境（如测试）下的兜底存储。
const memoryCache: Record<string, StorageValue> = {}

let recovered = false

function seedEntries(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (!hasStorage()) {
    return fallback
  }
  const raw = window.localStorage.getItem(ENTRIES_KEY)
  if (!raw) {
    window.localStorage.setItem(ENTRIES_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(ENTRIES_KEY, JSON.stringify(fallback))
    return fallback
  }
}

export function allRows(): Record<string, EntryRow[]> {
  if (!hasStorage()) {
    const key = ENTRIES_KEY
    if (!(key in memoryCache)) {
      memoryCache[key] = clone(SEED_ROWS)
    }
    return memoryCache[key] as Record<string, EntryRow[]>
  }
  // 每次都读「已提交」的存储内容：任何提交路径（包括直接调 commitAll）都立刻对读侧可见，
  // 避免长生命周期缓存把旧值继续喂给列表、异常面板与火险取数。
  if (!recovered) {
    recoverPendingTx()
    recovered = true
  }
  return seedEntries()
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 仅保存单个模块：看板与待办不在本次更新范围内时保持原键不动（事务里只写给出的键）。
export function saveRows(key: string, rows: EntryRow[]): void {
  commitAll({ [ENTRIES_KEY]: { ...allRows(), [key]: rows } })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function readBoard(): BoardSnapshot | null {
  const raw = rawGet(BOARD_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as BoardSnapshot
  } catch {
    return null
  }
}

export function readTodos(): SyncTodo[] {
  const raw = rawGet(TODO_KEY)
  if (!raw) {
    return []
  }
  try {
    return JSON.parse(raw) as SyncTodo[]
  } catch {
    return []
  }
}

export function storageKey(): string {
  return ENTRIES_KEY
}
