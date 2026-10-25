import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionUsage, Timer } from 'claude-code'

import type { Details, Measure, Prefs, RateWindow, Speed } from '../types'
import * as f from './format'

const PANE = 'context-gauge'
// Грубая оценка для живой скорости: модель отдаёт текст, а не токены.
const CHARS_PER_TOKEN = 3.5
// Раз в 15 с панель сверяет настройки с другими сессиями, раз в 2 мин пересчитывает логи.
const TICK_MS = 15_000
const SCAN_EVERY_TICKS = 8
const EMPTY_SPEED: Speed = { tokens: 0, ms: 0, responses: 0 }

const measured = atom({ plugin: 'context-gauge', key: 'measured' } as const, null)
const scanned = atom({ plugin: 'context-gauge', key: 'scanned' } as const, null)
const live = atom({ plugin: 'context-gauge', key: 'live' } as const, null)
const speed = atom({ plugin: 'context-gauge', key: 'speed' } as const, EMPTY_SPEED)
const tick = atom({ plugin: 'context-gauge', key: 'tick' } as const, 0)
const dismissed = atom({ plugin: 'context-gauge', key: 'dismissed' } as const, [])
const isHidden = atom({ plugin: 'context-gauge', key: 'isHidden' } as const, false)
const details = atom({ plugin: 'context-gauge', key: 'details' } as const, null)

type Usage = Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>
type Tone = 'success' | 'warning' | 'error'

const SVG_COLORS: Record<Tone, string> = { success: '#3fb950', warning: '#d29922', error: '#f85149' }

const SETTINGS_PANE = 'context-gauge-settings'
// Что можно скрыть: поля userConfig из plugin.json, по умолчанию всё включено.
const PARTS = [
  { field: 'showContext', label: 'Контекст' },
  { field: 'showLimits', label: 'Лимиты' },
  { field: 'showSpeed', label: 'Скорость' },
  { field: 'showSession', label: 'Сессия' },
  { field: 'showTotal', label: 'Всего' },
  { field: 'showWarnings', label: 'Предупреждения о темпе лимитов' },
  { field: 'showStatusLine', label: 'Строка состояния внизу' },
] as const
type Part = (typeof PARTS)[number]['field']

const ALL_SHOWN: Prefs = {
  showContext: true,
  showLimits: true,
  showSpeed: true,
  showSession: true,
  showTotal: true,
  showWarnings: true,
  showStatusLine: true,
}
const prefs = atom({ plugin: 'context-gauge', key: 'prefs' } as const, ALL_SHOWN)
// Значения из настроек на момент загрузки мода.
let loaded: Prefs = ALL_SHOWN

const tone = (pct: number): Tone => (pct >= 85 ? 'error' : pct >= 60 ? 'warning' : 'success')
const clamp = (pct: number) => Math.min(100, Math.max(0, pct))

function svgBar(pct: number, color: string, width: number): string {
  const height = 8
  const filled = pct > 0 ? Math.max(height, Math.round((width * pct) / 100)) : 0
  const fill = filled > 0 ? `<rect width="${filled}" height="${height}" rx="4" fill="${color}"/>` : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" rx="4" fill="rgba(128,128,128,0.3)"/>${fill}</svg>`
}

/** Сколько занято от порога автосжатия (или от окна, если сжатие выключено). */
function contextShare(m: Measure): { used: number; limit: number; pct: number } | undefined {
  if (m.tokens === undefined) return undefined
  const limit = m.threshold ?? m.window

  return { used: m.tokens, limit, pct: (m.tokens / limit) * 100 }
}

function statusLine(m: Measure): string {
  const parts: string[] = []
  const share = contextShare(m)
  if (share) parts.push(`контекст ${f.percent(share.pct)}`)
  if (share && m.threshold !== undefined) parts.push(`до сжатия ${f.tokens(Math.max(0, m.threshold - share.used))}`)
  if (m.usd !== undefined) parts.push(f.usd(m.usd))
  for (const w of m.rateLimits) parts.push(`${f.windowLabel(w.kind)} ${f.percent(w.percentUsed)}`)

  return parts.join(' · ')
}

type Warning = { key: string; title: string; detail: string; isOver: boolean }

/** Окна лимитов, которые при нынешнем темпе кончатся до сброса (или уже кончились). */
function warningsOf(windows: RateWindow[], now: number, tz: number, hidden: string[]): Warning[] {
  const found: Warning[] = []
  for (const w of windows) {
    const length = f.windowLength(w.kind)
    const reset = w.resetsAt === undefined ? NaN : Date.parse(w.resetsAt)
    if (length === undefined || !(reset > now)) continue
    const key = `${w.kind}@${w.resetsAt}`
    if (hidden.includes(key)) continue
    const resetText = `Сброс: ${f.when(reset, tz)}`
    if (w.percentUsed >= 100) {
      found.push({ key, title: `${f.windowName(w.kind)} исчерпан`, detail: resetText, isOver: true })
      continue
    }
    const elapsed = length - (reset - now)
    if (elapsed < length * 0.1 || w.percentUsed < 10) continue
    const runsOutAt = now + ((100 - w.percentUsed) * elapsed) / w.percentUsed
    if (runsOutAt >= reset) continue
    found.push({
      key,
      title: `При текущем темпе ${f.windowName(w.kind)} будет исчерпан раньше срока`,
      detail: `Использовано: ${f.percent(w.percentUsed)} · ${resetText} · кончится ≈ ${f.when(runsOutAt, tz)}`,
      isOver: false,
    })
  }

  return found
}

let isScanning = false
let threshold: { window: number; value?: number; isOff?: boolean } | undefined
let ticker: Timer | undefined

async function remember($: EngineInterface, usage: Usage) {
  const { context } = usage
  if (threshold?.window !== context.window) {
    try {
      const { breakdown } = (await $.session.usage({ breakdown: 'summary' })).context
      threshold = {
        window: context.window,
        value: breakdown?.isAutoCompactEnabled ? breakdown.autoCompactThreshold : undefined,
        isOff: breakdown ? !breakdown.isAutoCompactEnabled : undefined,
      }
    } catch {
      threshold = { window: context.window }
    }
  }
  const m: Measure = {
    at: Date.now(),
    tokens: context.tokens,
    window: context.window,
    percent: context.percent,
    threshold: threshold.value,
    isAutoCompactOff: threshold.isOff,
    rateLimits: usage.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
    usd: usage.cost?.usd,
  }
  await update($, measured, () => m)
  await showStatus($, m)
}

async function showStatus($: EngineInterface, m: Measure | null) {
  const shown = await read($, prefs)
  $.ui.status(shown.showStatusLine && m ? statusLine(m) || undefined : undefined)
}

/**
 * Подтягивает то, что могла поменять другая сессия: настройки строк из
 * settings.json и общий для всех сессий флаг «панель скрыта».
 */
async function syncShared($: EngineInterface) {
  try {
    const rows = await $.config.list()
    const current = await read($, prefs)
    const next: Prefs = { ...current }
    for (const { field } of PARTS) {
      const row = rows.find(r => r.key.startsWith('context-gauge') && r.key.endsWith(`.${field}`))
      if (typeof row?.value === 'boolean') next[field] = row.value
    }
    if (PARTS.some(({ field }) => next[field] !== current[field])) {
      await update($, prefs, () => next)
      await showStatus($, await read($, measured))
    }
    const hidden = (await $.store.get('isHidden')) === true
    if (hidden !== (await read($, isHidden))) await update($, isHidden, () => hidden)
  } catch {
    // настройки недоступны: остаёмся на тех, что есть
  }
}

async function runScan($: EngineInterface) {
  if (isScanning) return
  isScanning = true
  try {
    const id = await $.session.id()
    const ran = await $.process.run(['node', `${$.plugin.root}/scripts/scan.mjs`, id], { timeoutMs: 300_000 })
    const out = JSON.parse(ran.stdout || '{}')
    await update($, scanned, () => ({ ...out, at: Date.now() }))
  } catch (error) {
    const text = String((error as Error)?.message ?? error)
    const reason = /ENOENT|not found|cannot start/i.test(text) ? 'нужен Node.js в PATH' : text.slice(0, 160)
    await update($, scanned, old => ({ ...old, at: Date.now(), error: reason }))
  } finally {
    isScanning = false
  }
}

async function loadDetails($: EngineInterface) {
  try {
    const { breakdown } = (await $.session.usage({ breakdown: 'summary' })).context
    if (!breakdown) throw new Error('разбивка пока недоступна')
    const next: Details = {
      at: Date.now(),
      model: breakdown.model,
      window: breakdown.rawMaxTokens,
      total: breakdown.totalTokens,
      threshold: breakdown.isAutoCompactEnabled ? breakdown.autoCompactThreshold : undefined,
      rows: breakdown.categories.map(({ name, tokens, kind }) => ({ name, tokens, kind })),
    }
    await update($, details, () => next)
  } catch (error) {
    const text = String((error as Error)?.message ?? error)
    await update($, details, () => ({ at: Date.now(), model: '', window: 0, total: 0, rows: [], error: text }))
  }
}

async function openDetails($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Контекст' })
  await loadDetails($)
}

async function openSettings($: EngineInterface) {
  await $.ui.open({ id: SETTINGS_PANE, title: 'Настройки панели' })
}

/** Переключает поле userConfig: движок сохранит его в настройках и перезагрузит мод. */
async function toggle($: EngineInterface, field: Part) {
  const rows = await $.config.list()
  const key = rows.find(row => row.key.startsWith('context-gauge') && row.key.endsWith(`.${field}`))?.key
  const value = !(await read($, prefs))[field]
  const result = await $.config.set({ key: key ?? `context-gauge.${field}`, value })
  if (result.deny !== undefined) {
    $.ui.toast(`Не удалось сохранить: ${result.deny}`)

    return
  }
  await update($, prefs, current => ({ ...current, [field]: value }))
  await showStatus($, await read($, measured))
}

export const register: Register = (on, options) => {
  loaded = { ...ALL_SHOWN }
  for (const { field } of PARTS) loaded[field] = options[field] !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gauge',
      description:
        'Панель контекста и лимитов: /gauge — скрыть или показать, /gauge context — из чего состоит контекст, /gauge настройки — какие строки показывать',
      argumentHint: '[context|настройки]',
    })
    await update($, prefs, () => loaded)
    const hidden = await $.store.get('isHidden')
    await update($, isHidden, () => hidden === true)
    const keys = await $.store.get('dismissed')
    if (Array.isArray(keys)) await update($, dismissed, () => keys.filter(k => typeof k === 'string'))

    let ticks = 0
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => {
      ticks += 1
      void update($, tick, n => n + 1)
      void syncShared($)
      if (ticks % SCAN_EVERY_TICKS === 0) void runScan($)
    })
    $.clock.after(300, () => {
      void $.session.usage().then(usage => remember($, usage), () => undefined)
      void runScan($)
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    try {
      await remember($, e)
    } catch {
      // замер не удался: панель останется со старыми цифрами
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, speed, () => EMPTY_SPEED)
      await update($, live, () => null)
      await update($, scanned, old => old && { ...old, session: null })
      $.clock.after(1500, () => void runScan($))
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    const startedAt = Date.now()
    let firstAt: number | undefined
    let chars = 0
    let wroteAt = 0
    let clock: Timer | undefined
    if (isMain) {
      void update($, live, () => ({ startedAt, chars: 0, at: startedAt }))
      clock = $.clock.every(1000, () => void update($, live, l => l && { ...l, at: Date.now() }))
    }

    const stream = next(e)
    try {
      for await (const chunk of stream) {
        const now = Date.now()
        firstAt ??= now
        if (isMain) {
          if (chunk.kind === 'text' || chunk.kind === 'thinking') chars += chunk.text.length
          else if (chunk.kind === 'input') chars += chunk.json.length
          if (now - wroteAt >= 500) {
            wroteAt = now
            const snapshot = { startedAt, firstAt, chars, at: now }
            void update($, live, () => snapshot)
          }
        }
        yield chunk
      }
      const result = await stream.result
      const out = result.usage?.output_tokens ?? 0
      if (out > 0) {
        const endedAt = Date.now()
        const ms = Math.max(1, endedAt - (firstAt ?? startedAt))
        void update($, speed, s => ({
          tokens: s.tokens + out,
          ms: s.ms + ms,
          responses: s.responses + 1,
          lastAt: endedAt,
          last: isMain ? { tokens: out, ms } : s.last,
        }))
      }

      return result
    } finally {
      clock?.cancel()
      if (isMain) void update($, live, () => null)
    }
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) $.clock.after(1500, () => void runScan($))

    return next(e)
  })

  on('command.run', { command: 'gauge' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'context' || arg === 'контекст') {
      await openDetails($)

      return { text: 'Открыл разбивку контекста.' }
    }
    if (arg === 'настройки' || arg === 'settings') {
      await openSettings($)

      return { text: 'Открыл настройки панели.' }
    }
    const hidden = await update($, isHidden, value => !value)
    await $.store.set('isHidden', hidden)

    return { text: hidden ? 'Панель скрыта. /gauge — показать снова.' : 'Панель показана.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    await read($, tick)
    const m = await read($, measured)
    const s = await read($, scanned)
    const l = await read($, live)
    const sp = await read($, speed)
    const hidden = await read($, dismissed)
    const now = Date.now()
    const tz = s?.tzOffsetMin ?? new Date().getTimezoneOffset()
    const { Box, Text, Button } = $.ui.resolve(e)

    const sep = () => <Text dimColor>·</Text>
    const dim = (text: string) => <Text dimColor>{text}</Text>
    const isDesktop = e.surface === 'desktop'
    // Карточку вокруг панели desktop рисует сам; рамка нужна только в терминале.
    const card = isDesktop ? {} : { borderStyle: 'round', borderDimColor: true }
    const bar = (pct: number, size: 'wide' | 'short') => {
      const p = clamp(pct)
      if (e.surface === 'desktop') {
        const { Svg } = $.ui.resolve(e)
        const width = size === 'wide' ? 200 : 72

        return <Svg source={svgBar(p, SVG_COLORS[tone(p)], width)} alt={f.percent(p)} width={width} height={8} />
      }
      const cells = size === 'wide' ? 16 : 8
      const filled = Math.round((p / 100) * cells)

      return (
        <Text>
          <Text color={tone(p)}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(cells - filled)}</Text>
        </Text>
      )
    }
    const row = (label: string, parts: RenderChildren[], wrap: 'wrap' | 'nowrap' = 'wrap') => (
      <Box flexDirection="row">
        <Box width={9} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Box flexDirection="row" flexWrap={wrap} alignItems="center" columnGap={1} flexGrow={1} flexShrink={1}>
          {parts}
        </Box>
      </Box>
    )

    // Контекст
    const context: RenderChildren[] = []
    const share = m ? contextShare(m) : undefined
    if (!m || !share) {
      context.push(dim('появится после первого ответа'))
    } else {
      context.push(
        bar(share.pct, 'wide'),
        <Text color={tone(share.pct)} weight="semibold">
          {f.percent(share.pct)}
        </Text>,
        <Text>
          {f.tokens(share.used)} из {f.tokens(share.limit)}
        </Text>,
      )
      if (m.threshold !== undefined) {
        context.push(
          sep(),
          <Text>
            <Text dimColor>до сжатия </Text>
            <Text weight="semibold">{f.tokens(Math.max(0, m.threshold - share.used))}</Text>
          </Text>,
        )
      } else if (m.isAutoCompactOff) {
        context.push(sep(), dim(`автосжатие выкл. · окно ${f.tokens(m.window)}`))
      }
      context.push(<Button key="details" plain dimColor label="Подробно ›" onPress={() => openDetails($)} />)
    }

    // Лимиты
    const limits: RenderChildren[] = []
    if (!m || m.rateLimits.length === 0) {
      limits.push(dim('появятся после ответа (при входе по API-ключу их нет)'))
    }
    for (const w of m?.rateLimits ?? []) {
      const reset = w.resetsAt === undefined ? NaN : Date.parse(w.resetsAt)
      limits.push(
        <Box flexDirection="row" alignItems="center" columnGap={1} marginRight={2} flexShrink={1}>
          <Text>{f.windowLabel(w.kind)}</Text>
          {bar(w.percentUsed, 'short')}
          <Text color={tone(w.percentUsed)} weight="semibold">
            {f.percent(w.percentUsed)}
          </Text>
          {reset > now ? (
            <Text dimColor wrap="truncate-end">
              сброс через {f.span(reset - now)}
            </Text>
          ) : null}
        </Box>,
      )
    }

    // Скорость
    const pace: RenderChildren[] = []
    const average = sp.ms > 0 ? sp.tokens / (sp.ms / 1000) : undefined
    if (l) {
      const generating = l.at - (l.firstAt ?? l.at)
      const estimate = l.chars / CHARS_PER_TOKEN
      const rate = generating > 1000 && estimate > 0 ? estimate / (generating / 1000) : undefined
      pace.push(
        <Text>
          идёт ответ <Text color="success">≈ {rate === undefined ? '…' : f.group(rate)} ток/с</Text>
        </Text>,
        sep(),
        dim(`≈ ${f.tokens(estimate)} токенов за ${f.seconds(l.at - l.startedAt)}`),
      )
    } else if (sp.last) {
      pace.push(
        <Text>
          последний ответ <Text weight="semibold">{f.group(sp.last.tokens / (sp.last.ms / 1000))} ток/с</Text>
        </Text>,
        sep(),
        dim(`${f.tokens(sp.last.tokens)} токенов за ${f.seconds(sp.last.ms)}`),
      )
    }
    if (average !== undefined) {
      if (pace.length > 0) pace.push(sep())
      pace.push(
        <Text>
          <Text dimColor>среднее за сессию </Text>
          <Text weight="semibold">{f.group(average)} ток/с</Text>
        </Text>,
        sep(),
        dim(`ответов: ${sp.responses}`),
      )
    }
    if (pace.length === 0) pace.push(dim('ещё не было ответов'))

    // Сессия
    const session: RenderChildren[] = []
    const ss = s?.session
    const sessionUsd = m?.usd ?? ss?.usd
    if (sessionUsd !== undefined) session.push(<Text weight="semibold">{f.usd(sessionUsd)}</Text>)
    if (ss) {
      if (session.length > 0) session.push(sep())
      session.push(
        <Text>
          <Text weight="semibold">{f.tokens(ss.input + ss.output + ss.cacheRead + ss.cacheWrite)}</Text> токенов:
          вход {f.tokens(ss.input)} · выход {f.tokens(ss.output)} · чтение кэша {f.tokens(ss.cacheRead)} · запись{' '}
          {f.tokens(ss.cacheWrite)}
        </Text>,
      )
    }
    // Кэш тёплый, пока идёт ответ; запрос, на который ещё ничего не пришло, не в счёт.
    const lastAt = l?.firstAt !== undefined ? now : Math.max(ss?.lastAt ?? 0, sp.lastAt ?? 0)
    if (lastAt > 0) {
      const left = lastAt + (ss?.ttlMin || 60) * 60_000 - now
      session.push(sep(), left > 0 ? <Text color="success">кэш тёплый ещё {f.span(left)}</Text> : dim('кэш остыл'))
    }
    if (session.length === 0) session.push(dim('считаю…'))

    // Всего
    const total: RenderChildren[] = []
    if (s?.totals && s.today) {
      const { totals, today } = s
      total.push(
        <Text weight="semibold">≈ {f.usd(totals.usd)}</Text>,
        sep(),
        <Text>{f.tokens(totals.tokens)} токенов</Text>,
        sep(),
        dim(
          `${totals.sessions} ${f.plural(totals.sessions, ['сессия', 'сессии', 'сессий'])}` +
            (totals.since ? ` с ${f.day(totals.since)}` : ''),
        ),
        sep(),
        <Text>
          сегодня <Text weight="semibold">≈ {f.usd(today.usd)}</Text>
        </Text>,
        dim(`· ${f.tokens(today.tokens)} токенов`),
      )
    } else {
      total.push(dim(s?.error ? `не посчитать: ${s.error}` : 'считаю по логам…'))
    }

    const shown = await read($, prefs)
    const warnings = shown.showWarnings ? warningsOf(m?.rateLimits ?? [], now, tz, hidden) : []
    const rows: [string, RenderChildren[], 'wrap' | 'nowrap'][] = []
    if (shown.showContext) rows.push(['Контекст', context, 'wrap'])
    if (shown.showLimits) rows.push(['Лимиты', limits, 'nowrap'])
    if (shown.showSpeed) rows.push(['Скорость', pace, 'wrap'])
    if (shown.showSession) rows.push(['Сессия', session, 'wrap'])
    if (shown.showTotal) rows.push(['Всего', total, 'wrap'])
    if (rows.length === 0 && warnings.length === 0) return next(e)
    rows[0]?.[1].push(<Button key="settings" plain dimColor label="⚙" onPress={() => openSettings($)} />)

    return (
      <Box flexDirection="column" rowGap={1}>
        {warnings.map(w => (
          <Box
            key={`warn-${w.key}`}
            flexDirection="row"
            alignItems="center"
            columnGap={1}
            {...(isDesktop ? {} : { borderStyle: 'round', borderColor: w.isOver ? 'error' : 'warning' })}
            paddingX={1}
          >
            <Text color={w.isOver ? 'error' : 'warning'}>⚠</Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} flexGrow={1} flexShrink={1}>
              <Text weight="semibold">{w.title}</Text>
              {dim(w.detail)}
            </Box>
            <Button
              key={`dismiss-${w.key}`}
              plain
              dimColor
              role="dismiss"
              label="×"
              onPress={async () => {
                const keys = await update($, dismissed, list => [...list, w.key].slice(-20))
                await $.store.set('dismissed', keys)
              }}
            />
          </Box>
        ))}
        {rows.length > 0 && (
          <Box flexDirection="column" {...card} paddingX={isDesktop ? 0 : 1}>
            {rows.map(([label, parts, wrap]) => row(label, parts, wrap))}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const d = await read($, details)
    const actions = (
      <Box flexDirection="row" columnGap={2}>
        <Button key="refresh" label="Обновить" onPress={() => loadDetails($)} />
        <Button key="close" role="dismiss" label="Закрыть" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )
    if (!d) return <Text dimColor>Считаю…</Text>
    if (d.error) {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text color="warning">Не удалось разобрать контекст: {d.error}</Text>
          {actions}
        </Box>
      )
    }

    const nameWidth = Math.min(28, Math.max(12, ...d.rows.map(r => r.name.length + 1)))

    return (
      <Box flexDirection="column" rowGap={1}>
        <Text>
          <Text weight="semibold">{d.model}</Text>
          <Text dimColor>
            {' '}
            · занято {f.tokens(d.total)} из {f.tokens(d.window)}
            {d.threshold === undefined ? ' · автосжатие выкл.' : ` · автосжатие при ${f.tokens(d.threshold)}`}
          </Text>
        </Text>
        <Box flexDirection="column">
          {d.rows.map(r => (
            <Box flexDirection="row" columnGap={1}>
              <Box width={nameWidth} flexShrink={0}>
                <Text dimColor={r.kind !== 'used'}>{r.name}</Text>
              </Box>
              <Text tabular>{f.tokens(r.tokens)}</Text>
              <Text dimColor>
                {d.window > 0 ? f.percent((r.tokens / d.window) * 100) : ''}
                {r.kind === 'deferred' ? ' · по запросу' : ''}
              </Text>
            </Box>
          ))}
        </Box>
        {actions}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const shown = await read($, prefs)

    return (
      <Box flexDirection="column" rowGap={1}>
        <Text dimColor>Что показывать на панели. Нажмите на строку, чтобы включить или выключить её.</Text>
        <Box flexDirection="column">
          {PARTS.map(({ field, label }) => (
            <Button key={`toggle-${field}`} plain onPress={() => toggle($, field)}>
              {shown[field] ? '☑' : '☐'} {label}
            </Button>
          ))}
        </Box>
        <Box flexDirection="row">
          <Button key="close" role="dismiss" label="Закрыть" onPress={() => $.ui.close({ id: SETTINGS_PANE })} />
        </Box>
      </Box>
    )
  })
}
