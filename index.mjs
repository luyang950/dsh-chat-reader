// dsh-chat-reader — host half (cordis plugin).
//
// Two seams, nothing else:
//
//   * the `/read` human command. Its handler resolves one book inside the library
//     root and settles with a tiny JSON summary (id, title, format, paragraph count).
//     `command/run` + `command/done` are log-only session events: they never become
//     model messages, so the reading costs zero tokens. The browser half folds that
//     pair into one custom chat node — the reader card.
//
//     The handler also remembers which Session the book was opened in (the browser
//     half offers those as 继续阅读 in the sidebar's More menu), and, when that
//     Session is still blank, lets the agent loop run one empty turn so DSH keeps
//     it in the sidebar — see lib/session.mjs. That turn calls no model.
//
//   * a JSON API under /dsh-chat-reader/api/* the card pages through. Every route
//     takes a book *id* (a relative path inside the library root) and never a raw
//     filesystem path; see lib/book.mjs for the confinement rules.
//
// `webServer` is NOT in `inject`: it is published late and is absent in headless
// profiles, so it is attached with ctx.inject() and the plugin settles without it.

import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

import {
  BookError,
  bookSummary,
  listLibrary,
  loadBook,
  paragraphWindow,
  publicBook,
  realRoot,
  searchBook,
} from './lib/book.mjs'
import {
  addNote,
  allProgress,
  expandHome,
  forgetSession,
  isSessionId,
  lastBook,
  libraryRoot,
  readConfig,
  readNotes,
  readProgress,
  readSessions,
  recordSession,
  removeNote,
  writeConfig,
  writeProgress,
} from './lib/store.mjs'
import { nameSession, onPreStep, sealBlankSession } from './lib/session.mjs'

export const name = 'dsh-chat-reader'
export const inject = ['commands']

export const API_PREFIX = '/dsh-chat-reader/api'
const MAX_BODY_BYTES = 16 * 1024
const MAX_QUERY_LENGTH = 100

/* ── helpers ─────────────────────────────────────────────────────────────── */

function httpError(message, status = 400) {
  return new BookError(message, status)
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}

/** Parse a non-negative integer parameter; absent → fallback, malformed → 400. */
export function intParam(raw, label, { fallback, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === null || raw === undefined || raw === '') {
    if (fallback === undefined) throw httpError(`缺少参数 ${label}`)
    return fallback
  }
  const text = String(raw)
  if (!/^\d{1,9}$/.test(text)) throw httpError(`参数 ${label} 必须是非负整数`)
  const value = Number(text)
  if (value < min || value > max) throw httpError(`参数 ${label} 超出范围 ${min}–${max}`)
  return value
}

async function readBody(req) {
  const type = String(req.headers?.['content-type'] ?? '')
  if (!type.includes('application/json')) throw httpError('请求体必须是 application/json', 415)
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw httpError('请求体过大', 413)
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw httpError('请求体不是合法的 JSON 对象')
  }
}

async function openBook(id) {
  return loadBook(await libraryRoot(), id)
}

/* ── /read ───────────────────────────────────────────────────────────────── */

/**
 * Turn the `/read` argument into one book id.
 * Empty → the last book read. Otherwise an exact id, or a unique fuzzy match.
 */
export async function resolveReadArgument(argument) {
  const query = String(argument ?? '').trim()
  const root = await libraryRoot()
  if (!query) {
    const last = await lastBook()
    if (!last) throw httpError('用法：/read <书名关键词或书库内相对路径>（书库根目录在 设置 → 阅读）')
    return last
  }
  if (query.length > 1024) throw httpError('参数过长')

  // An absolute path is accepted only when it points inside the library root.
  if (query.startsWith('/') || query.startsWith('~')) {
    const base = await realRoot(root)
    const target = await realpath(expandHome(query)).catch(() => null)
    const rel = target ? relative(base, target) : ''
    if (!target || !rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw httpError(`只能打开书库内的书（书库：${base}）`, 403)
    }
    return rel.split(sep).join('/')
  }

  // An exact relative id wins when it names a book.
  try {
    await loadBook(root, query)
    return query
  } catch (error) {
    if (error instanceof BookError && error.status === 403) throw error
  }

  const { books } = await listLibrary(root, { query })
  if (books.length === 1) return books[0].book
  if (books.length === 0) throw httpError(`书库里没有书名包含「${query}」的书（书库：${root}）`, 404)
  const exact = books.find((entry) => entry.name.replace(/\.[^.]+$/, '') === query)
  if (exact) return exact.book
  const listing = books.slice(0, 8).map((entry) => `  ${entry.book}`).join('\n')
  throw httpError(`找到 ${books.length} 本匹配的书，请写得更具体些：\n${listing}`, 409)
}

/** The id of the Session a command runs in, when the invocation carries one. */
export function sessionIdOf(invocation) {
  const agent = invocation?.agent
  const id = agent?.session?.id ?? agent?.id
  return isSessionId(id) ? id : null
}

/**
 * @param {{ afterRead?: (invocation: object, entry: object) => void }} [hooks]
 *   `afterRead` runs once the command has settled (after `command/done` is logged).
 */
export function readCommand(hooks = {}) {
  return {
    name: 'read',
    description: '在会话里打开一本本地小说（txt / md / epub），正文不进模型上下文',
    input: { hint: '<书名关键词，留空则继续上一本>' },
    recordInput: true,
    async handler(invocation) {
      const argument = String(invocation?.rawInput ?? '').replace(/^\/read\b/, '').trim()
      try {
        const id = await resolveReadArgument(argument)
        const entry = await openBook(id)
        const sessionId = sessionIdOf(invocation)
        if (sessionId) await recordSession({ sessionId, book: entry.id, title: entry.title }).catch(() => {})
        if (typeof hooks.afterRead === 'function') setImmediate(() => hooks.afterRead(invocation, entry))
        return { kind: 'success', text: JSON.stringify(bookSummary(entry)) }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/* ── routes ──────────────────────────────────────────────────────────────── */

const routes = {
  /** GET → current config; POST → partial update. */
  async config(req) {
    if (req.method === 'POST') {
      const body = await readBody(req)
      return { config: await writeConfig(body) }
    }
    return { config: await readConfig() }
  },

  /** GET ?q= → books under the library root, each with its saved progress. */
  async library(req, params) {
    const query = params.get('q') ?? ''
    if (query.length > MAX_QUERY_LENGTH) throw httpError('关键词过长')
    const root = await libraryRoot()
    const listing = await listLibrary(root, { query })
    const progress = await allProgress()
    const byId = new Map(Object.values(progress).map((entry) => [entry.book, entry]))
    return {
      root: listing.root,
      truncated: listing.truncated,
      books: listing.books.map((book) => ({ ...book, progress: byId.get(book.book) ?? null })),
    }
  },

  /** GET ?book= → metadata + chapters + saved progress + bookmarks. */
  async open(req, params) {
    const entry = await openBook(params.get('book'))
    return {
      book: publicBook(entry),
      progress: await readProgress(entry.path),
      notes: await readNotes(entry.path),
    }
  },

  /** GET ?book=&from=&count= → a window of paragraphs. */
  async paragraphs(req, params) {
    const entry = await openBook(params.get('book'))
    const from = intParam(params.get('from'), 'from', { fallback: 0 })
    const count = intParam(params.get('count'), 'count', { fallback: 40, min: 1, max: 200 })
    if (from > entry.paragraphs.length) throw httpError('参数 from 超出全书段落数')
    return paragraphWindow(entry, from, count)
  },

  /** GET ?book=&q=&from= → matching paragraph indices with snippets. */
  async search(req, params) {
    const entry = await openBook(params.get('book'))
    const query = String(params.get('q') ?? '').trim()
    if (!query) throw httpError('缺少参数 q')
    if (query.length > MAX_QUERY_LENGTH) throw httpError('关键词过长')
    const from = intParam(params.get('from'), 'from', { fallback: 0 })
    return searchBook(entry, query, from, 50)
  },

  /** GET ?book= → saved position; POST {book, index} → save it. */
  async progress(req, params) {
    if (req.method === 'POST') {
      const body = await readBody(req)
      const entry = await openBook(body.book)
      const index = intParam(body.index, 'index', { max: entry.paragraphs.length })
      const saved = await writeProgress(entry.path, { book: entry.id, index, total: entry.paragraphs.length })
      return { progress: saved }
    }
    const entry = await openBook(params.get('book'))
    return { progress: await readProgress(entry.path) }
  },

  /** GET → Sessions that hold a reader, newest first; POST {forget} drops one. */
  async sessions(req) {
    if (req.method === 'POST') {
      const body = await readBody(req)
      if (!isSessionId(body.forget)) throw httpError('参数 forget 非法')
      await forgetSession(body.forget)
    }
    const progress = await allProgress()
    const byBook = new Map(Object.values(progress).map((entry) => [entry.book, entry]))
    const sessions = (await readSessions()).map((entry) => {
      const saved = byBook.get(entry.book)
      return { ...entry, progress: saved ? { index: saved.index, total: saved.total } : null }
    })
    return { sessions }
  },

  /** GET ?book= → bookmarks; POST {book, index, text?} adds; POST {book, remove} deletes. */
  async notes(req, params) {
    if (req.method === 'POST') {
      const body = await readBody(req)
      const entry = await openBook(body.book)
      if (body.remove !== undefined) {
        if (typeof body.remove !== 'string' || body.remove.length > 64) throw httpError('参数 remove 非法')
        return { notes: await removeNote(entry.path, body.remove) }
      }
      const index = intParam(body.index, 'index', { max: Math.max(0, entry.paragraphs.length - 1) })
      if (body.text !== undefined && typeof body.text !== 'string') throw httpError('参数 text 必须是字符串')
      await addNote(entry.path, { index, text: body.text ?? entry.paragraphs[index].slice(0, 40) })
      return { notes: await readNotes(entry.path) }
    }
    const entry = await openBook(params.get('book'))
    return { notes: await readNotes(entry.path) }
  },
}

const POST_ROUTES = new Set(['config', 'progress', 'notes', 'sessions'])

/**
 * The single prefix handler: dispatch, method check, uniform error envelope.
 * Exported so the test suite can drive it without a web server.
 */
export async function handleApi(req, res) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(`${API_PREFIX}/`)) throw httpError('未知接口', 404)
    const route = url.pathname.slice(API_PREFIX.length + 1)
    if (!Object.hasOwn(routes, route)) throw httpError('未知接口', 404)
    const method = req.method ?? 'GET'
    if (method !== 'GET' && !(method === 'POST' && POST_ROUTES.has(route))) {
      res.setHeader?.('allow', POST_ROUTES.has(route) ? 'GET, POST' : 'GET')
      throw httpError('不支持的请求方法', 405)
    }
    const payload = await routes[route](req, url.searchParams)
    sendJson(res, 200, { ok: true, ...payload })
  } catch (error) {
    if (res.writableEnded) return
    const status = Number.isInteger(error?.status) ? error.status : 500
    const message = status === 500 ? `内部错误：${error?.message ?? error}` : error.message
    sendJson(res, status, { ok: false, error: message })
  }
}

/* ── plugin ──────────────────────────────────────────────────────────────── */

export function apply(ctx) {
  let titles = null
  ctx.inject(['sessionTitle'], (titleCtx) => {
    titles = titleCtx.sessionTitle
    titleCtx.effect(() => () => {
      titles = null
    }, 'dsh-chat-reader: session titles')
  })

  // Rejects only the empty turn started below; see lib/session.mjs.
  ctx.on('agent/pre-step', onPreStep, true)

  const afterRead = async (invocation, entry) => {
    const agent = invocation?.agent
    try {
      const config = await readConfig()
      if (!config.keepSession) return
      if (!sealBlankSession(agent)) return
      nameSession(titles, agent.session, config.sessionTitle || entry.title)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-chat-reader: keeping the reading session failed: ${error?.message ?? error}`)
    }
  }

  // `commands.register` is bound to this plugin's lifecycle and returns its disposer.
  ctx.commands.register(readCommand({ afterRead }))

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handleApi }),
      'dsh-chat-reader: api',
    )
  })
}
