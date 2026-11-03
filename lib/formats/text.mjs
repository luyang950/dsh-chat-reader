// lib/formats/text.mjs — plain-text books: encoding sniffing.
//
// Order of evidence, strongest first:
//   1. a BOM (UTF-8 / UTF-16LE / UTF-16BE);
//   2. BOM-less UTF-16, recognised by NUL bytes piling up on one parity;
//   3. strict UTF-8 (a fatal decoder: one bad sequence and it is not UTF-8);
//   4. the CJK legacy code pages — GB18030 (reported as GBK when no four-byte
//      sequence is present) and Big5 — decoded strictly and scored by how many
//      common Chinese characters they produce, because a wrong code page often
//      decodes "successfully" into rare characters.
//
// Node ships full ICU, so every decoder here is a built-in TextDecoder.

const SAMPLE_BYTES = 64 * 1024

// High-frequency characters in both scripts. A correct decode of real prose hits
// these constantly; a mis-decode lands in rare code points and barely hits them.
const COMMON_CHARS = new Set(
  (
    '的一是不了在人有我他这這个個们們来來说說时時会會为為中大上国國到地也就' +
    '你她着著那要下以生自之过過家学學对對可里裏後后么麼心多天而能好都然没沒' +
    '日于於起还還发發成事只作当當想看文无無开開手用主行方又如前所本见見经經' +
    '头頭面公同已老从從动動两兩长長知现現样樣将將外但身些与與高意进進把法此' +
    '实實回理点點明其种種声聲全己话話向情正名定女问問力给給几幾很最间間新什' +
    '打便位因重被走电電第门門相次东東再真听聽世气氣信少关關并並内內道出去说'
  ).split(''),
)

function strictDecode(bytes, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function lenientDecode(bytes, encoding) {
  try {
    return new TextDecoder(encoding).decode(bytes)
  } catch {
    return null
  }
}

/** Share of common Chinese characters among the CJK ideographs of a sample. */
export function chineseScore(text) {
  let ideographs = 0
  let common = 0
  const limit = Math.min(text.length, 20000)
  for (let index = 0; index < limit; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0x4e00 && code <= 0x9fff) {
      ideographs += 1
      if (COMMON_CHARS.has(text[index])) common += 1
    }
  }
  return ideographs === 0 ? 0 : common / ideographs
}

/** Whether a GB18030 byte stream uses any four-byte sequence (i.e. is not plain GBK). */
export function usesFourByteGb(bytes) {
  const limit = Math.min(bytes.length, 4 * 1024 * 1024)
  for (let index = 0; index < limit; index += 1) {
    const lead = bytes[index]
    if (lead < 0x81 || lead === 0xff) continue
    const second = bytes[index + 1]
    if (second >= 0x30 && second <= 0x39) return true
    index += 1 // a two-byte character: skip its trail byte
  }
  return false
}

/** Detect BOM-less UTF-16 from the parity of NUL bytes in a sample. */
function sniffUtf16(bytes) {
  const sample = Math.min(bytes.length, SAMPLE_BYTES) & ~1
  if (sample < 4) return null
  let evenZeros = 0
  let oddZeros = 0
  for (let index = 0; index < sample; index += 2) {
    if (bytes[index] === 0) evenZeros += 1
    if (bytes[index + 1] === 0) oddZeros += 1
  }
  const pairs = sample / 2
  // ASCII-heavy UTF-16 has a NUL in nearly every pair on one side; CJK UTF-16 has
  // fewer, but the opposite side is still essentially NUL-free.
  if (oddZeros > pairs * 0.2 && evenZeros < pairs * 0.02) return 'utf-16le'
  if (evenZeros > pairs * 0.2 && oddZeros < pairs * 0.02) return 'utf-16be'
  return null
}

/**
 * Decode a text buffer.
 * @param {Uint8Array} buffer
 * @returns {{ text: string, encoding: string }}
 */
export function decodeText(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' }
  }

  const utf16 = sniffUtf16(bytes)
  if (utf16) return { text: new TextDecoder(utf16).decode(bytes), encoding: utf16 }

  const utf8 = strictDecode(bytes, 'utf-8')
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8' }

  const candidates = []
  const gb = strictDecode(bytes, 'gb18030')
  if (gb !== null) {
    candidates.push({ text: gb, encoding: usesFourByteGb(bytes) ? 'gb18030' : 'gbk' })
  }
  const big5 = strictDecode(bytes, 'big5')
  if (big5 !== null) candidates.push({ text: big5, encoding: 'big5' })

  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) {
    // Higher common-character share wins; GB wins an exact tie (it is far more common).
    candidates.sort((a, b) => chineseScore(b.text) - chineseScore(a.text))
    return candidates[0]
  }

  // Nothing decodes cleanly: prefer the legacy decode with the best score, else lossy UTF-8.
  const lossy = [
    { text: lenientDecode(bytes, 'gb18030'), encoding: 'gb18030' },
    { text: lenientDecode(bytes, 'big5'), encoding: 'big5' },
  ].filter((entry) => entry.text !== null)
  lossy.sort((a, b) => chineseScore(b.text) - chineseScore(a.text))
  if (lossy.length > 0 && chineseScore(lossy[0].text) > 0.15) {
    return { text: lossy[0].text, encoding: `${lossy[0].encoding}-lossy` }
  }
  return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8-lossy' }
}
