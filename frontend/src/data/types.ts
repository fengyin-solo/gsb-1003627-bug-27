/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

// 数值字段缺测时统一为 null（历史采样里的 "缺测"/-999 等标记在入库归一化时转成 null），
// 绝不能落为 0：0℃、0mm 都是有效观测值。
export type EntryValue = string | number | boolean | null

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: EntryValue
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
  /** 算作待办的状态；不配置时默认为「除最后一个状态外都是待办」。 */
  pendingStatuses?: string[]
  /** 算作异常的状态；不配置的模块沿用历史 abnormal 标记。 */
  abnormalStatuses?: string[]
  /**
   * 状态机：当前状态 -> 该状态下允许的动作。
   * 不配置时退回 actionTargets 的旧逻辑（只挡重复操作）。
   */
  transitions?: Record<string, string[]>
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

export type BoardModule = {
  key: string
  name: string
  created: number
  pending: number
  abnormal: number
}

export type BoardSnapshot = {
  updatedAt: string
  modules: BoardModule[]
  cards: { label: string; value: number }[]
}

/** 一次落库的完整内容：业务记录与看板快照同生共死。 */
export type Database = {
  entries: Record<string, EntryRow[]>
  board: BoardSnapshot
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
  updatedAt: string
}
