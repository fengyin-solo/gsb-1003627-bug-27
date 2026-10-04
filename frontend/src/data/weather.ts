import type { EntryRow } from './types'

/**
 * 气象观测领域：原始记录（weather）是唯一事实源，火险监测（firewatch）的气象读数由这里派生。
 * 冲突时一律以原始采样记录为准；历史缺测值（"缺测"、-999 等）按原采样记录兼容为 null，
 * 绝不当成有效零值参与火险计算。
 */

export const WEATHER_KEY = 'weather'
export const FIREWATCH_KEY = 'firewatch'

export const WEATHER_READING_FIELDS = ['气温', '相对湿度', '风速风向', '降水量'] as const
export type ReadingField = (typeof WEATHER_READING_FIELDS)[number]

export const WEATHER_NUMERIC_FIELDS = ['气温', '相对湿度', '降水量'] as const
export const WIND_FIELD: ReadingField = '风速风向'

export const ABNORMAL_WEATHER_STATUS = '异常值'
export const CORRECTED_WEATHER_STATUS = '已修正'
export const ARCHIVED_WEATHER_STATUS = '已归档'

/** 历史采样记录里出现过的缺测写法：归一化时统一认作缺测（null），而不是 0。 */
const MISSING_MARKERS = new Set(['', '缺测', '缺失', '无数据', 'nan', 'null', 'n/a', 'na', '-', '--', '—', '－', '/'])
const MISSING_NUMBERS = new Set([-999, -99, -9999])

export function isMissingValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true
  }
  if (typeof value === 'number') {
    return Number.isNaN(value) || MISSING_NUMBERS.has(value)
  }
  if (typeof value === 'boolean') {
    return false
  }
  const text = String(value).trim().toLowerCase()
  if (MISSING_MARKERS.has(text)) {
    return true
  }
  const numeric = Number(text)
  return text !== '' && !Number.isNaN(numeric) && MISSING_NUMBERS.has(numeric)
}

/** 数值字段解析：缺测返回 null；无法解析的非数值文本同样按缺测处理，避免被 Number() 吞成 0。 */
export function parseReading(value: unknown): number | null {
  if (isMissingValue(value)) {
    return null
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  const text = String(value).trim()
  const numeric = Number(text)
  return Number.isFinite(numeric) ? numeric : null
}

/** 从「风速风向」里取风速（m/s）。常见写法："3级 西北风"、"2.5m/s 东北风"。 */
export function parseWindSpeed(value: unknown): number | null {
  if (isMissingValue(value)) {
    return null
  }
  const text = String(value)
  const ms = text.match(/([-+]?\d+(?:\.\d+)?)\s*m\/s/i)
  if (ms) {
    return Number(ms[1])
  }
  const level = text.match(/(\d+(?:\.\d+)?)\s*级/)
  if (level) {
    return levelToMs(Number(level[1]))
  }
  return parseReading(value)
}

/** 蒲福风级各等级风速下限（m/s）：0~12 级。 */
const WIND_LEVEL_MIN_MS = [0, 0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7]

function levelToMs(level: number): number {
  if (level <= 0) {
    return 0
  }
  if (level >= WIND_LEVEL_MIN_MS.length - 1) {
    return WIND_LEVEL_MIN_MS[WIND_LEVEL_MIN_MS.length - 1]
  }
  // 取该等级风速区间的中值，避免「3级」一律按下沿参与火险计算。
  return (WIND_LEVEL_MIN_MS[level] + WIND_LEVEL_MIN_MS[level + 1]) / 2
}

export function msToLevel(ms: number): number {
  let level = 0
  for (let i = 0; i < WIND_LEVEL_MIN_MS.length; i += 1) {
    if (ms >= WIND_LEVEL_MIN_MS[i]) {
      level = i
    }
  }
  return level
}

export type FilledValue = {
  value: number
  /** original=原始采样有效；filled=同站相邻采样补值 */
  source: 'original' | 'filled'
}

type Sample = {
  id: number
  time: string
  temp: number | null
  humidity: number | null
  windMs: number | null
  windText: string | null
  rain: number | null
}

function toSample(row: EntryRow): Sample {
  return {
    id: row.id,
    time: String(row['观测时间'] ?? ''),
    temp: parseReading(row['气温']),
    humidity: parseReading(row['相对湿度']),
    windMs: parseWindSpeed(row['风速风向']),
    windText: isMissingValue(row['风速风向']) ? null : String(row['风速风向']),
    rain: parseReading(row['降水量']),
  }
}

/** 同站时序上对一个缺测点做线性插值；前后都没有有效采样时不补（降水属事件量，同样不凭空补）。 */
function interpolate(samples: Sample[], index: number, pick: (sample: Sample) => number | null): FilledValue | null {
  let before: { sample: Sample; value: number } | null = null
  let after: { sample: Sample; value: number } | null = null
  for (let i = index - 1; i >= 0; i -= 1) {
    const value = pick(samples[i])
    if (value !== null) {
      before = { sample: samples[i], value }
      break
    }
  }
  for (let i = index + 1; i < samples.length; i += 1) {
    const value = pick(samples[i])
    if (value !== null) {
      after = { sample: samples[i], value }
      break
    }
  }
  if (!before && !after) {
    return null
  }
  if (before && !after) {
    return { value: before.value, source: 'filled' }
  }
  if (!before && after) {
    return { value: after.value, source: 'filled' }
  }
  const span = Date.parse(after!.sample.time) - Date.parse(before!.sample.time)
  if (!Number.isFinite(span) || span <= 0) {
    return { value: before!.value, source: 'filled' }
  }
  const ratio = (Date.parse(samples[index].time) - Date.parse(before!.sample.time)) / span
  const clamped = Math.min(1, Math.max(0, ratio))
  return { value: before!.value + (after!.value - before!.value) * clamped, source: 'filled' }
}

/** 同站相邻采样里找一条风向文本（风级由风速数值重建，风向沿用最近一次记录）。 */
function nearestWindText(samples: Sample[], index: number): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (samples[i].windText !== null) {
      return samples[i].windText
    }
  }
  for (let i = index + 1; i < samples.length; i += 1) {
    if (samples[i].windText !== null) {
      return samples[i].windText
    }
  }
  return null
}

export type PreparedWeather = {
  row: EntryRow
  temp: FilledValue | null
  humidity: FilledValue | null
  windMs: FilledValue | null
  rain: FilledValue | null
  /** 风速数值缺测时，沿用的最近一条同站风向文本 */
  windText: string | null
}

/**
 * 补值策略：同一观测站点按观测时间排序，缺测点用相邻有效采样线性插值（气温、湿度、风速）；
 * 降水是事件量，缺测就是缺测，不插值；两侧都没有有效值则保留缺测。原始有效值优先，绝不覆盖。
 */
export function prepareWeatherRows(weatherRows: EntryRow[]): PreparedWeather[] {
  const byStation = new Map<string, EntryRow[]>()
  for (const row of weatherRows) {
    const station = String(row['观测站点'] ?? '')
    const list = byStation.get(station) ?? []
    list.push(row)
    byStation.set(station, list)
  }

  const prepared = new Map<number, PreparedWeather>()
  for (const list of byStation.values()) {
    const sorted = [...list].sort((a, b) => String(a['观测时间'] ?? '').localeCompare(String(b['观测时间'] ?? '')))
    const samples = sorted.map(toSample)
    sorted.forEach((row, index) => {
      const sample = samples[index]
      prepared.set(row.id, {
        row,
        temp: sample.temp === null ? interpolate(samples, index, (item) => item.temp) : { value: sample.temp, source: 'original' },
        humidity:
          sample.humidity === null ? interpolate(samples, index, (item) => item.humidity) : { value: sample.humidity, source: 'original' },
        windMs:
          sample.windMs === null ? interpolate(samples, index, (item) => item.windMs) : { value: sample.windMs, source: 'original' },
        rain: sample.rain === null ? null : { value: sample.rain, source: 'original' },
        windText: sample.windText ?? nearestWindText(samples, index),
      })
    })
  }
  return weatherRows.map((row) => prepared.get(row.id)!)
}

/**
 * 火险等级：以气象原始记录为准，缺测字段不参与，也不按 0 计算。
 * 阈值参考常见林区火险气象规则：高温、低湿、大风推高等级，降水压低等级。
 */
export function deriveFireLevel(input: {
  temp: FilledValue | null
  humidity: FilledValue | null
  windMs: FilledValue | null
  rain: FilledValue | null
}): string {
  let score = 0
  let factors = 0
  if (input.temp) {
    factors += 1
    if (input.temp.value >= 35) {
      score += 3
    } else if (input.temp.value >= 30) {
      score += 2.5
    } else if (input.temp.value >= 25) {
      score += 2
    } else if (input.temp.value >= 20) {
      score += 1
    } else if (input.temp.value >= 10) {
      score += 0.5
    }
  }
  if (input.humidity) {
    factors += 1
    if (input.humidity.value < 25) {
      score += 3
    } else if (input.humidity.value < 40) {
      score += 2
    } else if (input.humidity.value < 55) {
      score += 1
    } else if (input.humidity.value < 70) {
      score += 0.5
    }
  }
  if (input.windMs) {
    factors += 1
    const level = msToLevel(input.windMs.value)
    if (level >= 7) {
      score += 3
    } else if (level >= 5) {
      score += 2
    } else if (level >= 3) {
      score += 1
    }
  }
  if (input.rain) {
    if (input.rain.value >= 10) {
      score -= 3
    } else if (input.rain.value >= 3) {
      score -= 2
    } else if (input.rain.value > 0) {
      score -= 1
    }
  }
  // 三项常规因子全部缺测时无法判定等级，保留缺测语义而不是硬给「正常」。
  if (factors === 0) {
    return '缺测'
  }
  const normalized = factors > 0 ? (score / factors) * 1.4 : 0
  if (normalized >= 3.2) {
    return '红色预警'
  }
  if (normalized >= 2.4) {
    return '橙色预警'
  }
  if (normalized >= 1.5) {
    return '黄色预警'
  }
  if (normalized >= 0.7) {
    return '蓝色预警'
  }
  return '正常'
}

export type FirewatchDerived = {
  station: string
  time: string
  temp: number | null
  humidity: number | null
  windLevel: number | null
  rain: number | null
  level: string
  /** 各取数字段来源：original=气象原始采样，filled=同站相邻采样补值，missing=无有效采样 */
  sources: Record<string, 'original' | 'filled' | 'missing'>
}

export function deriveFirewatchRow(prepared: PreparedWeather, windText: string | null): FirewatchDerived {
  const sources: FirewatchDerived['sources'] = {
    气温读数: prepared.temp ? prepared.temp.source : 'missing',
    相对湿度: prepared.humidity ? prepared.humidity.source : 'missing',
    风力等级: prepared.windMs ? prepared.windMs.source : 'missing',
    降水量: prepared.rain ? prepared.rain.source : 'missing',
  }
  return {
    station: String(prepared.row['观测站点'] ?? ''),
    time: String(prepared.row['观测时间'] ?? ''),
    temp: prepared.temp ? round1(prepared.temp.value) : null,
    humidity: prepared.humidity ? round1(prepared.humidity.value) : null,
    windLevel: prepared.windMs ? msToLevel(prepared.windMs.value) : null,
    rain: prepared.rain ? round1(prepared.rain.value) : null,
    level: deriveFireLevel(prepared),
    sources,
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 火险监测点与气象记录的对应键：同站点 + 同观测时间。 */
export function stationTimeKey(station: unknown, time: unknown): string {
  return `${String(station ?? '').trim()}@@${String(time ?? '').trim()}`
}
