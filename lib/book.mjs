// lib/book.mjs — the library model: a confined book id → parsed paragraphs + chapters.
//
// Access policy (this file is the only place a caller-supplied name becomes a path):
//   * a book is addressed by an id: a relative POSIX path inside the library root;
//   * absolute paths, `..`, backslashes, NUL and over-long ids are refused outright;
//   * the extension must be whitelisted (.txt / .md / .epub);
//   * the resolved *real* path (symlinks followed) must still sit inside the real
//     library root, so a symlink cannot be used to step outside it;
//   * files over 256 MB are refused before they are read;
//   * files are only ever read — nothing here writes next to a book.

import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'

import { parseEpub } from './formats/epub.mjs'
import { decodeText } from './formats/text.mjs'

export const BOOK_EXTENSIONS = Object.freeze(['.txt', '.md', '.epub'])
export const MAX_BOOK_BYTES = 256 * 1024 * 1024
export const MAX_ID_LENGTH = 1024
export const MAX_WINDOW = 200
export const MAX_PARAGRAPH_CHARS = 1600

/** An expected, user-facing failure carrying the HTTP status it maps to. */
export class BookError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'BookError'
    this.status = status
  }
}

/* ── ids ─────────────────────────────────────────────────────────────────── */

/**
 * Validate a book id and return its normalised form.
 * @param {unknown} value
 * @returns {string} relative POSIX path, e.g. `武侠/射雕.txt`
 */
export function normalizeBookId(value) {
  if (typeof value !== 'string' || value.length === 0) throw new BookError('缺少参数 book')
  if (value.length > MAX_ID_LENGTH) throw new BookError('参数 book 过长')
  if (value.includes('\0')) throw new BookError('参数 book 含非法字符')
  if (value.includes('\\')) throw new BookError('参数 book 不能包含反斜杠')
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value) || value.startsWith('~')) {
    throw new BookError('只接受书库内的相对路径', 403)
  }
  const segments = value.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) throw new BookError('缺少参数 book')
  if (segments.some((segment) => segment === '..')) throw new BookError('拒绝目录穿越', 403)
  const id = segments.join('/')
  if (!BOOK_EXTENSIONS.includes(extname(id).toLowerCase())) {
    throw new BookError(`不支持的格式：${extname(id) || '(无扩展名)'}，只接受 ${BOOK_EXTENSIONS.join(' / ')}`, 415)
  }
  return id
}

function isInside(root, target) {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel)
}

/** Real path of the library root, or a BookError when it is unusable. */
export async function realRoot(root) {
  if (typeof root !== 'string' || !root) throw new BookError('还没有设置书库根目录（设置 → 阅读）', 409)
  const resolved = await realpath(root).catch(() => null)
  if (!resolved) throw new BookError(`书库根目录不存在：${root}`, 404)
  const info = await stat(resolved)
  if (!info.isDirectory()) throw new BookError(`书库根目录不是目录：${root}`, 409)
  return resolved
}

/**
 * Resolve a book id to a readable file inside the library root.
 * @returns {Promise<{ id: string, path: string, size: number, mtimeMs: number }>}
 */
export async function resolveBook(root, value) {
  const id = normalizeBookId(value)
  const base = await realRoot(root)
  const candidate = join(base, ...id.split('/'))
  const real = await realpath(candidate).catch(() => null)
  if (!real) throw new BookError(`书库里没有这本书：${id}`, 404)
  if (!isInside(base, real)) throw new BookError('拒绝访问书库以外的文件', 403)
  if (!BOOK_EXTENSIONS.includes(extname(real).toLowerCase())) {
    throw new BookError('链接指向了不支持的格式', 415)
  }
  const info = await stat(real)
  if (!info.isFile()) throw new BookError(`不是文件：${id}`, 400)
  if (info.size > MAX_BOOK_BYTES) throw new BookError(`文件超过 ${MAX_BOOK_BYTES / 1024 / 1024} MB 上限`, 413)
  return { id, path: real, size: info.size, mtimeMs: info.mtimeMs }
}

/* ── text → paragraphs ───────────────────────────────────────────────────── */

const CJK_END = /[　-〿㐀-鿿＀-￯]$/

/** Break a very long paragraph at sentence ends so typing and scrolling stay sane. */
function splitLong(paragraph) {
  if (paragraph.length <= MAX_PARAGRAPH_CHARS) return [paragraph]
  const parts = []
  let rest = paragraph
  while (rest.length > MAX_PARAGRAPH_CHARS) {
    const window = rest.slice(0, MAX_PARAGRAPH_CHARS)
    let cut = -1
    for (const mark of ['。', '！', '？', '. ', '! ', '? ', '；', '，', ', ']) {
      cut = Math.max(cut, window.lastIndexOf(mark))
    }
    cut = cut > MAX_PARAGRAPH_CHARS / 3 ? cut + 1 : MAX_PARAGRAPH_CHARS
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

/**
 * Split prose into paragraphs.
 *
 * One-line-per-paragraph files (the usual Chinese .txt) use lines. Hard-wrapped
 * files with blank lines between paragraphs (the usual English .txt) use blank-line
 * blocks, re-joining the wrapped lines — without a space after CJK text.
 */
export function splitParagraphs(text) {
  const normalized = String(text).replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const nonEmpty = lines.filter((line) => line.trim() !== '').length
  const blocks = normalized.split(/\n[ \t　]*\n+/)

  let raw
  if (nonEmpty > 0 && blocks.length >= 12 && blocks.length < nonEmpty * 0.6) {
    raw = blocks.map((block) =>
      block
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .reduce((joined, line) => (joined === '' ? line : CJK_END.test(joined) ? joined + line : `${joined} ${line}`), ''),
    )
  } else {
    raw = lines
  }

  const paragraphs = []
  for (const entry of raw) {
    const trimmed = entry.replace(/^[\s　]+|[\s　]+$/g, '')
    if (!trimmed) continue
    for (const part of splitLong(trimmed)) paragraphs.push(part)
  }
  return paragraphs
}

const CHAPTER_PATTERN = new RegExp(
  '^(?:' +
    [
      '第\\s*[0-9０-９零〇一二两三四五六七八九十百千万]{1,10}\\s*[章节節回卷篇部集幕]',
      '卷\\s*[0-9０-９零〇一二两三四五六七八九十百千万]{1,6}',
      '(?:chapter|part|book|volume)\\s+(?:[0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\\b',
      '(?:prologue|epilogue|preface|foreword|introduction|afterword)\\b',
      '序章|序言|序幕|自序|前言|引子|楔子|尾声|尾聲|后记|後記|番外|终章|終章|大结局|附录|附錄',
    ].join('|') +
    ')',
  'i',
)

/** Is this paragraph a chapter heading? */
export function isChapterHeading(paragraph) {
  return paragraph.length <= 40 && CHAPTER_PATTERN.test(paragraph)
}

/**
 * Find chapter starts by heading convention.
 * @param {string[]} paragraphs
 * @returns {{ title: string, index: number }[]}
 */
export function detectChapters(paragraphs) {
  const chapters = []
  for (let index = 0; index < paragraphs.length && chapters.length < 5000; index += 1) {
    if (isChapterHeading(paragraphs[index])) chapters.push({ title: paragraphs[index].slice(0, 80), index })
  }
  return chapters
}

/**
 * Markdown: `#`–`###` headings are chapters; images vanish, links keep their text.
 * @param {string[]} raw paragraphs from splitParagraphs
 */
export function parseMarkdown(raw) {
  const paragraphs = []
  const chapters = []
  for (const paragraph of raw) {
    const heading = /^#{1,3}\s+(\S.*)$/.exec(paragraph)
    const cleaned = (heading ? heading[1] : paragraph.replace(/^#{4,6}\s+/, ''))
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^>\s?/, '')
      .replace(/\s+#+\s*$/, '')
      .trim()
    if (!cleaned) continue
    if (heading && chapters.length < 5000) chapters.push({ title: cleaned.slice(0, 80), index: paragraphs.length })
    paragraphs.push(cleaned)
  }
  return { paragraphs, chapters }
}

/* ── loading ─────────────────────────────────────────────────────────────── */

const CACHE_LIMIT = 2
const cache = new Map() // real path → { key, promise }

async function parseFile(resolved) {
  const bytes = await readFile(resolved.path)
  const extension = extname(resolved.path).toLowerCase()
  if (extension === '.epub') {
    const parsed = parseEpub(bytes)
    const paragraphs = parsed.paragraphs.flatMap(splitLong)
    // TOC indexes were computed before long paragraphs were split; remap them.
    const remapped = remapChapters(parsed.paragraphs, parsed.chapters)
    return { title: parsed.title, encoding: 'epub', paragraphs, chapters: remapped }
  }
  const decoded = decodeText(bytes)
  if (extension === '.md') {
    const { paragraphs, chapters } = parseMarkdown(splitParagraphs(decoded.text))
    return { title: '', encoding: decoded.encoding, paragraphs, chapters }
  }
  const paragraphs = splitParagraphs(decoded.text)
  return { title: '', encoding: decoded.encoding, paragraphs, chapters: detectChapters(paragraphs) }
}

function remapChapters(original, chapters) {
  const starts = []
  let cursor = 0
  for (const paragraph of original) {
    starts.push(cursor)
    cursor += splitLong(paragraph).length
  }
  return chapters.map((chapter) => ({ title: chapter.title, index: starts[chapter.index] ?? 0 }))
}

/**
 * Parse a book (cached by real path + mtime + size).
 * @returns {Promise<BookEntry>}
 */
export async function loadBook(root, id) {
  const resolved = await resolveBook(root, id)
  const key = `${resolved.mtimeMs}:${resolved.size}`
  const hit = cache.get(resolved.path)
  if (hit && hit.key === key) {
    cache.delete(resolved.path)
    cache.set(resolved.path, hit)
    return hit.promise
  }

  const promise = parseFile(resolved).then((parsed) => {
    if (parsed.paragraphs.length === 0) throw new BookError('这本书没有可读的正文', 422)
    return Object.freeze({
      id: resolved.id,
      path: resolved.path,
      name: basename(resolved.path),
      title: parsed.title || basename(resolved.path).replace(/\.[^.]+$/, ''),
      format: extname(resolved.path).slice(1).toLowerCase(),
      encoding: parsed.encoding,
      bytes: resolved.size,
      chars: parsed.paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0),
      paragraphs: parsed.paragraphs,
      chapters: parsed.chapters,
    })
  })
  cache.set(resolved.path, { key, promise })
  promise.catch(() => cache.delete(resolved.path))
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
  return promise
}

/** Drop every cached parse (tests, config changes). */
export function clearBookCache() {
  cache.clear()
}

/** Metadata small enough for a command result — never the text. */
export function bookSummary(entry) {
  return {
    book: entry.id,
    title: entry.title,
    format: entry.format,
    paragraphCount: entry.paragraphs.length,
  }
}

/** Metadata the reader card fetches when it mounts. */
export function publicBook(entry) {
  return {
    book: entry.id,
    name: entry.name,
    title: entry.title,
    format: entry.format,
    encoding: entry.encoding,
    bytes: entry.bytes,
    chars: entry.chars,
    paragraphCount: entry.paragraphs.length,
    chapters: entry.chapters,
  }
}

/** One window of paragraphs, addressed by absolute index. */
export function paragraphWindow(entry, from, count) {
  const total = entry.paragraphs.length
  const start = Math.max(0, Math.min(total, from))
  const size = Math.max(1, Math.min(MAX_WINDOW, count))
  return { from: start, total, items: entry.paragraphs.slice(start, start + size) }
}

/**
 * Find paragraphs containing `query`, starting at `from` and wrapping once.
 * @returns {{ hits: { index: number, snippet: string }[], total: number }}
 */
export function searchBook(entry, query, from = 0, limit = 50) {
  const needle = String(query).toLowerCase()
  const paragraphs = entry.paragraphs
  const hits = []
  if (!needle) return { hits, total: 0 }
  const count = paragraphs.length
  const start = Math.max(0, Math.min(count - 1, from))
  for (let step = 0; step < count && hits.length < limit; step += 1) {
    const index = (start + step) % count
    const at = paragraphs[index].toLowerCase().indexOf(needle)
    if (at < 0) continue
    const left = Math.max(0, at - 24)
    const snippet = (left > 0 ? '…' : '') + paragraphs[index].slice(left, at + needle.length + 36)
    hits.push({ index, snippet })
  }
  return { hits, total: hits.length }
}

/**
 * List the books under the library root (bounded walk; symlinks are skipped).
 * @returns {Promise<{ root: string, books: { book: string, name: string, bytes: number }[], truncated: boolean }>}
 */
export async function listLibrary(root, { query = '', depth = 4, limit = 500 } = {}) {
  const base = await realRoot(root)
  const needle = String(query).trim().toLowerCase()
  const books = []
  let visited = 0
  let truncated = false

  const walk = async (directory, level) => {
    if (truncated || visited >= 2000) {
      truncated = true
      return
    }
    visited += 1
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (level < depth) await walk(full, level + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!BOOK_EXTENSIONS.includes(extname(entry.name).toLowerCase())) continue
      const id = relative(base, full).split(sep).join('/')
      if (needle && !id.toLowerCase().includes(needle)) continue
      if (books.length >= limit) {
        truncated = true
        return
      }
      const info = await stat(full).catch(() => null)
      books.push({ book: id, name: entry.name, bytes: info?.size ?? 0 })
    }
  }

  await walk(base, 0)
  books.sort((a, b) => a.book.localeCompare(b.book, 'zh'))
  return { root: base, books, truncated }
}
