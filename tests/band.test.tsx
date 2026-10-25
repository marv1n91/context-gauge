import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.now()
const MIN = 60_000

const BAND = {
  plugin: 'context-gauge',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SCAN = {
  tzOffsetMin: -300,
  totals: { usd: 36530.4, tokens: 119.06e9, sessions: 351, since: '2026-08-31' },
  today: { usd: 455.26, tokens: 1.21e9 },
  session: {
    input: 1200,
    output: 595_000,
    cacheRead: 104e6,
    cacheWrite: 1.86e6,
    usd: 44.38,
    responses: 103,
    lastAt: NOW - 7 * MIN,
    ttlMin: 60,
  },
}

const USAGE = {
  startedAt: NOW - 60 * MIN,
  context: {
    tokens: 152_000,
    window: 1_000_000,
    percent: 15,
    breakdown: {
      categories: [
        { name: 'System prompt', tokens: 9000, color: 'promptBorder', isDeferred: false, kind: 'used' },
        { name: 'Messages', tokens: 143_000, color: 'permission', isDeferred: false, kind: 'used' },
      ],
      totalTokens: 152_000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      model: 'claude-opus-5-5',
      autoCompactThreshold: 467_000,
      isAutoCompactEnabled: true,
    },
  },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 50, resetsAt: new Date(NOW + 167 * MIN).toISOString() },
    { kind: 'seven_day', percentUsed: 65, resetsAt: new Date(NOW + (5 * 24 + 10) * 60 * MIN).toISOString() },
  ],
  cost: { usd: 44.38 },
}

// Всё, что под плагином: каждый хук здесь отвечает за движок.
function engine(on: On) {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  on('command.register', () => ({ value: { command: 'gauge' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.usage', () => ({ value: USAGE as never }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(SCAN), stderr: '' } as never }))
  on('ui.status', () => ({ value: undefined as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  return clock
}

test('панель показывает контекст, лимиты, сессию и итоги на терминале и в desktop', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(400)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' | ')

    expect(texts).toMatch(/33 %/)
    expect(texts).toMatch(/152 тыс\. из 467 тыс\./)
    expect(texts).toMatch(/до сжатия 315 тыс\./)
    expect(texts).toMatch(/сброс через 2 ч 47 мин/)
    expect(texts).toMatch(/сброс через 5 дн 10 ч/)
    expect(texts).toMatch(/недельный лимит будет исчерпан раньше срока/)
    expect(texts).toMatch(/\$44,38/)
    expect(texts).toMatch(/106 млн токенов: вход 1,2 тыс\. · выход 595 тыс\. · чтение кэша 104 млн/)
    expect(texts).toMatch(/кэш тёплый ещё 53 мин/)
    expect(texts).toMatch(/≈ \$36 530/)
    expect(texts).toMatch(/351 сессия с 31\.08\.2026/)
    expect(texts).toMatch(/сегодня ≈ \$455,26/)
    expect(await ui.find({ key: 'details' })).toBeDefined()
    await ui.unmount()
  }
})

test('крестик убирает предупреждение о темпе', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(400)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const warning = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('dismiss-seven_day'))
  expect(warning).toBeDefined()
  await ui.press({ key: warning?.key ?? '' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
  expect(texts).not.toMatch(/недельный лимит будет исчерпан/)
  await ui.unmount()
})

test('скрытые в настройках строки не рисуются', { options: { showSpeed: false, showTotal: false } }, async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(400)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' | ')

    expect(texts).toMatch(/Контекст/)
    expect(texts).toMatch(/Сессия/)
    expect(texts).not.toMatch(/Скорость/)
    expect(texts).not.toMatch(/Всего/)
    expect(await ui.find({ key: 'settings' })).toBeDefined()
    await ui.unmount()
  }
})

test('в окне настроек переключатель сохраняет поле userConfig', async ($, on) => {
  const clock = engine(on)
  const saved: { key: string; value: unknown }[] = []
  on('config.list', () => ({
    value: [
      {
        key: 'context-gauge.showSpeed',
        label: 'Панель: строка «Скорость»',
        kind: 'toggle',
        value: true,
        provider: { plugin: 'context-gauge', tier: 'user' },
        isLocked: false,
      },
    ] as never,
  }))
  on('config.set', (_, e) => {
    saved.push({ key: e.key, value: e.value })

    return { value: e.value }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(400)

  const ran = await $.command.run({ command: 'gauge', args: 'настройки' })
  expect(ran.text).toBe('Открыл настройки панели.')

  const ui = await $.ui.mount({
    plugin: 'context-gauge',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'context-gauge-settings',
    props: {
      title: 'Настройки панели',
      isFocused: false,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })
  expect((await ui.find({ key: 'toggle-showSpeed' }))?.text).toMatch(/☑ Скорость/)
  await ui.press({ key: 'toggle-showSpeed' })
  expect(saved).toEqual([{ key: 'context-gauge.showSpeed', value: false }])
  await ui.unmount()
})

test('настройку, изменённую в другой сессии, панель подхватывает за один тик', async ($, on) => {
  const clock = engine(on)
  let speedValue = true
  on('config.list', () => ({
    value: [
      {
        key: 'context-gauge.showSpeed',
        label: 'Панель: строка «Скорость»',
        kind: 'toggle',
        value: speedValue,
        provider: { plugin: 'context-gauge', tier: 'user' },
        isLocked: false,
      },
    ] as never,
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(400)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const before = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
  expect(before).toMatch(/Скорость/)

  // Другая сессия выключила строку: в settings.json теперь false.
  speedValue = false
  await clock.advance(15_000)
  const after = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
  expect(after).not.toMatch(/Скорость/)
  expect(after).toMatch(/Контекст/)
  await ui.unmount()
})

test('/gauge context открывает разбивку контекста', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(400)

  const ran = await $.command.run({ command: 'gauge', args: 'context' })
  expect(ran.text).toBe('Открыл разбивку контекста.')

  const ui = await $.ui.mount({
    plugin: 'context-gauge',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'context-gauge',
    props: {
      title: 'Контекст',
      isFocused: false,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
  expect(texts).toMatch(/автосжатие при 467 тыс\./)
  expect(texts).toMatch(/Messages/)
  await ui.unmount()
})
