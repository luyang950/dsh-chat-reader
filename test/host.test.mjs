// Host half: config/progress persistence, path confinement, route parameter validation,
// and the /read command result (metadata only — never book text).

import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { before } from 'node:test'

import { API_PREFIX, apply, handleApi, inject, intParam, readCommand } from '../index.mjs'
import { clearBookCache, normalizeBookId, resolveBook } from '../lib/book.mjs'
import {
  dataDirectory,
  normalizeChord,
  readConfig,
  readProgress,
  validateConfigPatch,
  writeConfig,
  writeProgress,
} from '../lib/store.mjs'
import { encodeLegacy, fakeRequest, fakeResponse, sampleEpub, tempDir } from './helpers.mjs'

let home
let library
let outside

const NOVEL = ['第一章 开端', '　　天色将晚，他推门而入。', '　　屋里没有人。', '第二章 转折', '　　风停了。', '　　故事继续。'].join('\n')

before(async () => {
  home = await tempDir('dcr-home-')
  library = await tempDir('dcr-lib-')
  outside = await tempDir('dcr-out-')
  process.env.DSH_HOME = home

  await mkdir(join(library, '武侠'), { recursive: true })
  await writeFile(join(library, '武侠', '小说.txt'), encodeLegacy(NOVEL, 'gbk'))
  await writeFile(join(library, 'notes.md'), '# 标题\n\n正文一段。\n')
  await writeFile(join(library, 'book.epub'), sampleEpub())
  await writeFile(join(library, 'secret.json'), '{"no":1}')
  await writeFile(join(outside, 'escape.txt'), '书库外的文件')
  await symlink(join(outside, 'escape.txt'), join(library, 'link.txt'))
  await writeConfig({ libraryRoot: library })
})

async function api(method, path, body) {
  const res = fakeResponse()
  await handleApi(fakeRequest(method, `${API_PREFIX}${path}`, body), res)
  return { status: res.status, body: res.json, headers: res.headers }
}

/* ── store ───────────────────────────────────────────────────────────────── */

test('persistence lives only under $DSH_HOME/dsh-chat-reader', async () => {
  assert.equal(dataDirectory(), join(home, 'dsh-chat-reader'))
  const stored = JSON.parse(await readFile(join(home, 'dsh-chat-reader', 'config.json'), 'utf8'))
  assert.equal(stored.libraryRoot, library)
})

test('config validation clamps numbers and refuses bad values', async () => {
  assert.deepEqual(validateConfigPatch({ fontSize: 99, lineHeight: 0.5 }).value, { fontSize: 28, lineHeight: 1.2 })
  assert.ok(validateConfigPatch({ speed: 30 }).errors.length > 0, 'speed is gone with the typewriter')
  assert.equal(validateConfigPatch({ fontSize: 0 }).value.fontSize, 0)
  assert.ok(validateConfigPatch({ libraryRoot: 'relative/path' }).errors.length > 0)
  assert.ok(validateConfigPatch({ hack: 1 }).errors.length > 0)
  await assert.rejects(writeConfig({ bossKey: 'KeyB' }), /老板键/)
  const config = await readConfig()
  assert.equal(config.libraryRoot, library)
  assert.equal(config.bossKey, 'Ctrl+Alt+KeyB')
})

test('boss-key chords need a real modifier and are normalised', () => {
  assert.equal(normalizeChord('alt+ctrl+KeyB'), 'Ctrl+Alt+KeyB')
  assert.equal(normalizeChord('Meta+Shift+Period'), 'Shift+Meta+Period')
  assert.equal(normalizeChord('F9'), 'F9')
  assert.equal(normalizeChord('KeyB'), null)
  assert.equal(normalizeChord('Shift+KeyB'), null)
  assert.equal(normalizeChord('Ctrl+Space'), null)
  assert.equal(normalizeChord('Ctrl+Ctrl+KeyB'), null)
})

test('progress round-trips per book and survives a re-read (restart)', async () => {
  await writeProgress('/a/one.txt', { book: 'one.txt', index: 12, total: 100 })
  await writeProgress('/a/two.txt', { book: 'two.txt', index: 3, total: 9 })
  assert.equal((await readProgress('/a/one.txt')).index, 12)
  assert.equal((await readProgress('/a/two.txt')).index, 3)
  assert.equal(await readProgress('/a/none.txt'), null)
  const raw = JSON.parse(await readFile(join(home, 'dsh-chat-reader', 'progress.json'), 'utf8'))
  assert.equal(raw.last.book, 'two.txt')
})

test('concurrent progress writes never tear the file', async () => {
  await Promise.all(Array.from({ length: 30 }, (_, index) => writeProgress(`/c/${index}.txt`, { book: `${index}.txt`, index, total: 50 })))
  const raw = JSON.parse(await readFile(join(home, 'dsh-chat-reader', 'progress.json'), 'utf8'))
  for (let index = 0; index < 30; index += 1) assert.equal(raw.books[`/c/${index}.txt`].index, index)
})

/* ── confinement ─────────────────────────────────────────────────────────── */

test('book ids: absolute paths, traversal, backslashes, NUL and bad extensions are refused', () => {
  assert.equal(normalizeBookId('武侠//./小说.txt'), '武侠/小说.txt')
  for (const [value, pattern] of [
    ['/etc/passwd.txt', /相对路径/],
    ['~/x.txt', /相对路径/],
    ['C:/x.txt', /相对路径/],
    ['../x.txt', /穿越/],
    ['a/../../x.txt', /穿越/],
    ['a\\x.txt', /反斜杠/],
    ['a\0.txt', /非法/],
    ['secret.json', /不支持/],
    ['noext', /不支持/],
    ['', /缺少/],
  ]) {
    assert.throws(() => normalizeBookId(value), pattern, JSON.stringify(value))
  }
})

test('a symlink pointing outside the library is refused', async () => {
  await assert.rejects(resolveBook(library, 'link.txt'), (error) => error.status === 403)
})

test('files over 256 MB are refused before reading', async () => {
  const big = join(library, 'huge.txt')
  await writeFile(big, '')
  await truncate(big, 256 * 1024 * 1024 + 1) // sparse: costs no disk
  await assert.rejects(resolveBook(library, 'huge.txt'), (error) => error.status === 413)
})

/* ── routes ──────────────────────────────────────────────────────────────── */

test('route: open returns metadata (GBK decoded, chapters) but no text', async () => {
  const { status, body } = await api('GET', `/open?book=${encodeURIComponent('武侠/小说.txt')}`)
  assert.equal(status, 200)
  assert.equal(body.book.encoding, 'gbk')
  assert.equal(body.book.paragraphCount, 6)
  assert.deepEqual(body.book.chapters.map((chapter) => chapter.index), [0, 3])
  assert.ok(!JSON.stringify(body).includes('天色将晚'))
})

test('route: paragraphs pages by absolute index and validates numbers', async () => {
  const book = encodeURIComponent('武侠/小说.txt')
  const page = await api('GET', `/paragraphs?book=${book}&from=1&count=2`)
  assert.equal(page.status, 200)
  assert.deepEqual(page.body.items, ['天色将晚，他推门而入。', '屋里没有人。'])
  assert.equal(page.body.total, 6)
  for (const query of ['from=-1', 'from=1.5', 'from=abc', 'count=0', 'count=201', 'from=99']) {
    const bad = await api('GET', `/paragraphs?book=${book}&${query}`)
    assert.equal(bad.status, 400, query)
    assert.equal(bad.body.ok, false)
  }
})

test('route: traversal, absolute paths, wrong extensions and outside symlinks are rejected', async () => {
  const cases = [
    ['../../etc/passwd.txt', 403],
    [encodeURIComponent('/etc/hosts.txt'), 403],
    ['%2e%2e%2fsecret.txt', 403],
    ['secret.json', 415],
    ['link.txt', 403],
    ['missing.txt', 404],
  ]
  for (const [book, status] of cases) {
    const response = await api('GET', `/paragraphs?book=${book}`)
    assert.equal(response.status, status, book)
    assert.equal(response.body.ok, false)
  }
  assert.equal((await api('GET', '/paragraphs')).status, 400)
})

test('route: progress POST/GET round-trip, index bounds, JSON body checks', async () => {
  const book = '武侠/小说.txt'
  assert.equal((await api('POST', '/progress', { book, index: 4 })).status, 200)
  const read = await api('GET', `/progress?book=${encodeURIComponent(book)}`)
  assert.equal(read.body.progress.index, 4)
  assert.equal((await api('POST', '/progress', { book, index: 7 })).status, 400)
  assert.equal((await api('POST', '/progress', { book, index: -1 })).status, 400)
  assert.equal((await api('POST', '/progress', { book: '../x.txt', index: 1 })).status, 403)

  const res = fakeResponse()
  await handleApi(fakeRequest('POST', `${API_PREFIX}/progress`, 'not json'), res)
  assert.equal(res.status, 400)

  const plain = fakeResponse()
  const req = fakeRequest('POST', `${API_PREFIX}/progress`, '{}', { 'content-type': 'text/plain' })
  await handleApi(req, plain)
  assert.equal(plain.status, 415)

  const huge = fakeResponse()
  await handleApi(fakeRequest('POST', `${API_PREFIX}/progress`, { book, pad: 'x'.repeat(20000) }), huge)
  assert.equal(huge.status, 413)
})

test('route: unknown endpoints 404, wrong methods 405', async () => {
  assert.equal((await api('GET', '/nope')).status, 404)
  assert.equal((await api('GET', '/__proto__')).status, 404)
  assert.equal((await api('POST', '/paragraphs', {})).status, 405)
  assert.equal((await api('DELETE', '/config')).status, 405)
})

test('route: search finds paragraphs and validates the query', async () => {
  const book = encodeURIComponent('武侠/小说.txt')
  const found = await api('GET', `/search?book=${book}&q=${encodeURIComponent('风停')}`)
  assert.deepEqual(found.body.hits.map((hit) => hit.index), [4])
  assert.equal((await api('GET', `/search?book=${book}&q=`)).status, 400)
  assert.equal((await api('GET', `/search?book=${book}&q=${'x'.repeat(101)}`)).status, 400)
})

test('route: library lists only whitelisted books inside the root', async () => {
  const { body } = await api('GET', '/library')
  const ids = body.books.map((book) => book.book)
  assert.ok(ids.includes('武侠/小说.txt'))
  assert.ok(ids.includes('book.epub'))
  assert.ok(ids.includes('notes.md'))
  assert.ok(!ids.includes('secret.json'))
  assert.ok(!ids.includes('link.txt'), 'symlinks are not listed')
})

test('route: config GET/POST validates', async () => {
  assert.equal((await api('POST', '/config', { lineHeight: 2.2 })).body.config.lineHeight, 2.2)
  assert.equal((await api('POST', '/config', { lineHeight: 'tall' })).status, 400)
  assert.equal((await api('GET', '/config')).body.config.lineHeight, 2.2)
})

test('route: bookmarks add and remove', async () => {
  const added = await api('POST', '/notes', { book: 'book.epub', index: 2 })
  assert.equal(added.body.notes.length, 1)
  const removed = await api('POST', '/notes', { book: 'book.epub', remove: added.body.notes[0].id })
  assert.equal(removed.body.notes.length, 0)
})

/* ── /read command ───────────────────────────────────────────────────────── */

test('/read settles with a small summary — never the book text (zero tokens)', async () => {
  clearBookCache()
  const command = readCommand()
  assert.equal(command.name, 'read')
  assert.equal(command.recordInput, true)
  const result = await command.handler({ rawInput: ' 小说' })
  assert.equal(result.kind, 'success')
  const summary = JSON.parse(result.text)
  assert.deepEqual(summary, { book: '武侠/小说.txt', title: '小说', format: 'txt', paragraphCount: 6 })
  assert.ok(result.text.length < 200)
  assert.ok(!result.text.includes('天色'))
})

test('/read: empty argument resumes the last book; ambiguity and escapes are errors', async () => {
  await api('POST', '/progress', { book: 'book.epub', index: 1 })
  const resumed = await readCommand().handler({ rawInput: '' })
  assert.equal(JSON.parse(resumed.text).book, 'book.epub')

  await writeFile(join(library, '小说二.txt'), '另一本')
  const ambiguous = await readCommand().handler({ rawInput: '说' })
  assert.equal(ambiguous.kind, 'error')
  assert.match(ambiguous.text, /2 本/)
  // An exact title still wins over partial matches.
  const exact = await readCommand().handler({ rawInput: '小说' })
  assert.equal(JSON.parse(exact.text).book, '武侠/小说.txt')

  const escaped = await readCommand().handler({ rawInput: join(outside, 'escape.txt') })
  assert.equal(escaped.kind, 'error')
  assert.match(escaped.text, /书库内/)

  const absoluteInside = await readCommand().handler({ rawInput: join(library, 'notes.md') })
  assert.equal(JSON.parse(absoluteInside.text).book, 'notes.md')
})

test('/read remembers the Session it ran in; GET /sessions lists them newest first with progress', async () => {
  const invocation = (rawInput, id) => ({ rawInput, agent: { id, session: { id } } })
  await readCommand().handler(invocation('小说', 'session-aaa'))
  await readCommand().handler(invocation('notes', 'session-bbb'))
  await api('POST', '/progress', { book: '武侠/小说.txt', index: 3 })

  let listed = await api('GET', '/sessions')
  assert.equal(listed.status, 200)
  assert.deepEqual(
    listed.body.sessions.map((entry) => [entry.sessionId, entry.book]),
    [['session-bbb', 'notes.md'], ['session-aaa', '武侠/小说.txt']],
  )
  assert.deepEqual(listed.body.sessions[1].progress, { index: 3, total: 6 })

  // Reading again in the same Session moves it to the top without duplicating it.
  await readCommand().handler(invocation('小说', 'session-aaa'))
  listed = await api('GET', '/sessions')
  assert.deepEqual(listed.body.sessions.map((entry) => entry.sessionId), ['session-aaa', 'session-bbb'])

  // A failed /read and a junk session id record nothing.
  await readCommand().handler(invocation('没有这本书', 'session-ccc'))
  await readCommand().handler(invocation('小说', '../../etc'))
  listed = await api('GET', '/sessions')
  assert.deepEqual(listed.body.sessions.map((entry) => entry.sessionId), ['session-aaa', 'session-bbb'])

  const forgot = await api('POST', '/sessions', { forget: 'session-bbb' })
  assert.deepEqual(forgot.body.sessions.map((entry) => entry.sessionId), ['session-aaa'])
  assert.equal((await api('POST', '/sessions', { forget: 42 })).status, 400)
  assert.equal(JSON.parse(await readFile(join(home, 'dsh-chat-reader', 'sessions.json'), 'utf8')).sessions.length, 1)
})

test('intParam rejects non-integers and out-of-range values', () => {
  assert.equal(intParam('5', 'x'), 5)
  assert.equal(intParam(null, 'x', { fallback: 3 }), 3)
  assert.throws(() => intParam('1e3', 'x'))
  assert.throws(() => intParam('5', 'x', { max: 4 }))
  assert.throws(() => intParam(undefined, 'x'))
})

/* ── plugin wiring ───────────────────────────────────────────────────────── */

test('host plugin: injects only commands; webServer attached lazily via ctx.inject', () => {
  assert.deepEqual(inject, ['commands'])
  const commands = []
  const routes = []
  const ctx = {
    commands: { register: (definition) => commands.push(definition) },
    inject(services, callback) {
      assert.deepEqual(services, ['webServer'])
      callback({
        webServer: { register: (route) => (routes.push(route), () => {}) },
        effect: (run) => run(),
      })
    },
  }
  apply(ctx)
  assert.deepEqual(commands.map((command) => command.name), ['read'])
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/dsh-chat-reader/api')
})
