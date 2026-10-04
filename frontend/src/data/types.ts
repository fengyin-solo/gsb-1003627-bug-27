/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

// 缺测是一等数据，不是 0：采样时没测到就写这个标记，读数、统计、火险取数都不得把它当成有效零值。
export const MISSING_TOKEN = '缺测'
// 老数据里出现过的缺测写法：读出来时统一归一成 MISSING_TOKEN，按原采样记录兼容，不覆盖历史。
export const LEGACY_MISSING_TOKENS = ['', '--', '—', '-', 'NaN', 'null', 'NULL', '无', '无效', '缺数据', '未测', '/']

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type ModuleMetric = {
  name: string
  created: number
  pending: number
  abnormal: number
  /** 模块自定义指标（如气象三指标），落库后直接读，不临时各算各的。 */
  values: Record<string, number>
}

// 看板快照：与记录同一次事务落库，任何一边写失败两边都退回上一版。
export type BoardSnapshot = {
  updatedAt: string
  cards: { label: string; value: number }[]
  modules: ModuleMetric[]
}

// 检查站跨模块待办：由气象/火险异常驱动，异常产生即开单，异常消解（修正/归档）即销项。
export type SyncTodo = {
  key: string
  sourceModule: string
  sourceId: number
  title: string
  reason: string
  status: '待处理' | '已销项'
  createdAt: string
  resolvedAt: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
  updatedAt?: string
}
