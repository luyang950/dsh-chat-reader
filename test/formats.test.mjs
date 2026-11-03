// Encoding sniffing, paragraph splitting, chapter detection and EPUB parsing.

import assert from 'node:assert/strict'
import test from 'node:test'

import { detectChapters, isChapterHeading, parseMarkdown, splitParagraphs } from '../lib/book.mjs'
import { htmlToParagraphs, parseEpub, resolveInArchive } from '../lib/formats/epub.mjs'
import { decodeText, usesFourByteGb } from '../lib/formats/text.mjs'
import { encodeLegacy, encodeUtf16, sampleEpub } from './helpers.mjs'

const SIMPLIFIED =
  '第一章 风起云涌\n李四站在山巅，风从背后推来。他闭上眼睛，听见远处的松涛如潮水一般涌来。' +
  '这是他第一次来到这里，心里有些说不出的感觉。他们说这个地方有很多故事，可是没有人知道真相。\n'
const TRADITIONAL =
  '第一章 風起雲湧\n李四站在山巔，風從背後推來。他閉上眼睛，聽見遠處的松濤如潮水一般湧來。' +
  '這是他第一次來到這裡，心裡有些說不出的感覺。他們說這個地方有很多故事，可是沒有人知道真相。\n'

test('UTF-8 with and without BOM', () => {
  const plain = new TextEncoder().encode(SIMPLIFIED)
  assert.deepEqual(decodeText(plain), { text: SIMPLIFIED, encoding: 'utf-8' })
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...plain])
  assert.deepEqual(decodeText(bom), { text: SIMPLIFIED, encoding: 'utf-8' })
})

test('UTF-16 LE/BE with BOM', () => {
  assert.deepEqual(decodeText(encodeUtf16(SIMPLIFIED, true, true)), { text: SIMPLIFIED, encoding: 'utf-16le' })
  assert.deepEqual(decodeText(encodeUtf16(SIMPLIFIED, false, true)), { text: SIMPLIFIED, encoding: 'utf-16be' })
})

test('UTF-16 without BOM is recognised from NUL parity', () => {
  const english = 'Chapter One\nIt was a bright cold day in April, and the clocks were striking.\n'.repeat(5)
  assert.equal(decodeText(encodeUtf16(english, true, false)).encoding, 'utf-16le')
  assert.equal(decodeText(encodeUtf16(english, false, false)).encoding, 'utf-16be')
  assert.equal(decodeText(encodeUtf16(english, true, false)).text, english)
})

test('GBK simplified Chinese is decoded as GBK', () => {
  const result = decodeText(encodeLegacy(SIMPLIFIED, 'gbk'))
  assert.equal(result.encoding, 'gbk')
  assert.equal(result.text, SIMPLIFIED)
})

test('GB18030 is reported when a four-byte sequence is present', () => {
  // 81 30 81 30 is the first GB18030 four-byte code (U+0080).
  const bytes = Uint8Array.from([...encodeLegacy(SIMPLIFIED, 'gbk'), 0x81, 0x30, 0x81, 0x30])
  assert.equal(usesFourByteGb(bytes), true)
  const result = decodeText(bytes)
  assert.equal(result.encoding, 'gb18030')
  assert.ok(result.text.startsWith(SIMPLIFIED))
})

test('Big5 traditional Chinese is decoded as Big5, not mis-read as GBK', () => {
  const result = decodeText(encodeLegacy(TRADITIONAL, 'big5'))
  assert.equal(result.encoding, 'big5')
  assert.equal(result.text, TRADITIONAL)
})

test('one-line-per-paragraph Chinese text splits on lines and trims full-width indent', () => {
  const text = '　　第一段。\n　　第二段。\n\n　　第三段。\r\n'
  assert.deepEqual(splitParagraphs(text), ['第一段。', '第二段。', '第三段。'])
})

test('hard-wrapped English text splits on blank lines and re-joins wrapped lines', () => {
  const block = 'It was a bright cold day\nin April, and the clocks\nwere striking thirteen.'
  const text = Array.from({ length: 14 }, () => block).join('\n\n')
  const paragraphs = splitParagraphs(text)
  assert.equal(paragraphs.length, 14)
  assert.equal(paragraphs[0], 'It was a bright cold day in April, and the clocks were striking thirteen.')
})

test('hard-wrapped Chinese re-joins without inserting spaces', () => {
  const block = '他推开门，\n看见院子里\n站着一个人。'
  const text = Array.from({ length: 14 }, () => block).join('\n\n')
  assert.equal(splitParagraphs(text)[0], '他推开门，看见院子里站着一个人。')
})

test('very long paragraphs are cut at sentence ends', () => {
  const long = '这是一句很长的话。'.repeat(400)
  const paragraphs = splitParagraphs(long)
  assert.ok(paragraphs.length > 1)
  assert.ok(paragraphs.every((paragraph) => paragraph.length <= 1600))
  assert.equal(paragraphs.join(''), long)
})

test('chapter headings: Chinese and English conventions, prose is not a heading', () => {
  for (const heading of ['第一章 风起', '第 12 回 夜宴', '第三百二十一章', '卷三', '楔子', '番外 一', 'Chapter 7', 'CHAPTER IX', 'Prologue']) {
    assert.ok(isChapterHeading(heading), heading)
  }
  for (const prose of ['他说第一章写得不好。', '第一章'.padEnd(60, '啊'), 'The chapter ended.']) {
    assert.ok(!isChapterHeading(prose), prose)
  }
  const chapters = detectChapters(['序', '第一章 起', '正文', '第二章 承', '正文'])
  assert.deepEqual(chapters, [
    { title: '第一章 起', index: 1 },
    { title: '第二章 承', index: 3 },
  ])
})

test('markdown headings become chapters and markup is stripped', () => {
  const { paragraphs, chapters } = parseMarkdown(['# 第一部', '正文 [链接](http://x) ![图](a.png)', '## 小节 ##', '> 引文'])
  assert.deepEqual(paragraphs, ['第一部', '正文 链接', '小节', '引文'])
  assert.deepEqual(chapters, [
    { title: '第一部', index: 0 },
    { title: '小节', index: 2 },
  ])
})

test('EPUB: spine order, nav chapters with fragments, scripts/ruby dropped, entities decoded', () => {
  const book = parseEpub(sampleEpub())
  assert.equal(book.title, '测试之书')
  assert.deepEqual(book.paragraphs, ['第一章 起', '天色&将晚。', '他推门走了进来。', '序幕之外。', '第二章 承', '第二章的正文一段。'])
  assert.deepEqual(book.chapters, [
    { title: '第一章 起', index: 0 },
    { title: '第二章 承', index: 4 },
  ])
})

test('EPUB hrefs cannot climb out of the archive', () => {
  assert.equal(resolveInArchive('OEBPS/content.opf', '../../etc/passwd'), '')
  assert.equal(resolveInArchive('OEBPS/content.opf', 'text/c1.xhtml#x'), 'OEBPS/text/c1.xhtml')
  assert.equal(resolveInArchive('OEBPS/text/c1.xhtml', '../img/a%20b.png'), 'OEBPS/img/a b.png')
})

test('htmlToParagraphs maps element ids to paragraph indexes', () => {
  const { paragraphs, ids, heading } = htmlToParagraphs('<body><p>a</p><h2 id="x">B</h2><p id="y">c</p></body>')
  assert.deepEqual(paragraphs, ['a', 'B', 'c'])
  assert.equal(heading, 'B')
  assert.equal(ids.get('x'), 1)
  assert.equal(ids.get('y'), 2)
})

test('not-an-epub fails with a readable error', () => {
  assert.throws(() => parseEpub(Buffer.from('PK\u0003\u0004 nope')), /EPUB/)
})
