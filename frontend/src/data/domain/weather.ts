import { MODULE_BY_KEY } from '@/data/modules'
import {
  LEGACY_MISSING_TOKENS,
  MISSING_TOKEN,
  type BoardSnapshot,
  type EntryRow,
  type ModuleMetric,
  type SyncTodo,
} from '@/data/types'

// 气象领域规则：所有读数、异常、补值、火险取数都走这里，保证列表、异常面板、火险三处口径一致。

export const WEATHER_KEY = 'weather'
export const FIREWATCH_KEY = 'firewatch'

export const WEATHER_NUMERIC_FIELDS = ['气温', '相对湿度', '降水量'] as const
export const WIND_FIELD = '风速风向'
export const WEATHER_MEASURE_FIELDS = [...WEATHER_NUMERIC_FIELDS, WIND_FIELD]

// 气象状态口径：异常值仍待处理，修正/归档才是收尾。
const TERMINAL_STATUSES = new Set(['已修正', '已归档'])
const ABNORMAL_STATUS = '异常值'
const CORRECTED_STATUS = '已修正'
const ARCHIVED_STATUS = '已归档'

// ---------- 缺测归一 ----------

// 老系统的缺测写法五花八门（空串、--、无、NaN…），读出来统一成 MISSING_TOKEN。
// 只做表示层归一，绝不补 0：缺测就是缺测，任何数值计算都跳过它。
export function normalizeCell(raw: unknown): string {
  if (raw === null || raw === undefined) {
    return MISSING_TOKEN
  }
  const text = String(raw).trim()
  if (text === MISSING_TOKEN || LEGACY_MISSING_TOKENS.includes(text)) {
    return MISSING_TOKEN
  }
  return text
}

export function isMissing(raw: unknown): boolean {
  return normalizeCell(raw) === MISSING_TOKEN
}

// 读数用：拿不到有效数值一律返回 null，由调用方决定跳过/报缺，禁止用 0 顶替。
export function parseNumber(raw: unknown): number | null {
  if (isMissing(raw)) {
    return null
  }
  const matched = String(raw).trim().match(/-?\d+(\.\d+)?/)
  if (!matched) {
    return null
  }
  const value = Number(matched[0])
  return Number.isFinite(value) ? value : null
}

export function parseWindLevel(raw: unknown): number | null {
  if (isMissing(raw)) {
    return null
  }
  const matched = String(raw).match(/(\d+(?:\.\d+)?)\s*级/)
  if (!matched) {
    return null
  }
  const value = Number(matched[1])
  return Number.isFinite(value) ? value : null
}

function parseWindDirection(raw: unknown): string | null {
  if (isMissing(raw)) {
    return null
  }
  const matched = String(raw).match(/^([东南西北无持续]{2,4})风/)
  return matched ? matched[1] : null
}

export function normalizeWeatherRow(row: EntryRow): EntryRow {
  const next: EntryRow = { ...row }
  for (const field of WEATHER_MEASURE_FIELDS) {
    next[field] = normalizeCell(next[field])
  }
  // 状态与标志位以状态字段为准，防止历史数据标志位与状态互相打架。
  next.abnormal = row.abnormal === true || row.status === ABNORMAL_STATUS
  next.pending = weatherPending(next)
  return next
}

export function normalizeWeatherRows(rows: EntryRow[]): EntryRow[] {
  return rows.map(normalizeWeatherRow)
}

export function weatherAbnormal(row: EntryRow): boolean {
  return row.status === ABNORMAL_STATUS || row.abnormal === true
}

export function weatherPending(row: EntryRow): boolean {
  return !TERMINAL_STATUSES.has(String(row.status))
}

// 异常面板：按记录 id 去重，同一条只留最新版本，刷新后不会再重复挂着旧值。
export function listAbnormalRecords(rows: EntryRow[]): EntryRow[] {
  const latest = new Map<number, EntryRow>()
  for (const row of normalizeWeatherRows(rows)) {
    if (!weatherAbnormal(row)) {
      continue
    }
    latest.set(Number(row.id), row)
  }
  return [...latest.values()].sort((a, b) => String(a['观测时间']).localeCompare(String(b['观测时间'])))
}

// ---------- 修正补值 ----------

export type CorrectionDraft = {
  temp: number | null
  humidity: number | null
  precip: number | null
  windDir: string
  windLevel: number | null
  note: string
}

function parseSampleTime(value: unknown): number {
  const time = Date.parse(String(value).replace(' ', 'T'))
  return Number.isFinite(time) ? time : 0
}

function round(value: number, digits: 0 | 1): number {
  const factor = digits === 1 ? 10 : 1
  return Math.round(value * factor) / factor
}

// 补值做法：同观测站点、按采样时间找最近的有效样本做线性插值（前一样本 + 后一样本按时间距离加权），
// 同站点没有可用样本时退回到全部站点的最近有效值均值；仍然没有就留空由观测员手填。
// 缺测样本本身不参与插值，保证不会把缺测当 0 拉低结果。
function interpolateMetric(
  rows: EntryRow[],
  station: string,
  targetTime: number,
  read: (row: EntryRow) => number | null,
  digits: 0 | 1,
): number | null {
  const samples = rows
    .filter((row) => String(row['观测站点']) === station)
    .map((row) => ({ time: parseSampleTime(row['观测时间']), value: read(row) }))
    .filter((item): item is { time: number; value: number } => item.value !== null && item.time > 0)

  if (samples.length === 0) {
    return null
  }
  const before = samples.filter((item) => item.time <= targetTime).sort((a, b) => b.time - a.time)[0]
  const after = samples.filter((item) => item.time > targetTime).sort((a, b) => a.time - b.time)[0]
  if (before && after) {
    const span = after.time - before.time
    const weight = span === 0 ? 0.5 : (targetTime - before.time) / span
    return round(before.value + (after.value - before.value) * weight, digits)
  }
  const only = before ?? after
  return only ? round(only.value, digits) : null
}

function meanOfNearest(rows: EntryRow[], read: (row: EntryRow) => number | null, digits: 0 | 1): number | null {
  const values = rows.map(read).filter((value): value is number => value !== null)
  if (values.length === 0) {
    return null
  }
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, digits)
}

export function suggestCorrection(rows: EntryRow[], target: EntryRow): CorrectionDraft {
  const station = String(target['观测站点'])
  const targetTime = parseSampleTime(target['观测时间'])
  const peers = rows.filter((row) => Number(row.id) !== Number(target.id))

  const temp =
    interpolateMetric(peers, station, targetTime, (row) => parseNumber(row['气温']), 1) ??
    meanOfNearest(peers, (row) => parseNumber(row['气温']), 1)
  const humidity =
    interpolateMetric(peers, station, targetTime, (row) => parseNumber(row['相对湿度']), 0) ??
    meanOfNearest(peers, (row) => parseNumber(row['相对湿度']), 0)
  const precip =
    interpolateMetric(peers, station, targetTime, (row) => parseNumber(row['降水量']), 1) ??
    meanOfNearest(peers, (row) => parseNumber(row['降水量']), 1)

  const wind =
    interpolateMetric(peers, station, targetTime, (row) => parseWindLevel(row[WIND_FIELD]), 0) ??
    meanOfNearest(peers, (row) => parseWindLevel(row[WIND_FIELD]), 0)

  const sameStation = peers
    .filter((row) => String(row['观测站点']) === station)
    .sort((a, b) => Math.abs(parseSampleTime(a['观测时间']) - targetTime) - Math.abs(parseSampleTime(b['观测时间']) - targetTime))
  const windDir = sameStation.map((row) => parseWindDirection(row[WIND_FIELD])).find(Boolean) ?? '无持续风向'

  return { temp, humidity, precip, windDir, windLevel: wind, note: '' }
}

const FIELD_RANGES: Record<string, [number, number]> = {
  temp: [-60, 60],
  humidity: [0, 100],
  precip: [0, 1000],
  windLevel: [0, 17],
}

export function validateCorrection(draft: CorrectionDraft): string | null {
  const checks: [keyof CorrectionDraft, string][] = [
    ['temp', '气温'],
    ['humidity', '相对湿度'],
    ['precip', '降水量'],
    ['windLevel', '风力等级'],
  ]
  for (const [key, label] of checks) {
    const value = draft[key] as number | null
    if (value === null || Number.isNaN(value)) {
      return `请补全${label}（缺测项不能直接修正，需给出有效数值）`
    }
    const [min, max] = FIELD_RANGES[key]
    if (value < min || value > max) {
      return `${label}超出合理范围（${min}~${max}），请核对`
    }
  }
  if (!draft.windDir.trim()) {
    return '请选择风向'
  }
  return null
}

function composeWind(draft: CorrectionDraft): string {
  return draft.windLevel === 0 ? '无风' : `${draft.windDir}风${draft.windLevel}级`
}

// 修正即落值：以确认后的补值覆盖读数，原始采样完整留痕，冲突追溯时仍能看到原记录。
export function buildCorrectedRow(row: EntryRow, draft: CorrectionDraft): EntryRow {
  return {
    ...row,
    气温: String(round(draft.temp as number, 1)),
    相对湿度: String(round(draft.humidity as number, 0)),
    降水量: String(round(draft.precip as number, 1)),
    [WIND_FIELD]: composeWind(draft),
    原始采样: JSON.stringify({
      气温: normalizeCell(row['气温']),
      相对湿度: normalizeCell(row['相对湿度']),
      降水量: normalizeCell(row['降水量']),
      [WIND_FIELD]: normalizeCell(row[WIND_FIELD]),
    }),
    修正说明: draft.note.trim() || '异常值修正，补值取同站点相邻采样插值并经观测员确认',
    修正时间: formatNow(),
    status: CORRECTED_STATUS,
    pending: false,
    abnormal: false,
  }
}

export function buildArchivedRow(row: EntryRow, note: string): EntryRow {
  return {
    ...row,
    归档说明: note.trim() || '异常记录无法现场复核，按原始采样记录归档备查',
    归档时间: formatNow(),
    status: ARCHIVED_STATUS,
    pending: false,
    abnormal: false,
  }
}

export function formatNow(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---------- 火险取数 ----------

export type FireRatingInput = {
  temp: number
  humidity: number
  windLevel: number
  precip: number
}

const FIRE_LEVELS = ['正常', '蓝色预警', '黄色预警', '橙色预警', '红色预警']

// 按升序分档计 0~4 分：value 越过的档位越多分越高。
function scoreMetric(value: number, bands: number[]): number {
  return bands.reduce((level, edge) => (value > edge ? level + 1 : level), 0)
}

function fireDangerScore(input: FireRatingInput): number {
  // 湿度越低、气温越高、风力越大、降水越少，分值越高（每项 0~4）。
  const humidityScore = scoreMetric(100 - input.humidity, [10, 25, 40, 60])
  const tempScore = scoreMetric(input.temp, [10, 20, 28, 35])
  const windScore = scoreMetric(input.windLevel, [2, 3, 4, 5])
  const precipScore = scoreMetric(0 - input.precip, [-10, -5, -1, -0.1])
  return humidityScore + tempScore + windScore + precipScore
}

export function rateFireDanger(input: FireRatingInput): string {
  const score = fireDangerScore(input)
  if (score <= 4) {
    return FIRE_LEVELS[0]
  }
  if (score <= 8) {
    return FIRE_LEVELS[1]
  }
  if (score <= 11) {
    return FIRE_LEVELS[2]
  }
  if (score <= 14) {
    return FIRE_LEVELS[3]
  }
  return FIRE_LEVELS[4]
}

type WeatherSample = { row: EntryRow; time: number }

function latestValidSample(samples: WeatherSample[], read: (row: EntryRow) => number | null): EntryRow | null {
  return samples
    .filter((sample) => read(sample.row) !== null)
    .sort((a, b) => b.time - a.time)[0]?.row ?? null
}

export type PullResult = {
  fireRows: EntryRow[]
  updatedCount: number
  sourceSummary: string[]
}

// 火险取数：冲突时一律以气象原始记录为准（直接覆盖监测点缓存读数）。
// 按字段各自取该站点最近一次「有效采样」：某个时次缺测的字段沿用上一有效时次，
// 该站点从来没有该字段的有效采样则整笔取数失败——绝不写 0，调用方随事务整体退回。
export function pullWeatherToFirewatch(weatherRowsRaw: EntryRow[], fireRowsRaw: EntryRow[]): PullResult {
  const weatherRows = normalizeWeatherRows(weatherRowsRaw)
  const sourceSummary: string[] = []

  const fireRows = fireRowsRaw.map((point) => {
    const station = String(point['监测区域'])
    const samples: WeatherSample[] = weatherRows
      .filter((row) => String(row['观测站点']) === station)
      .map((row) => ({ row, time: parseSampleTime(row['观测时间']) }))
      .filter((sample) => sample.time > 0)

    if (samples.length === 0) {
      throw new Error(`监测点「${station}」在气象观测中没有任何同站点原始记录，已取消本次取数`)
    }

    const tempRow = latestValidSample(samples, (row) => parseNumber(row['气温']))
    const humidityRow = latestValidSample(samples, (row) => parseNumber(row['相对湿度']))
    const windRow = latestValidSample(samples, (row) => parseWindLevel(row[WIND_FIELD]))
    const precipRow = latestValidSample(samples, (row) => parseNumber(row['降水量']))

    const missingField = [
      tempRow ? null : '气温',
      humidityRow ? null : '相对湿度',
      windRow ? null : '风力',
      precipRow ? null : '降水量',
    ].find(Boolean)
    if (missingField) {
      throw new Error(`监测点「${station}」缺少${missingField}的有效采样（仅有缺测记录），已取消本次取数`)
    }

    const temp = parseNumber(tempRow!['气温']) as number
    const humidity = parseNumber(humidityRow!['相对湿度']) as number
    const windLevel = parseWindLevel(windRow![WIND_FIELD]) as number
    const precip = parseNumber(precipRow!['降水量']) as number
    const level = rateFireDanger({ temp, humidity, windLevel, precip })

    sourceSummary.push(`${station} ← ${String(tempRow!['记录编号'])}（${String(tempRow!['观测时间'])}）`)

    return {
      ...point,
      气温读数: String(round(temp, 1)),
      相对湿度: String(round(humidity, 0)),
      风力等级: `${windLevel}级`,
      火险等级: level,
      监测时间: String(tempRow!['观测时间']),
      取数来源: `气象 ${String(tempRow!['记录编号'])}`,
    }
  })

  return { fireRows, updatedCount: fireRows.length, sourceSummary }
}

// ---------- 看板 ----------

function isToday(value: unknown): boolean {
  return String(value).slice(0, 10) === formatNow().slice(0, 10)
}

function modulePending(key: string, row: EntryRow): boolean {
  if (key === WEATHER_KEY) {
    return weatherPending(row)
  }
  const meta = MODULE_BY_KEY.get(key)
  const lastStatus = meta?.statuses[meta.statuses.length - 1]
  return lastStatus ? row.status !== lastStatus : Boolean(row.pending)
}

function moduleAbnormal(key: string, row: EntryRow): boolean {
  if (key === WEATHER_KEY) {
    return weatherAbnormal(row)
  }
  return row.abnormal === true
}

export function buildBoard(allEntries: Record<string, EntryRow[]>): BoardSnapshot {
  const modules: ModuleMetric[] = [...MODULE_BY_KEY.values()].map((meta) => {
    const rows = meta.key === WEATHER_KEY ? normalizeWeatherRows(allEntries[meta.key] ?? []) : allEntries[meta.key] ?? []
    const values: Record<string, number> = {}
    if (meta.key === WEATHER_KEY) {
      values['今日观测数'] = rows.filter((row) => isToday(row['观测时间'])).length
      values['待审核记录'] = rows.filter((row) => String(row.status) === '已录入').length
      values['异常记录数'] = rows.filter((row) => weatherAbnormal(row)).length
    } else if (meta.key === FIREWATCH_KEY) {
      values['监测点数'] = rows.length
      values['红色预警数'] = rows.filter((row) => String(row.status) === '红色预警').length
      values['今日新增预警'] = rows.filter(
        (row) => String(row.status) !== '正常' && isToday(row['监测时间']),
      ).length
    }
    return {
      name: meta.name,
      created: rows.length,
      pending: rows.filter((row) => modulePending(meta.key, row)).length,
      abnormal: rows.filter((row) => moduleAbnormal(meta.key, row)).length,
      values,
    }
  })

  return {
    updatedAt: formatNow(),
    cards: [
      { label: '业务模块', value: modules.length },
      { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
      { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
      { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
    ],
    modules,
  }
}

// ---------- 检查站跨模块待办 ----------

function todoKey(sourceModule: string, id: number): string {
  return `${sourceModule}:${id}`
}

// 检查站待办与气象异常一一对应（按来源 id 去重）：异常产生即开单，修正/归档即销项。
// 历史已销项记录保留并标注销项时间，刷新不重复开单。
export function syncCheckpointTodos(existing: SyncTodo[], weatherRowsRaw: EntryRow[]): SyncTodo[] {
  const weatherRows = normalizeWeatherRows(weatherRowsRaw)
  const byKey = new Map(existing.map((todo) => [todo.key, todo]))
  const now = formatNow()

  for (const row of weatherRows) {
    const key = todoKey(WEATHER_KEY, Number(row.id))
    const open = weatherAbnormal(row)
    const previous = byKey.get(key)
    if (open) {
      byKey.set(key, {
        key,
        sourceModule: '气象观测',
        sourceId: Number(row.id),
        title: `现场核查 ${String(row['记录编号'])}（${String(row['观测站点'])}）`,
        reason: `该观测记录状态为「异常值」，观测时间 ${String(row['观测时间'])}，需检查站现场核对后修正或归档`,
        status: '待处理',
        createdAt: previous?.createdAt ?? now,
        resolvedAt: '',
      })
    } else if (previous?.status === '待处理') {
      byKey.set(key, {
        ...previous,
        status: '已销项',
        reason: `记录已「${String(row.status)}」，待办自动销项`,
        resolvedAt: now,
      })
    }
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === '待处理' ? -1 : 1
    }
    return b.createdAt.localeCompare(a.createdAt)
  })
}
