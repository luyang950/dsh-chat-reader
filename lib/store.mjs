// lib/store.mjs — the plugin's only writable state, under $DSH_HOME/dsh-chat-reader/.
//
//   config.json    library root + reading preferences
//   progress.json  per-book paragraph index (keyed by the book's real path) + last book
//   notes.json     per-book bookmarks
//
// Writes are atomic (temp file + rename) and serialised per file, so two quick
// progress posts can never interleave into a torn file.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export const PLUGIN_DIR = 'dsh-chat-reader'
export const PROGRESS_LIMIT = 500
export const NOTES_PER_BOOK = 200

/** Resolved at call time so tests (and a moved DSH_HOME) see the current value. */
export function dataDirectory() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), PLUGIN_DIR)
}

export function expandHome(input) {
  const text = String(input ?? '').trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return join(homedir(), text.slice(2))
  return text
}

/* ── config schema ───────────────────────────────────────────────────────── */

const KEY_CODE = /^(Key[A-Z]|Digit[0-9]|F[1-9]|F1[0-2]|Backquote|Period|Comma|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal)$/

export const DEFAULT_CONFIG = Object.freeze({
  libraryRoot: '~/Books',
  fontSize: 0,
  lineHeight: 1.8,
  bossKey: 'Ctrl+Alt+KeyB',
})

/**
 * Normalise a boss-key chord like `ctrl+alt+KeyB` → `Ctrl+Alt+KeyB`.
 * At least one modifier is required unless the key is a function key, so the
 * chord can never swallow ordinary typing in the composer.
 * @returns {string|null}
 */
export function normalizeChord(value) {
  if (typeof value !== 'string') return null
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0 || parts.length > 5) return null
  const code = parts.pop()
  if (!KEY_CODE.test(code)) return null
  const order = ['Ctrl', 'Alt', 'Shift', 'Meta']
  const seen = new Set()
  for (const part of parts) {
    const canonical = order.find((name) => name.toLowerCase() === part.toLowerCase())
    if (!canonical || seen.has(canonical)) return null
    seen.add(canonical)
  }
  if (seen.size === 0 && !/^F\d+$/.test(code)) return null
  // Shift alone with a printable key is just a capital letter: refuse it.
  if (seen.size === 1 && seen.has('Shift') && !/^F\d+$/.test(code)) return null
  return [...order.filter((name) => seen.has(name)), code].join('+')
}

function clampNumber(value, min, max, integer) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  const clamped = Math.min(max, Math.max(min, number))
  return integer ? Math.round(clamped) : Math.round(clamped * 100) / 100
}

/**
 * Validate a partial config patch.
 * @returns {{ value: object, errors: string[] }} only the valid fields are kept
 */
export function validateConfigPatch(patch) {
  const value = {}
  const errors = []
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { value, errors: ['配置必须是对象'] }

  for (const [key, raw] of Object.entries(patch)) {
    switch (key) {
      case 'libraryRoot': {
        const text = typeof raw === 'string' ? raw.trim() : ''
        const expanded = expandHome(text)
        if (!text || text.length > 1024 || text.includes('\0') || !isAbsolute(expanded)) {
          errors.push('书库根目录必须是绝对路径（可用 ~ 开头）')
        } else {
          value.libraryRoot = text
        }
        break
      }
      case 'fontSize': {
        // 0 means "follow the conversation's own font size" — the best disguise.
        const number = Number(raw) === 0 ? 0 : clampNumber(raw, 12, 28, true)
        if (number === null) errors.push('字号必须是数字')
        else value.fontSize = number
        break
      }
      case 'lineHeight': {
        const number = clampNumber(raw, 1.2, 2.6, false)
        if (number === null) errors.push('行距必须是数字')
        else value.lineHeight = number
        break
      }
      case 'bossKey': {
        const chord = normalizeChord(raw)
        if (!chord) errors.push('老板键必须是「修饰键 + 按键」，例如 Ctrl+Alt+KeyB')
        else value.bossKey = chord
        break
      }
      default:
        errors.push(`未知配置项：${key}`)
    }
  }
  return { value, errors }
}

/* ── json files ──────────────────────────────────────────────────────────── */

const queues = new Map()

async function readJson(name, fallback) {
  try {
    const parsed = JSON.parse(await readFile(join(dataDirectory(), name), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

/** Read-modify-write one file under a per-file queue; `mutate` returns the result. */
function update(name, fallback, mutate) {
  const previous = queues.get(name) ?? Promise.resolve()
  const next = previous.then(async () => {
    const current = await readJson(name, fallback())
    const result = await mutate(current)
    const directory = dataDirectory()
    await mkdir(directory, { recursive: true })
    const target = join(directory, name)
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
    return result
  })
  queues.set(name, next.catch(() => {}))
  return next
}

/* ── config ──────────────────────────────────────────────────────────────── */

export async function readConfig() {
  const stored = await readJson('config.json', {})
  // Re-validate on read: a hand-edited file must not smuggle in a bad value.
  const { value } = validateConfigPatch(
    Object.fromEntries(Object.entries(stored).filter(([key]) => key in DEFAULT_CONFIG)),
  )
  return { ...DEFAULT_CONFIG, ...value }
}

export async function writeConfig(patch) {
  const { value, errors } = validateConfigPatch(patch)
  if (errors.length > 0) {
    const error = new Error(errors.join('；'))
    error.status = 400
    throw error
  }
  await update('config.json', () => ({}), (current) => {
    Object.assign(current, value)
  })
  return readConfig()
}

/** The configured library root with `~` expanded. */
export async function libraryRoot() {
  return expandHome((await readConfig()).libraryRoot)
}

/* ── progress ────────────────────────────────────────────────────────────── */

export async function readProgress(path) {
  const progress = await readJson('progress.json', {})
  const entry = progress.books?.[path]
  return entry && Number.isInteger(entry.index) && entry.index >= 0 ? entry : null
}

export async function lastBook() {
  const progress = await readJson('progress.json', {})
  return typeof progress.last?.book === 'string' ? progress.last.book : null
}

/**
 * Save one book's position.
 * @param {string} path real path (the stable key)
 * @param {{ book: string, index: number, total: number }} entry
 */
export function writeProgress(path, { book, index, total }) {
  return update('progress.json', () => ({ books: {} }), (progress) => {
    if (!progress.books || typeof progress.books !== 'object') progress.books = {}
    progress.books[path] = { book, index, total, at: Date.now() }
    progress.last = { book, at: Date.now() }
    const keys = Object.keys(progress.books)
    if (keys.length > PROGRESS_LIMIT) {
      keys.sort((a, b) => (progress.books[a]?.at ?? 0) - (progress.books[b]?.at ?? 0))
      for (const key of keys.slice(0, keys.length - PROGRESS_LIMIT)) delete progress.books[key]
    }
    return progress.books[path]
  })
}

export async function allProgress() {
  const progress = await readJson('progress.json', {})
  return progress.books && typeof progress.books === 'object' ? progress.books : {}
}

/* ── reading sessions ────────────────────────────────────────────────────── */
//
// A `/read` in a fresh New Session never starts a model turn, so DSH keeps that
// Session "blank" and hides it from the sidebar once another Session is selected.
// Remembering which Sessions hold a reader lets the browser half offer a way back.

export const SESSIONS_LIMIT = 20
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value)
}

/** Most recent first. */
export async function readSessions() {
  const state = await readJson('sessions.json', {})
  return Array.isArray(state.sessions) ? state.sessions.filter((entry) => isSessionId(entry?.sessionId)) : []
}

/**
 * Remember (or refresh) the Session a book was opened in.
 * @param {{ sessionId: string, book: string, title: string }} entry
 */
export function recordSession({ sessionId, book, title }) {
  if (!isSessionId(sessionId)) return Promise.resolve(null)
  return update('sessions.json', () => ({ sessions: [] }), (state) => {
    const list = Array.isArray(state.sessions) ? state.sessions : []
    const entry = { sessionId, book, title: String(title ?? '').slice(0, 200), at: Date.now() }
    state.sessions = [entry, ...list.filter((item) => item?.sessionId !== sessionId)].slice(0, SESSIONS_LIMIT)
    return entry
  })
}

export function forgetSession(sessionId) {
  return update('sessions.json', () => ({ sessions: [] }), (state) => {
    const list = Array.isArray(state.sessions) ? state.sessions : []
    state.sessions = list.filter((item) => item?.sessionId !== sessionId)
    return state.sessions
  })
}

/* ── bookmarks ───────────────────────────────────────────────────────────── */

export async function readNotes(path) {
  const notes = await readJson('notes.json', {})
  return Array.isArray(notes[path]) ? notes[path] : []
}

export function addNote(path, { index, text }) {
  return update('notes.json', () => ({}), (notes) => {
    const list = Array.isArray(notes[path]) ? notes[path] : []
    const note = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      index,
      text: String(text ?? '').slice(0, 200),
      at: Date.now(),
    }
    list.push(note)
    list.sort((a, b) => a.index - b.index)
    notes[path] = list.slice(-NOTES_PER_BOOK)
    return note
  })
}

export function removeNote(path, id) {
  return update('notes.json', () => ({}), (notes) => {
    const list = Array.isArray(notes[path]) ? notes[path] : []
    notes[path] = list.filter((note) => note.id !== id)
    return notes[path]
  })
}
