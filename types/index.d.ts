export type RateWindow = { kind: string; percentUsed: number; resetsAt?: string }

export type Measure = {
  /** Когда снят замер, мс. */
  at: number
  /** Входные токены последнего ответа: сколько занято в окне. */
  tokens?: number
  /** Окно модели в токенах. */
  window: number
  percent?: number
  /** Порог автосжатия; нет, когда автосжатие выключено или ещё не посчитано. */
  threshold?: number
  isAutoCompactOff?: boolean
  rateLimits: RateWindow[]
  usd?: number
}

export type ScanSession = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  usd: number
  responses: number
  lastAt: number
  ttlMin: number
}

export type Scan = {
  at: number
  tzOffsetMin?: number
  totals?: { usd: number; tokens: number; sessions: number; since: string }
  today?: { usd: number; tokens: number }
  session?: ScanSession | null
  error?: string
}

/** Ответ модели, который идёт прямо сейчас (основной цикл). */
export type Live = { startedAt: number; firstAt?: number; chars: number; at: number }

export type Speed = {
  tokens: number
  ms: number
  responses: number
  lastAt?: number
  last?: { tokens: number; ms: number }
}

export type DetailRow = { name: string; tokens: number; kind: string }

export type Details = {
  at: number
  model: string
  window: number
  total: number
  threshold?: number
  rows: DetailRow[]
  error?: string
}

/** Какие части панели показывать: поля userConfig, общие для всех сессий. */
export type Prefs = {
  showContext: boolean
  showLimits: boolean
  showSpeed: boolean
  showSession: boolean
  showTotal: boolean
  showWarnings: boolean
  showStatusLine: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'context-gauge': {
      prefs: Prefs
      measured: Measure | null
      scanned: Scan | null
      live: Live | null
      speed: Speed
      tick: number
      dismissed: string[]
      isHidden: boolean
      details: Details | null
    }
  }
}
