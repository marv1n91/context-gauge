// Считает токены и примерную стоимость по транскриптам Claude Code
// (~/.claude/projects/**/*.jsonl) и печатает сводку JSON для мода context-gauge.
//
// Запуск: node scan.mjs [id-текущей-сессии]
// Кэш (~/.claude/cache/context-gauge.json) хранит, докуда прочитан каждый файл,
// так что повторный запуск читает только дописанные строки. Итоги по файлам,
// которые Claude Code потом удалил, в кэше остаются, и «всего» не уменьшается.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CACHE_VERSION = 1
const RECENT_IDS = 16
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const projectsDir = path.join(configDir, 'projects')
const cachePath = path.join(configDir, 'cache', 'context-gauge.json')
const sessionId = process.argv[2] || ''

// $ за 1 млн токенов: вход, выход, чтение кэша. Запись кэша: 5 мин — 1,25× входа, 1 ч — 2×.
const PRICES = {
  'fable-5-1': [10, 50, 0.25],
  'mythos-5-1': [10, 50, 0.25],
  'fable-5': [10, 50, 1],
  'mythos-5': [10, 50, 1],
  'opus-5-5': [4, 20, 0.2],
  'opus-5': [5, 25, 0.5],
  'opus-4-8': [5, 25, 0.5],
  'opus-4-7': [5, 25, 0.5],
  'opus-4-6': [5, 25, 0.5],
  'opus-4-5': [5, 25, 0.5],
  'opus-4-1': [15, 75, 1.5],
  'opus-4': [15, 75, 1.5],
  'sonnet-5-5': [2, 10, 0.2],
  'sonnet-5': [2, 10, 0.2],
  'sonnet-4-6': [3, 15, 0.3],
  'sonnet-4-5': [3, 15, 0.3],
  'sonnet-4': [3, 15, 0.3],
  'haiku-5-5': [0.1, 0.5, 0.01],
  'haiku-4-5': [1, 5, 0.1],
  'haiku-3-5': [0.8, 4, 0.08],
}
const FAMILY = { fable: 'fable-5-1', mythos: 'mythos-5-1', opus: 'opus-5-5', sonnet: 'sonnet-5-5', haiku: 'haiku-5-5' }

function priceOf(model) {
  const name = model.replace(/^claude-/, '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '')
  if (PRICES[name]) return PRICES[name]
  const family = Object.keys(FAMILY).find(key => name.includes(key))
  return PRICES[family ? FAMILY[family] : 'sonnet-5-5']
}

// [вход, выход, чтение кэша, запись 5 мин, запись 1 ч]
function vectorOf(usage) {
  const write = usage.cache_creation_input_tokens || 0
  const hour = usage.cache_creation?.ephemeral_1h_input_tokens || 0
  return [
    usage.input_tokens || 0,
    usage.output_tokens || 0,
    usage.cache_read_input_tokens || 0,
    Math.max(0, write - hour),
    hour,
  ]
}

function costOf(model, isFast, v) {
  const [input, output, read] = priceOf(model)
  const usd = (v[0] * input + v[1] * output + v[2] * read + v[3] * input * 1.25 + v[4] * input * 2) / 1e6

  return isFast ? usd * 2 : usd
}

const pad = n => String(n).padStart(2, '0')
const dayOf = ms => {
  const d = new Date(ms)

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function emptyRecord() {
  return { size: 0, mtimeMs: 0, offset: 0, recent: [], days: {}, sum: [0, 0, 0, 0, 0, 0, 0], lastTs: 0, ttl: 0 }
}

// sum: вход, выход, чтение кэша, запись кэша, $, ответов, первый ts
function addRow(record, row) {
  const message = row.message
  const usage = message?.usage
  if (!usage || typeof message.model !== 'string' || !message.model.startsWith('claude')) return

  const id = message.id || row.requestId || row.uuid
  const next = vectorOf(usage)
  const seen = record.recent.find(entry => entry[0] === id)
  let delta = next
  if (seen) {
    delta = next.map((value, i) => Math.max(0, value - seen[1][i]))
    seen[1] = next.map((value, i) => Math.max(value, seen[1][i]))
  } else {
    record.recent.push([id, next])
    if (record.recent.length > RECENT_IDS) record.recent.shift()
  }

  const ts = Date.parse(row.timestamp) || 0
  const usd = costOf(message.model, usage.speed === 'fast', delta)
  const tokens = delta[0] + delta[1] + delta[2] + delta[3] + delta[4]
  const sum = record.sum
  sum[0] += delta[0]
  sum[1] += delta[1]
  sum[2] += delta[2]
  sum[3] += delta[3] + delta[4]
  sum[4] += usd
  if (!seen) sum[5] += 1
  if (ts && (!sum[6] || ts < sum[6])) sum[6] = ts
  if (ts) {
    const day = (record.days[dayOf(ts)] ??= [0, 0])
    day[0] += usd
    day[1] += tokens
  }
  if (ts >= record.lastTs) {
    record.lastTs = ts
    if (next[4] > 0) record.ttl = 60
    else if (next[3] > 0) record.ttl = 5
  }
}

async function readNew(file, record, size) {
  const handle = await fs.open(file, 'r')
  try {
    const length = size - record.offset
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, record.offset + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    const end = buffer.lastIndexOf(10, read - 1)
    if (end < 0) return
    const text = buffer.toString('utf8', 0, end)
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
      try {
        const row = JSON.parse(line)
        if (row.type === 'assistant') addRow(record, row)
      } catch {
        // строка, дописанная не до конца, или чужой формат
      }
    }
    record.offset += Buffer.byteLength(text, 'utf8') + 1
  } finally {
    await handle.close()
  }
}

async function walk(dir, depth, found) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, depth + 1, found)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push({ full, depth })
  }
}

async function loadCache() {
  try {
    const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'))
    if (cache.version === CACHE_VERSION) return cache
  } catch {
    // нет кэша или он испорчен: считаем заново
  }

  return { version: CACHE_VERSION, files: {} }
}

async function saveCache(cache) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true })
  const temp = `${cachePath}.${process.pid}.tmp`
  await fs.writeFile(temp, JSON.stringify(cache))
  await fs.rename(temp, cachePath)
}

async function main() {
  const startedAt = Date.now()
  const cache = await loadCache()
  const found = []
  await walk(projectsDir, 0, found)

  for (const { full, depth } of found) {
    const key = path.relative(projectsDir, full).split(path.sep).join('/')
    let stat
    try {
      stat = await fs.stat(full)
    } catch {
      continue
    }
    let record = cache.files[key]
    // Файл стал короче, чем прочитано: его переписали, считаем заново.
    if (!record || stat.size < record.offset) record = emptyRecord()
    record.isSession = depth === 1
    if (stat.size > record.offset) await readNew(full, record, stat.size)
    record.size = stat.size
    record.mtimeMs = stat.mtimeMs
    if (startedAt - stat.mtimeMs > 86_400_000) record.recent = []
    cache.files[key] = record
  }
  await saveCache(cache)

  const today = dayOf(startedAt)
  const totals = { usd: 0, tokens: 0, sessions: 0, since: '' }
  const day = { usd: 0, tokens: 0 }
  let session = null
  for (const [key, record] of Object.entries(cache.files)) {
    const [input, output, read, write, usd, responses, first] = record.sum
    totals.usd += usd
    totals.tokens += input + output + read + write
    if (record.isSession && responses > 0) totals.sessions += 1
    if (first) {
      const firstDay = dayOf(first)
      if (!totals.since || firstDay < totals.since) totals.since = firstDay
    }
    const todays = record.days[today]
    if (todays) {
      day.usd += todays[0]
      day.tokens += todays[1]
    }
    const parts = key.split('/')
    const isCurrent = sessionId && (parts[1] === `${sessionId}.jsonl` || parts[1] === sessionId)
    if (isCurrent) {
      session ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, responses: 0, lastAt: 0, ttlMin: 0 }
      session.input += input
      session.output += output
      session.cacheRead += read
      session.cacheWrite += write
      session.usd += usd
      session.responses += responses
      if (record.lastTs > session.lastAt) {
        session.lastAt = record.lastTs
        session.ttlMin = record.ttl
      }
    }
  }

  process.stdout.write(
    JSON.stringify({
      tzOffsetMin: new Date().getTimezoneOffset(),
      totals,
      today: day,
      session,
      files: found.length,
      tookMs: Date.now() - startedAt,
    }),
  )
}

main().catch(error => {
  process.stdout.write(JSON.stringify({ error: String(error?.message ?? error) }))
  process.exitCode = 1
})
