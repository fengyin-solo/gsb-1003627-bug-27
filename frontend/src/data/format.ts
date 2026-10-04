import { isMissingValue } from './weather'

/** 列表/面板展示：缺测（null、历史缺测标记）显示「缺测」，有效零值正常显示 0。 */
export function displayValue(value: unknown): string {
  if (isMissingValue(value)) {
    return '缺测'
  }
  return String(value)
}

export function todayString(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
