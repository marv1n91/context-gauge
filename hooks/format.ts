// Русское форматирование чисел, денег, сроков и дат для панели.
const NBSP = ' '
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
const MONTHS = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.']

const comma = (text: string) => text.replace('.', ',')
const pad = (n: number) => String(n).padStart(2, '0')

export function group(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
}

/** 595, 1,2 тыс., 152 тыс., 1,86 млн, 119 млрд */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  const units: [number, string][] = [
    [1e9, 'млрд'],
    [1e6, 'млн'],
    [1e3, 'тыс.'],
  ]
  const [size, unit] = units.find(([size]) => n >= size) ?? [1e3, 'тыс.']
  const value = n / size
  const digits = value < 10 ? 2 : value < 100 ? 1 : 0
  const fixed = value.toFixed(digits)
  const text = digits > 0 ? fixed.replace(/\.?0+$/, '') : fixed

  return `${comma(text)}${NBSP}${unit}`
}

/** $44,38 · $36 530 */
export function usd(n: number): string {
  return n >= 1000 ? `$${group(n)}` : `$${comma(n.toFixed(2))}`
}

export function percent(n: number): string {
  return `${Math.round(n)}${NBSP}%`
}

/** 7,9 с · 42 с */
export function seconds(ms: number): string {
  const s = ms / 1000

  return `${s < 10 ? comma(s.toFixed(1)) : Math.round(s)}${NBSP}с`
}

/** 53 мин · 2 ч 47 мин · 5 дн 10 ч */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}${NBSP}мин`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}${NBSP}ч ${minutes % 60}${NBSP}мин`

  return `${Math.floor(hours / 24)}${NBSP}дн ${hours % 24}${NBSP}ч`
}

/** чт, 29 окт., 13:00 — в часовом поясе компьютера (смещение как у getTimezoneOffset). */
export function when(ms: number, tzOffsetMin: number): string {
  const d = new Date(ms - tzOffsetMin * 60_000)

  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** 2026-08-31 → 31.08.2026 */
export function day(iso: string): string {
  const [y, m, d] = iso.split('-')

  return `${d}.${m}.${y}`
}

/** plural(3, ['сессия', 'сессии', 'сессий']) → сессии */
export function plural(n: number, forms: [string, string, string]): string {
  const tens = n % 100
  const ones = n % 10
  if (tens >= 11 && tens <= 14) return forms[2]
  if (ones === 1) return forms[0]
  if (ones >= 2 && ones <= 4) return forms[1]

  return forms[2]
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5 ч',
  seven_day: 'неделя',
  seven_day_opus: 'неделя Opus',
  seven_day_sonnet: 'неделя Sonnet',
  spend_limit: 'расходы',
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5-часовой лимит',
  seven_day: 'недельный лимит',
  seven_day_opus: 'недельный лимит Opus',
  seven_day_sonnet: 'недельный лимит Sonnet',
  spend_limit: 'лимит расходов',
}

export const windowLabel = (kind: string) => WINDOW_LABELS[kind] ?? kind
export const windowName = (kind: string) => WINDOW_NAMES[kind] ?? `лимит ${kind}`

/** Длина окна лимита, мс; нет для окна неизвестной длины. */
export function windowLength(kind: string): number | undefined {
  if (kind === 'five_hour') return 5 * 3_600_000
  if (kind.startsWith('seven_day')) return 7 * 86_400_000

  return undefined
}
