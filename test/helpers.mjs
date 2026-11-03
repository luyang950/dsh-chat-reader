// Shared test helpers: legacy-encoding encoder, a tiny ZIP writer, fake HTTP.

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { deflateRawSync } from 'node:zlib'

const encoders = new Map()

/**
 * Encode text into a two-byte legacy code page (gbk / big5) by inverting the
 * built-in decoder — Node has decoders for these but no encoders.
 */
export function encodeLegacy(text, encoding) {
  let table = encoders.get(encoding)
  if (!table) {
    table = new Map()
    const decoder = new TextDecoder(encoding, { fatal: true })
    for (let lead = 0x81; lead <= 0xfe; lead += 1) {
      for (let trail = 0x40; trail <= 0xfe; trail += 1) {
        try {
          const char = decoder.decode(Uint8Array.of(lead, trail))
          if (char.length === 1 && !table.has(char)) table.set(char, [lead, trail])
        } catch {
          // unmapped pair
        }
      }
    }
    encoders.set(encoding, table)
  }
  const bytes = []
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code < 0x80) bytes.push(code)
    else {
      const pair = table.get(char)
      if (!pair) throw new Error(`cannot encode ${char} in ${encoding}`)
      bytes.push(...pair)
    }
  }
  return Uint8Array.from(bytes)
}

export function encodeUtf16(text, littleEndian, bom) {
  const bytes = []
  if (bom) bytes.push(...(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]))
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (littleEndian) bytes.push(unit & 0xff, unit >> 8)
    else bytes.push(unit >> 8, unit & 0xff)
  }
  return Uint8Array.from(bytes)
}

/** Build a ZIP archive from { name: string|Buffer } (deflate unless `stored`). */
export function makeZip(files, { stored = [] } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const method = stored.includes(name) ? 0 : 8
    const body = method === 0 ? data : deflateRawSync(data)
    const nameBytes = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + body.length
  }
  const centralBytes = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}

/** A two-chapter EPUB 3 with a nav document. */
export function sampleEpub() {
  return makeZip(
    {
      mimetype: 'application/epub+zip',
      'META-INF/container.xml':
        '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      'OEBPS/content.opf': `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试之书</dc:title></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`,
      'OEBPS/nav.xhtml':
        '<html><body><nav epub:type="toc"><ol><li><a href="text/c1.xhtml">第一章 起</a></li><li><a href="text/c2.xhtml#s2">第二章 承</a></li></ol></nav></body></html>',
      'OEBPS/text/c1.xhtml':
        '<html><head><title>c1</title><style>p{}</style></head><body><h1>第一章 起</h1><p>天色&amp;将晚。</p><p>他推门<ruby>走<rt>zou</rt></ruby>了进来。</p></body></html>',
      'OEBPS/text/c2.xhtml':
        '<html><body><p>序幕之外。</p><h2 id="s2">第二章 承</h2><p>第二章的正文&#x4E00;段。</p><script>alert(1)</script></body></html>',
    },
    { stored: ['mimetype'] },
  )
}

export async function tempDir(prefix = 'dcr-') {
  return mkdtemp(join(tmpdir(), prefix))
}

/** A minimal IncomingMessage stand-in. */
export function fakeRequest(method, url, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = body === undefined ? headers : { 'content-type': 'application/json', ...headers }
  return req
}

/** A minimal ServerResponse stand-in that records status, headers and JSON body. */
export function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writableEnded: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    writeHead(status, headers = {}) {
      this.status = status
      for (const [name, value] of Object.entries(headers)) this.headers[name.toLowerCase()] = value
    },
    end(body = '') {
      this.body = String(body)
      this.writableEnded = true
    },
    get json() {
      return JSON.parse(this.body)
    },
  }
}
