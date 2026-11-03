// lib/formats/epub.mjs — EPUB 2/3 → plain paragraphs + table of contents.
//
// No dependencies: a small ZIP central-directory reader (stored + deflate via
// node:zlib), then container.xml → OPF → spine. Each spine document is reduced
// to text with block elements as paragraph breaks. Chapters come from the EPUB 3
// nav document or the EPUB 2 NCX; when neither maps onto the spine, each spine
// document's first heading stands in.
//
// Only text is extracted. Images, scripts and styles are dropped, and nothing
// outside the archive is ever resolved.

import { inflateRawSync } from 'node:zlib'

const MAX_ENTRY_BYTES = 64 * 1024 * 1024

/* ── zip ─────────────────────────────────────────────────────────────────── */

export function isZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

/** Read the central directory into a name → reader map. */
export function readZip(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  // End-of-central-directory record: scan back over a possible comment (≤ 64 KB).
  let eocd = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (bytes.readUInt32LE(at) === 0x06054b50) {
      eocd = at
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 EPUB（找不到 ZIP 目录）')

  const count = bytes.readUInt16LE(eocd + 10)
  let cursor = bytes.readUInt32LE(eocd + 16)
  const entries = new Map()

  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('EPUB 的 ZIP 目录已损坏')
    }
    const method = bytes.readUInt16LE(cursor + 10)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const size = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const localOffset = bytes.readUInt32LE(cursor + 42)
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength

    entries.set(name, () => {
      if (size > MAX_ENTRY_BYTES) throw new Error(`EPUB 内文件过大：${name}`)
      if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`EPUB 条目损坏：${name}`)
      const localName = bytes.readUInt16LE(localOffset + 26)
      const localExtra = bytes.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + localName + localExtra
      const raw = bytes.subarray(start, start + compressedSize)
      if (method === 0) return raw
      if (method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES })
      throw new Error(`不支持的 ZIP 压缩方式 ${method}：${name}`)
    })
  }
  return entries
}

/* ── xml/html helpers ────────────────────────────────────────────────────── */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·',
  times: '×', copy: '©', reg: '®', laquo: '«', raquo: '»', bull: '•', emsp: ' ',
  ensp: ' ', thinsp: ' ', shy: '',
}

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named === undefined ? whole : named
  })
}

function attribute(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)
  return match ? decodeEntities(match[2] ?? match[3] ?? '') : ''
}

/** Resolve an href against a base path inside the archive, refusing to climb out. */
export function resolveInArchive(base, href) {
  const clean = decodeURIComponent(String(href).split('#')[0].split('?')[0])
  if (!clean) return ''
  const parts = clean.startsWith('/') ? [] : base.split('/').slice(0, -1)
  for (const segment of clean.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return ''
      parts.pop()
    } else {
      parts.push(segment)
    }
  }
  return parts.join('/')
}

const BLOCK_TAGS = /^(p|div|br|h[1-6]|li|tr|blockquote|section|article|pre|hr|dd|dt|figcaption|title)$/i

/**
 * Reduce one XHTML document to paragraphs.
 * @returns {{ paragraphs: string[], heading: string, ids: Map<string, number> }}
 *   `ids` maps element ids to the paragraph index they start at (for TOC fragments).
 */
export function htmlToParagraphs(html) {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html
  const stripped = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg|math|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<rt\b[\s\S]*?<\/rt>/gi, '') // ruby annotations would double the text

  const paragraphs = []
  const ids = new Map()
  let heading = ''
  let current = ''
  let inHeading = false
  let headingText = ''
  const pendingIds = []

  const flush = () => {
    const text = decodeEntities(current).replace(/[ \t\r\n ]+/g, ' ').trim()
    if (text) {
      for (const id of pendingIds.splice(0)) ids.set(id, paragraphs.length)
      paragraphs.push(text)
    }
    current = ''
  }

  const pattern = /<\/?([a-zA-Z][\w:-]*)([^>]*)>|([^<]+)/g
  let match
  while ((match = pattern.exec(stripped)) !== null) {
    if (match[3] !== undefined) {
      current += match[3]
      if (inHeading) headingText += match[3]
      continue
    }
    const tag = match[1].toLowerCase()
    const closing = match[0][1] === '/'
    if (!closing) {
      const id = attribute(match[0], 'id')
      if (id) pendingIds.push(id)
    }
    if (BLOCK_TAGS.test(tag)) flush()
    if (/^h[1-6]$/.test(tag)) {
      if (!closing) {
        inHeading = true
        headingText = ''
      } else {
        inHeading = false
        const text = decodeEntities(headingText).replace(/\s+/g, ' ').trim()
        if (text && !heading) heading = text
      }
    }
  }
  flush()
  // Ids that never preceded text point at the end of the document.
  for (const id of pendingIds) ids.set(id, paragraphs.length)
  return { paragraphs, heading, ids }
}

/* ── epub ────────────────────────────────────────────────────────────────── */

function readText(entries, name) {
  const read = entries.get(name)
  if (!read) return null
  return new TextDecoder('utf-8').decode(read())
}

function parseManifest(opf) {
  const manifest = new Map()
  for (const tag of opf.match(/<(?:opf:)?item\b[^>]*>/gi) ?? []) {
    manifest.set(attribute(tag, 'id'), {
      href: attribute(tag, 'href'),
      type: attribute(tag, 'media-type'),
      properties: attribute(tag, 'properties'),
    })
  }
  return manifest
}

/** Parse NCX navPoints or an EPUB 3 nav <ol> into [{ title, path, fragment }]. */
function parseToc(entries, opfPath, opf, manifest) {
  const toc = []
  const navItem = [...manifest.values()].find((item) => /\bnav\b/.test(item.properties))
  if (navItem) {
    const navPath = resolveInArchive(opfPath, navItem.href)
    const nav = readText(entries, navPath)
    const tocBlock = nav && (/<nav\b[^>]*epub:type\s*=\s*["']toc["'][^>]*>([\s\S]*?)<\/nav>/i.exec(nav)?.[1] ?? '')
    if (tocBlock) {
      for (const link of tocBlock.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
        const href = attribute(`<a ${link[1]}>`, 'href')
        const title = decodeEntities(link[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
        if (href && title) {
          toc.push({ title, path: resolveInArchive(navPath, href), fragment: href.split('#')[1] ?? '' })
        }
      }
      if (toc.length > 0) return toc
    }
  }

  const spineTag = /<(?:opf:)?spine\b[^>]*>/i.exec(opf)?.[0] ?? ''
  const ncxItem = manifest.get(attribute(spineTag, 'toc')) ??
    [...manifest.values()].find((item) => item.type === 'application/x-dtbncx+xml')
  if (!ncxItem) return toc
  const ncxPath = resolveInArchive(opfPath, ncxItem.href)
  const ncx = readText(entries, ncxPath)
  if (!ncx) return toc
  for (const point of ncx.matchAll(/<navPoint\b[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content\b([^>]*)\/?>/gi)) {
    const title = decodeEntities(point[1]).replace(/\s+/g, ' ').trim()
    const src = attribute(`<content ${point[2]}>`, 'src')
    if (title && src) toc.push({ title, path: resolveInArchive(ncxPath, src), fragment: src.split('#')[1] ?? '' })
  }
  return toc
}

/**
 * Parse an EPUB buffer.
 * @returns {{ title: string, paragraphs: string[], chapters: { title: string, index: number }[] }}
 */
export function parseEpub(buffer) {
  const entries = readZip(buffer)
  const container = readText(entries, 'META-INF/container.xml')
  if (!container) throw new Error('不是有效的 EPUB（缺少 META-INF/container.xml）')
  const rootfile = /<rootfile\b[^>]*>/i.exec(container)?.[0] ?? ''
  const opfPath = resolveInArchive('', attribute(rootfile, 'full-path'))
  const opf = opfPath ? readText(entries, opfPath) : null
  if (!opf) throw new Error('不是有效的 EPUB（找不到 OPF）')

  const title = decodeEntities(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1] ?? '')
    .replace(/<[^>]+>/g, '')
    .trim()
  const manifest = parseManifest(opf)
  const spineBlock = /<(?:opf:)?spine\b[^>]*>([\s\S]*?)<\/(?:opf:)?spine>/i.exec(opf)?.[1] ?? ''
  const spine = [...spineBlock.matchAll(/<(?:opf:)?itemref\b[^>]*>/gi)]
    .map((match) => manifest.get(attribute(match[0], 'idref')))
    .filter((item) => item && /x?html|xml/i.test(item.type || 'html'))
    .map((item) => resolveInArchive(opfPath, item.href))

  const paragraphs = []
  /** path → { start, ids, heading } */
  const documents = new Map()
  for (const path of spine) {
    if (documents.has(path)) continue
    const html = readText(entries, path)
    if (html === null) continue
    const parsed = htmlToParagraphs(html)
    documents.set(path, { start: paragraphs.length, ids: parsed.ids, heading: parsed.heading, count: parsed.paragraphs.length })
    for (const paragraph of parsed.paragraphs) paragraphs.push(paragraph)
  }

  const chapters = []
  for (const entry of parseToc(entries, opfPath, opf, manifest)) {
    const document = documents.get(entry.path)
    if (!document) continue
    const offset = entry.fragment && document.ids.has(entry.fragment) ? document.ids.get(entry.fragment) : 0
    const index = Math.min(document.start + offset, Math.max(0, paragraphs.length - 1))
    if (chapters.length > 0 && chapters[chapters.length - 1].index === index) continue
    chapters.push({ title: entry.title.slice(0, 80), index })
  }
  chapters.sort((a, b) => a.index - b.index)

  if (chapters.length === 0) {
    for (const document of documents.values()) {
      if (document.heading && document.count > 0) {
        chapters.push({ title: document.heading.slice(0, 80), index: document.start })
      }
    }
  }

  return { title, paragraphs, chapters }
}
