/* global window, document, fetch, navigator, localStorage, Blob, ResizeObserver, setTimeout, clearTimeout, requestAnimationFrame, cancelAnimationFrame */
// dsh-chat-reader — browser half.
//
// Hand-written ModuleLoader bundle: no build step, the only module required is
// `react`, and only the injected `slots` / `uiConversation` services are used.
//
// How the reader lives in the transcript:
//   `/read <book>` logs the ordinary durable `command/run` + `command/done` pair
//   (log-only events — never model messages, so zero tokens). A custom Definition
//   folds that pair into one chat node of kind `dsh-chat-reader`; the node renders
//   the reader card exactly where the user typed `/read`. The generic command row
//   is suppressed by registering an empty `read` commandview.
//
// Geometry: the card is sized from the CSS variables the conversation scroller
// publishes (`--dsh-conversation-viewport-height`, `--dsh-composer-height`), so its
// height never depends on its content. The text is rendered whole and scrolls inside
// the card's own scroller, so the transcript above never reflows as paragraphs load.

window.__ModuleLoader__.load({
  id: 'dsh-chat-reader',
  factory: (require) => {
    var module = { exports: {} }

    const React = require('react')
    const h = React.createElement

    const API = '/dsh-chat-reader/api'
    const KIND = 'dsh-chat-reader'
    const COMMAND = 'read'

    const PAGE = 80 // paragraphs per fetch
    const BEHIND_ON_OPEN = 20 // paragraphs loaded above the resume point (reachable by scrolling up)
    const LOAD_MARGIN_PX = 900 // fetch more when the viewport is this close to a loaded edge
    const MAX_ITEMS = 500 // loaded paragraphs before the far side is trimmed…
    const KEEP_ITEMS = 320 // …down to roughly this many
    const SAVE_DELAY_MS = 800

    const DEFAULT_CONFIG = Object.freeze({
      libraryRoot: '~/Books',
      fontSize: 0,
      lineHeight: 1.8,
      bossKey: 'Ctrl+Alt+KeyB',
    })

    /* ── shared state (survives hot replacement via a fixed global slot) ──── */

    const SLOT = '__dshChatReader__'
    const shared = (globalThis[SLOT] = globalThis[SLOT] || {
      boss: readFlag('dsh-chat-reader:boss'),
      config: Object.assign({}, DEFAULT_CONFIG),
      cards: 0,
      listeners: new Set(),
    })

    function readFlag(key) {
      try {
        return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1'
      } catch {
        return false
      }
    }

    function writeFlag(key, value) {
      try {
        if (typeof localStorage === 'undefined') return
        if (value) localStorage.setItem(key, '1')
        else localStorage.removeItem(key)
      } catch {
        // private mode / quota: keep the in-memory value only
      }
    }

    function emit() {
      for (const listener of Array.from(shared.listeners)) listener()
    }

    function subscribe(listener) {
      shared.listeners.add(listener)
      return () => shared.listeners.delete(listener)
    }

    function useShared(selector) {
      const read = () => selector(shared)
      return React.useSyncExternalStore(subscribe, read, read)
    }

    const selectBoss = (state) => state.boss
    const selectConfig = (state) => state.config

    function setBoss(value) {
      shared.boss = Boolean(value)
      writeFlag('dsh-chat-reader:boss', shared.boss)
      emit()
    }

    /* ── api ─────────────────────────────────────────────────────────────── */

    async function call(path, options) {
      const response = await fetch(API + path, options)
      const payload = await response.json().catch(() => null)
      if (!payload) throw new Error(`请求失败（HTTP ${response.status}）`)
      if (payload.ok !== true) throw new Error(payload.error || `请求失败（HTTP ${response.status}）`)
      return payload
    }

    function post(path, body) {
      return call(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    const enc = encodeURIComponent

    async function refreshConfig() {
      const payload = await call('/config')
      shared.config = payload.config
      emit()
      return payload.config
    }

    async function saveConfig(patch) {
      const payload = await post('/config', patch)
      shared.config = payload.config
      emit()
      return payload.config
    }

    function saveProgressNow(book, index) {
      return post('/progress', { book, index }).catch(() => {})
    }

    /** Last-chance save while the page is going away: a beacon survives unload. */
    function beaconProgress(book, index) {
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
          const body = new Blob([JSON.stringify({ book, index })], { type: 'application/json' })
          if (navigator.sendBeacon(`${API}/progress`, body)) return
        }
      } catch {
        // fall through to a normal request
      }
      void saveProgressNow(book, index)
    }

    /* ── keyboard chords (boss key) ──────────────────────────────────────── */

    /** `KeyboardEvent` → canonical chord, e.g. `Ctrl+Alt+KeyB`. Uses the physical `code`. */
    function chordOf(event) {
      const parts = []
      if (event.ctrlKey) parts.push('Ctrl')
      if (event.altKey) parts.push('Alt')
      if (event.shiftKey) parts.push('Shift')
      if (event.metaKey) parts.push('Meta')
      parts.push(event.code || '')
      return parts.join('+')
    }

    function isModifierCode(code) {
      return /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code || '')
    }

    /** Human label for a chord: `Ctrl+Alt+KeyB` → `Ctrl + Alt + B`. */
    function chordLabel(chord) {
      return String(chord || '')
        .split('+')
        .map((part) => part.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Backquote$/, '`'))
        .join(' + ')
    }

    /**
     * The one window-level listener this plugin owns. It only reacts to the
     * configured modifier chord, and only while a reader card exists (or the
     * reader is already hidden), so ordinary typing is never touched.
     */
    function onBossKey(event) {
      if (event.isComposing || event.keyCode === 229 || event.repeat || shared.capturing) return
      const chord = shared.config && shared.config.bossKey
      if (!chord || chordOf(event) !== chord) return
      if (shared.cards <= 0 && !shared.boss) return
      event.preventDefault()
      event.stopPropagation()
      setBoss(!shared.boss)
    }

    /* ── pure helpers (exported for tests) ───────────────────────────────── */

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value))
    }

    /** Index into `chapters` of the chapter containing paragraph `index`, or -1. */
    function chapterAt(chapters, index) {
      let low = 0
      let high = (chapters ? chapters.length : 0) - 1
      let found = -1
      while (low <= high) {
        const mid = (low + high) >> 1
        if (chapters[mid].index <= index) {
          found = mid
          low = mid + 1
        } else {
          high = mid - 1
        }
      }
      return found
    }

    /** Reading position (the paragraph at the top of the card) as a fraction of the book. */
    function fractionOf(index, total) {
      if (!total || total <= 1) return total === 1 ? 1 : 0
      return clamp(index / (total - 1), 0, 1)
    }

    /**
     * Index of the paragraph showing at `scrollTop`, given each rendered paragraph's
     * `offsetTop` in ascending order: the last one starting at or above the line.
     */
    function topParagraph(offsets, scrollTop) {
      let low = 0
      let high = offsets.length - 1
      let found = 0
      while (low <= high) {
        const mid = (low + high) >> 1
        if (offsets[mid] <= scrollTop) {
          found = mid
          low = mid + 1
        } else {
          high = mid - 1
        }
      }
      return found
    }

    const INITIAL = Object.freeze({ from: 0, items: [], total: 0 })

    /**
     * The loaded run of paragraphs: always contiguous, `[from, from + items.length)`.
     * Appends and prepends merge only when adjacent, so a jump starts a fresh run.
     */
    function reducer(state, action) {
      switch (action.type) {
        case 'loaded':
          return { from: action.from, items: action.items, total: action.total }
        case 'append':
          if (action.from !== state.from + state.items.length) return state
          return { from: state.from, items: state.items.concat(action.items), total: action.total }
        case 'prepend':
          if (action.from + action.items.length !== state.from) return state
          return { from: action.from, items: action.items.concat(state.items), total: state.total }
        case 'trimFront': {
          const count = clamp(action.count, 0, state.items.length)
          if (count === 0) return state
          return { from: state.from + count, items: state.items.slice(count), total: state.total }
        }
        case 'trimBack': {
          const count = clamp(action.count, 0, state.items.length)
          if (count === 0) return state
          return { from: state.from, items: state.items.slice(0, state.items.length - count), total: state.total }
        }
        default:
          return state
      }
    }

    /* ── styles ──────────────────────────────────────────────────────────── */

    const CSS = `
.dcrCard{position:relative;margin:2px 0;color:var(--dsw-alias-label-primary);font-size:var(--dcr-font,var(--dsh-content-font-size,15px));line-height:var(--dcr-lh,1.8);border-radius:10px;border:1px solid transparent;outline:none;transition:border-color .18s ease}
.dcrCard[data-state="reading"]{display:flex;flex-direction:column;overflow:hidden;contain:layout paint;height:max(180px, calc(var(--dsh-conversation-viewport-height,100dvh) - var(--dsh-composer-height,152px) - var(--dcr-gutter,44px)))}
.dcrCard[data-state="reading"]:hover{border-color:var(--dsw-alias-border-l1)}
.dcrCard:focus-visible{border-color:var(--dsw-alias-border-l2)}
.dcrLine{position:absolute;left:10px;right:10px;top:0;height:2px;z-index:3;pointer-events:none;border-radius:2px;overflow:hidden}
.dcrLine>i{display:block;height:100%;background:var(--dsw-alias-brand-primary);opacity:.5}
.dcrStream{position:relative;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overflow-anchor:none;overscroll-behavior:contain;padding:12px 6px 72px;word-break:break-word;scrollbar-width:thin;scrollbar-color:transparent transparent}
.dcrCard:hover .dcrStream{scrollbar-color:var(--dsh-scrollbar-thumb,var(--dsw-alias-border-l2)) transparent}
.dcrStream p{margin:0 0 .85em;white-space:pre-wrap}
.dcrStream p[data-heading="true"]{font-weight:600}
.dcrStream mark{background:var(--dsw-alias-bg-multi-select,rgba(255,200,0,.35));color:inherit;border-radius:2px}
.dcrStream p[data-hit="true"] mark{outline:1px solid var(--dsw-alias-brand-primary)}
.dcrChrome{position:absolute;left:0;right:0;z-index:2;display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);opacity:0;pointer-events:none;transition:opacity .16s ease,transform .16s ease}
.dcrHead{top:0;border-bottom:1px solid var(--dsw-alias-border-l1);border-radius:10px 10px 0 0;transform:translateY(-3px)}
.dcrBar{bottom:0;border-top:1px solid var(--dsw-alias-border-l1);border-radius:0 0 10px 10px;flex-wrap:wrap;transform:translateY(3px)}
.dcrCard:hover>.dcrChrome,.dcrCard[data-search="true"]>.dcrHead{opacity:1;pointer-events:auto;transform:none}
@media (hover:none){.dcrChrome{opacity:1;pointer-events:auto;transform:none}}
.dcrTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-weight:600}
.dcrMeta{white-space:nowrap;font-variant-numeric:tabular-nums}
.dcrTag{font-size:10px;padding:0 5px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);text-transform:uppercase}
.dcrBtn{padding:2px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dcrBtn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.dcrBtn:disabled{opacity:.4;cursor:default}
.dcrSelect{max-width:170px;padding:2px 6px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.dcrHint{flex:1;min-width:120px;text-align:right;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dcrSearch{position:absolute;top:36px;right:10px;z-index:4;display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:9px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));border:1px solid var(--dsw-alias-border-l2);box-shadow:0 6px 18px rgba(0,0,0,.22);font-size:12px;line-height:1.4}
.dcrSearch input{width:180px;padding:3px 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;outline:none}
.dcrSearch input:focus{border-color:var(--dsw-alias-brand-primary)}
.dcrSearchCount{min-width:44px;text-align:center;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dcrNote{color:var(--dsw-alias-label-secondary);padding:2px 6px}
.dcrError{color:var(--dsw-alias-state-error-primary,#e5484d);white-space:pre-wrap;padding:2px 6px;font-size:13px;line-height:1.7}
.dcrFold{display:block;padding:0 6px;color:var(--dsw-alias-label-tertiary);letter-spacing:3px;line-height:1.6;user-select:none;cursor:default;outline:none;border-radius:6px}
.dcrFold[data-closed="true"]{cursor:pointer;letter-spacing:normal;font-size:12.5px}
.dcrFold:focus-visible{box-shadow:0 0 0 1px var(--dsw-alias-border-l2)}
.dcrSet{display:flex;flex-direction:column;gap:18px;padding:4px 2px 24px;font-size:13px;color:var(--dsw-alias-label-primary)}
.dcrSetRow{display:grid;grid-template-columns:110px 1fr;gap:12px;align-items:center}
.dcrSetRow>label{color:var(--dsw-alias-label-secondary)}
.dcrSetCtl{display:flex;align-items:center;gap:8px;min-width:0}
.dcrSetCtl input[type="text"]{flex:1;min-width:0;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;outline:none}
.dcrSetCtl input[type="text"]:focus{border-color:var(--dsw-alias-brand-primary)}
.dcrSetCtl input[type="range"]{flex:1;accent-color:var(--dsw-alias-brand-primary)}
.dcrSetVal{min-width:64px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dcrSetMsg{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dcrSetMsg[data-error="true"]{color:var(--dsw-alias-state-error-primary,#e5484d)}
.dcrKeyBox{min-width:150px;padding:5px 10px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;text-align:left}
.dcrKeyBox[data-capturing="true"]{border-color:var(--dsw-alias-brand-primary);border-style:solid}
.dcrLib{border-top:1px solid var(--dsw-alias-border-l1);padding-top:14px}
.dcrLibRow{display:flex;align-items:center;gap:10px;padding:6px 4px;border-radius:7px}
.dcrLibRow:hover{background:var(--dsw-alias-bg-layer-2)}
.dcrLibName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcrLibPct{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:12px}
`

    function installStyles() {
      if (typeof document === 'undefined' || !document.head) return () => {}
      const element = document.createElement('style')
      element.dataset.plugin = KIND
      element.textContent = CSS
      document.head.append(element)
      return () => element.remove()
    }

    /* ── paragraph view ──────────────────────────────────────────────────── */

    function withMarks(text, query) {
      if (!query) return text
      const lower = text.toLowerCase()
      const needle = query.toLowerCase()
      const parts = []
      let at = 0
      let found = lower.indexOf(needle)
      while (found >= 0 && parts.length < 200) {
        if (found > at) parts.push(text.slice(at, found))
        parts.push(h('mark', { key: parts.length }, text.slice(found, found + needle.length)))
        at = found + needle.length
        found = lower.indexOf(needle, at)
      }
      if (at < text.length) parts.push(text.slice(at))
      return parts
    }

    const Paragraph = React.memo(function Paragraph({ index, text, heading, mark, hit }) {
      return h(
        'p',
        { 'data-i': String(index), 'data-heading': heading ? 'true' : undefined, 'data-hit': hit ? 'true' : undefined },
        withMarks(text, mark),
      )
    })

    /* ── the reader card ─────────────────────────────────────────────────── */

    function closedKey(nodeKey) {
      return `dsh-chat-reader:closed:${nodeKey}`
    }

    /**
     * One reader per `/read`. The loaded run of paragraphs is rendered whole; the card
     * opens with the saved paragraph at its top and the reader scrolls from there.
     * More paragraphs load as either loaded edge nears the viewport, and the far side
     * is trimmed so the DOM stays bounded. The paragraph at the top of the card is the
     * reading position that gets saved.
     */
    function ReaderCard({ node }) {
      const data = (node && node.data) || {}
      const nodeKey = node && node.key !== undefined ? String(node.key) : ''
      const summary = data.summary || null
      const bookId = summary ? summary.book : ''
      const ready = data.status === 'ready' && Boolean(bookId)

      const boss = useShared(selectBoss)
      const config = useShared(selectConfig)

      const [closed, setClosed] = React.useState(() => readFlag(closedKey(nodeKey)))
      const [meta, setMeta] = React.useState(null)
      const [notes, setNotes] = React.useState([])
      const [failure, setFailure] = React.useState('')
      const [search, setSearch] = React.useState(null)
      const [win, dispatch] = React.useReducer(reducer, INITIAL)
      const [index, setIndex] = React.useState(0)

      const streamRef = React.useRef(null)
      const lastStreamRef = React.useRef(null)
      const searchInputRef = React.useRef(null)
      const bodyRef = React.useRef(null)
      // The paragraph held at the top of the card until the reader scrolls by hand. Holding
      // a paragraph rather than a pixel offset survives the transcript's own layout settling
      // (width, fonts) after the card mounts.
      const pinRef = React.useRef(null)
      const anchorRef = React.useRef(null) // keep the view still across prepend / front trim
      const loadingRef = React.useRef(false)
      const dirtyRef = React.useRef(false) // the reader moved: progress may be saved
      const frameRef = React.useRef(0)
      const winRef = React.useRef(win)
      winRef.current = win
      const indexRef = React.useRef(index)
      indexRef.current = index

      // The boss key only acts while at least one reader is mounted.
      React.useEffect(() => {
        shared.cards += 1
        return () => {
          shared.cards -= 1
        }
      }, [])

      // Open the book at its saved paragraph.
      React.useEffect(() => {
        if (!ready) return undefined
        let cancelled = false
        void (async () => {
          try {
            const opened = await call(`/open?book=${enc(bookId)}`)
            const total = opened.book.paragraphCount
            const saved = opened.progress && opened.progress.index < total ? opened.progress.index : 0
            const page = await call(`/paragraphs?book=${enc(bookId)}&from=${Math.max(0, saved - BEHIND_ON_OPEN)}&count=${PAGE}`)
            if (cancelled) return
            pinRef.current = saved
            setMeta(opened.book)
            setNotes(opened.notes || [])
            setIndex(saved)
            dispatch({ type: 'loaded', from: page.from, items: page.items, total: page.total })
          } catch (error) {
            if (!cancelled) setFailure(error.message)
          }
        })()
        return () => {
          cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [ready, bookId])

      function paragraphElement(target) {
        const element = streamRef.current
        return element ? element.querySelector(`[data-i="${target}"]`) : null
      }

      function scrollToParagraph(target) {
        const element = streamRef.current
        const paragraph = paragraphElement(target)
        if (!element || !paragraph) return false
        element.scrollTop = Math.max(0, paragraph.offsetTop - 12)
        return true
      }

      // Scroll bookkeeping, inside the card only — never the transcript.
      React.useLayoutEffect(() => {
        const element = streamRef.current
        if (!element) {
          lastStreamRef.current = null
          return
        }
        // A remounted stream (after the boss key or reopening) starts at scrollTop 0:
        // hold the reading position at the top again.
        if (element !== lastStreamRef.current) {
          lastStreamRef.current = element
          if (pinRef.current === null) pinRef.current = indexRef.current
        }
        if (pinRef.current !== null) {
          scrollToParagraph(pinRef.current)
          anchorRef.current = null
          return
        }
        const anchor = anchorRef.current
        if (anchor) {
          anchorRef.current = null
          element.scrollTop = anchor.top + (element.scrollHeight - anchor.height)
        }
      })

      // Text reflows (card width, fonts) move paragraphs under a fixed scrollTop; while a
      // paragraph is held, put it back at the top whenever the content changes size.
      React.useEffect(() => {
        const body = bodyRef.current
        if (!body || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(() => {
          if (pinRef.current !== null) scrollToParagraph(pinRef.current)
        })
        observer.observe(body)
        return () => observer.disconnect()
      })

      /** The reader took the wheel: stop holding a paragraph, and start saving progress. */
      function release() {
        pinRef.current = null
        dirtyRef.current = true
      }

      function captureAnchor() {
        const element = streamRef.current
        if (element) anchorRef.current = { top: element.scrollTop, height: element.scrollHeight }
      }

      /** Track the top paragraph, extend the run near either edge, trim the far side. */
      function measure() {
        const element = streamRef.current
        const current = winRef.current
        if (!element || current.items.length === 0) return

        const paragraphs = element.querySelectorAll('[data-i]')
        if (paragraphs.length > 0) {
          const offsets = Array.prototype.map.call(paragraphs, (paragraph) => paragraph.offsetTop)
          const top =
            pinRef.current !== null
              ? pinRef.current
              : Number(paragraphs[topParagraph(offsets, element.scrollTop + 16)].getAttribute('data-i'))
          if (top !== indexRef.current) setIndex(top)
        }

        if (loadingRef.current) return
        const end = current.from + current.items.length
        const below = element.scrollHeight - element.scrollTop - element.clientHeight
        if (below < LOAD_MARGIN_PX && end < current.total) {
          loadingRef.current = true
          call(`/paragraphs?book=${enc(bookId)}&from=${end}&count=${PAGE}`)
            .then((page) => dispatch({ type: 'append', from: page.from, items: page.items, total: page.total }))
            .catch((error) => setFailure(error.message))
            .finally(() => {
              loadingRef.current = false
            })
          return
        }
        if (element.scrollTop < LOAD_MARGIN_PX && current.from > 0) {
          loadingRef.current = true
          const from = Math.max(0, current.from - PAGE)
          call(`/paragraphs?book=${enc(bookId)}&from=${from}&count=${current.from - from}`)
            .then((page) => {
              captureAnchor()
              dispatch({ type: 'prepend', from: page.from, items: page.items })
            })
            .catch(() => {})
            .finally(() => {
              loadingRef.current = false
            })
          return
        }
        if (current.items.length > MAX_ITEMS) {
          const above = indexRef.current - current.from
          const belowCount = end - indexRef.current
          if (above > belowCount) {
            captureAnchor()
            dispatch({ type: 'trimFront', count: Math.min(above - 40, current.items.length - KEEP_ITEMS) })
          } else {
            dispatch({ type: 'trimBack', count: Math.min(belowCount - 80, current.items.length - KEEP_ITEMS) })
          }
        }
      }

      function onScroll() {
        if (frameRef.current) return
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = 0
          measure()
        })
      }

      // A short window (or a fresh one) may not fill the card: check after each change.
      React.useEffect(() => {
        if (!meta || boss || closed) return
        measure()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [meta, win, boss, closed])

      React.useEffect(() => () => cancelAnimationFrame(frameRef.current), [])

      // Save the top paragraph (debounced) once the reader has moved.
      React.useEffect(() => {
        if (!meta || !dirtyRef.current) return undefined
        const timer = setTimeout(() => saveProgressNow(bookId, index), SAVE_DELAY_MS)
        return () => clearTimeout(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [meta, index])

      React.useEffect(() => {
        if (!meta) return undefined
        const flush = () => {
          if (dirtyRef.current) beaconProgress(bookId, indexRef.current)
        }
        window.addEventListener('pagehide', flush)
        return () => {
          window.removeEventListener('pagehide', flush)
          flush()
        }
      }, [meta, bookId])

      function lineHeightPx() {
        const element = streamRef.current
        if (!element || typeof window.getComputedStyle !== 'function') return 26
        const value = parseFloat(window.getComputedStyle(element).lineHeight)
        return Number.isFinite(value) && value > 0 ? value : 26
      }

      function scrollBy(delta) {
        const element = streamRef.current
        if (!element) return
        release()
        element.scrollTop += delta
      }

      function pageBy(direction) {
        const element = streamRef.current
        if (element) scrollBy(direction * Math.max(lineHeightPx(), element.clientHeight - 72 - lineHeightPx()))
      }

      async function jumpTo(target) {
        if (!meta) return
        const destination = clamp(target, 0, meta.paragraphCount - 1)
        dirtyRef.current = true
        pinRef.current = destination
        const current = winRef.current
        if (destination >= current.from && destination < current.from + current.items.length) {
          scrollToParagraph(destination)
          setIndex(destination)
          return
        }
        try {
          const page = await call(`/paragraphs?book=${enc(bookId)}&from=${Math.max(0, destination - BEHIND_ON_OPEN)}&count=${PAGE}`)
          setIndex(destination)
          dispatch({ type: 'loaded', from: page.from, items: page.items, total: page.total })
        } catch (error) {
          setFailure(error.message)
        }
      }

      function close() {
        writeFlag(closedKey(nodeKey), true)
        setSearch(null)
        setClosed(true)
      }

      function reopen() {
        writeFlag(closedKey(nodeKey), false)
        setClosed(false)
      }

      function openSearch() {
        setSearch((current) => current || { query: '', fetched: '', hits: [], at: -1, status: '' })
        setTimeout(() => {
          const input = searchInputRef.current
          if (input) {
            input.focus({ preventScroll: true })
            input.select()
          }
        }, 0)
      }

      function closeSearch(refocus) {
        setSearch(null)
        const card = streamRef.current && streamRef.current.parentElement
        if (refocus && card) card.focus({ preventScroll: true })
      }

      async function stepSearch(direction) {
        if (!search) return
        const query = search.query.trim()
        if (!query) return
        let hits = search.hits
        let at = search.at
        if (search.fetched !== query) {
          try {
            const result = await call(`/search?book=${enc(bookId)}&q=${enc(query)}&from=${indexRef.current}`)
            hits = result.hits
          } catch (error) {
            setSearch(Object.assign({}, search, { status: error.message }))
            return
          }
          at = hits.length > 0 ? (direction < 0 ? hits.length - 1 : 0) : -1
        } else if (hits.length > 0) {
          at = (at + direction + hits.length) % hits.length
        }
        setSearch(Object.assign({}, search, { fetched: query, hits, at, status: hits.length ? '' : '无结果' }))
        if (at >= 0) await jumpTo(hits[at].index)
      }

      async function addBookmark() {
        try {
          const payload = await post('/notes', { book: bookId, index })
          setNotes(payload.notes || [])
        } catch (error) {
          setFailure(error.message)
        }
      }

      /**
       * Keys belong to the card only while it has focus — nothing here is a window
       * listener, so the composer keeps every space and arrow it receives.
       */
      function onKeyDown(event) {
        const target = event.target
        const tag = target && target.tagName ? String(target.tagName).toLowerCase() : ''
        const inField = tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)
        const modified = event.altKey || event.ctrlKey || event.metaKey
        const key = event.key
        let handled = true

        if ((key === 'f' || key === 'F') && (event.ctrlKey || event.metaKey) && !event.altKey) {
          openSearch()
        } else if (key === 'Escape' && !modified && !event.shiftKey) {
          if (search) closeSearch(true)
          else close()
        } else if (modified || inField) {
          handled = false
        } else if (key === ' ' || key === 'Spacebar') {
          if (tag === 'button') handled = false
          else pageBy(event.shiftKey ? -1 : 1)
        } else if (event.shiftKey) {
          handled = false
        } else if (key === 'ArrowDown') {
          scrollBy(lineHeightPx())
        } else if (key === 'ArrowUp') {
          scrollBy(-lineHeightPx())
        } else if (key === 'ArrowRight' || key === 'PageDown') {
          pageBy(1)
        } else if (key === 'ArrowLeft' || key === 'PageUp') {
          pageBy(-1)
        } else {
          handled = false
        }
        if (handled) {
          event.preventDefault()
          event.stopPropagation()
        }
      }

      /* — render — */

      if (data.status === 'error') {
        return h('div', { className: 'dcrCard', 'data-state': 'error' }, h('div', { className: 'dcrError' }, `/read：${data.error || '打开失败'}`))
      }

      // Boss key: the whole card collapses to one inert line. The text is not hidden,
      // it is unmounted — nothing of the book remains in the DOM.
      if (boss) {
        return h('div', { className: 'dcrCard', 'data-state': 'boss' }, h('div', { className: 'dcrFold', 'aria-hidden': 'true' }, '···'))
      }

      if (closed) {
        return h(
          'div',
          { className: 'dcrCard', 'data-state': 'closed' },
          h(
            'div',
            {
              className: 'dcrFold',
              'data-closed': 'true',
              role: 'button',
              tabIndex: 0,
              title: '点击继续阅读',
              onClick: reopen,
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  reopen()
                }
              },
            },
            '··· 已合上，点击继续',
          ),
        )
      }

      if (failure && !meta) {
        return h('div', { className: 'dcrCard', 'data-state': 'error' }, h('div', { className: 'dcrError' }, failure))
      }

      if (!ready || !meta) {
        return h('div', { className: 'dcrCard', 'data-state': 'pending' }, h('p', { className: 'dcrNote' }, '…'))
      }

      const total = win.total || meta.paragraphCount
      const chapters = meta.chapters || []
      const chapterIndex = chapterAt(chapters, index)
      const chapterStarts = new Set(chapters.map((chapter) => chapter.index))
      const fraction = fractionOf(index, total)
      const mark = search && search.fetched ? search.fetched : ''
      const hitIndex = search && search.at >= 0 && search.hits[search.at] ? search.hits[search.at].index : -1

      const paragraphs = win.items.map((text, at) => {
        const absolute = win.from + at
        return h(Paragraph, {
          key: absolute,
          index: absolute,
          text,
          heading: chapterStarts.has(absolute),
          mark,
          hit: absolute === hitIndex,
        })
      })
      if (win.items.length > 0 && win.from + win.items.length >= total) {
        paragraphs.push(h('p', { key: 'end', className: 'dcrNote' }, '（全书完）'))
      }

      const style = { '--dcr-lh': String(config.lineHeight || 1.8) }
      if (config.fontSize > 0) style['--dcr-font'] = `${config.fontSize}px`

      return h(
        'div',
        {
          className: 'dcrCard',
          'data-state': 'reading',
          'data-search': search ? 'true' : 'false',
          tabIndex: 0,
          style,
          onKeyDown,
        },
        h('div', { className: 'dcrLine' }, h('i', { style: { width: `${(fraction * 100).toFixed(2)}%` } })),
        h(
          'div',
          {
            className: 'dcrStream',
            ref: streamRef,
            onScroll,
            // Any hand on the scroller (wheel, touch, scrollbar drag) releases the held paragraph.
            onWheel: release,
            onTouchStart: release,
            onPointerDown: release,
          },
          h('div', { ref: bodyRef }, paragraphs),
          failure ? h('p', { className: 'dcrError' }, failure) : null,
        ),
        h(
          'div',
          { className: 'dcrChrome dcrHead' },
          h('span', { className: 'dcrTitle', title: meta.title }, meta.title),
          chapterIndex >= 0 ? h('span', { className: 'dcrMeta' }, chapters[chapterIndex].title) : null,
          h('span', { className: 'dcrMeta' }, `${(fraction * 100).toFixed(1)}% · ${index + 1}/${total}`),
          h('span', { className: 'dcrTag', title: meta.encoding }, meta.format === 'epub' ? 'epub' : meta.encoding),
        ),
        h(
          'div',
          { className: 'dcrChrome dcrBar' },
          h(
            'button',
            {
              type: 'button',
              className: 'dcrBtn',
              disabled: chapterIndex < 0 || (chapterIndex === 0 && index === chapters[0].index),
              // Mid-chapter, "previous" first returns to this chapter's start.
              onClick: () => jumpTo(index > chapters[chapterIndex].index ? chapters[chapterIndex].index : chapters[chapterIndex - 1].index),
            },
            '上一章',
          ),
          h(
            'button',
            { type: 'button', className: 'dcrBtn', disabled: chapterIndex + 1 >= chapters.length, onClick: () => jumpTo(chapters[chapterIndex + 1].index) },
            '下一章',
          ),
          chapters.length > 0
            ? h(
                'select',
                {
                  className: 'dcrSelect',
                  value: String(chapterIndex),
                  'aria-label': '目录',
                  onChange: (event) => {
                    const next = Number(event.target.value)
                    if (next >= 0) jumpTo(chapters[next].index)
                  },
                },
                h('option', { value: '-1' }, '目录'),
                chapters.map((chapter, at) => h('option', { key: at, value: String(at) }, chapter.title)),
              )
            : null,
          h('button', { type: 'button', className: 'dcrBtn', onClick: addBookmark }, '书签'),
          notes.length > 0
            ? h(
                'select',
                {
                  className: 'dcrSelect',
                  value: '',
                  'aria-label': '书签',
                  onChange: (event) => {
                    if (event.target.value !== '') jumpTo(Number(event.target.value))
                  },
                },
                h('option', { value: '' }, `书签 ${notes.length}`),
                notes.map((note) => h('option', { key: note.id, value: String(note.index) }, `${note.index + 1} · ${note.text}`)),
              )
            : null,
          h('button', { type: 'button', className: 'dcrBtn', onClick: openSearch }, '搜索'),
          h('button', { type: 'button', className: 'dcrBtn', onClick: close }, '合上'),
          h(
            'span',
            { className: 'dcrHint' },
            `点卡片后：空格/→ 下一页 · ↑↓ 行 · Ctrl+F 搜索 · Esc 合上 · ${chordLabel(config.bossKey)} 老板键`,
          ),
        ),
        search
          ? h(
              'div',
              { className: 'dcrSearch' },
              h('input', {
                ref: searchInputRef,
                type: 'text',
                value: search.query,
                placeholder: '在本书中搜索',
                'data-dcr-search': 'input',
                onChange: (event) => setSearch(Object.assign({}, search, { query: event.target.value })),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.stopPropagation()
                    void stepSearch(event.shiftKey ? -1 : 1)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    closeSearch(true)
                  } else if ((event.key === 'f' || event.key === 'F') && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault()
                    event.stopPropagation()
                    event.target.select()
                  } else {
                    // Typing in the box is not a reader shortcut.
                    event.stopPropagation()
                  }
                },
              }),
              h(
                'span',
                { className: 'dcrSearchCount' },
                search.status || (search.hits.length > 0 ? `${search.at + 1}/${search.hits.length}` : ''),
              ),
              h('button', { type: 'button', className: 'dcrBtn', onClick: () => stepSearch(-1), title: '上一个 (Shift+Enter)' }, '↑'),
              h('button', { type: 'button', className: 'dcrBtn', onClick: () => stepSearch(1), title: '下一个 (Enter)' }, '↓'),
              h('button', { type: 'button', className: 'dcrBtn', onClick: () => closeSearch(true), title: '关闭 (Esc)' }, '✕'),
            )
          : null,
      )
    }

    /** The generic command row would show `/read` and its JSON result; the card replaces it. */
    function HiddenCommandRow() {
      return null
    }

    /* ── the chat node definition ────────────────────────────────────────── */

    /**
     * Fold `/read`'s durable lifecycle into one chat node.
     *
     * `command/run` (name === 'read') starts the context; the built-in command node for
     * the same run renders through the `read` commandview slot, which is empty. `command/done` carries no
     * name, so every one is offered as an update; the assembler only applies it to a
     * context whose start it has seen — i.e. ours.
     */
    const readerDefinition = {
      kind: KIND,
      target: 'chat',
      match(event) {
        if (!event || !event.data) return null
        if (event.type === 'command/run' && event.data.name === COMMAND) {
          // Not `exclusive`: the built-in command Definition must still see this run, so its
          // node carries name === 'read' and resolves to our empty commandview below. Claiming
          // the run leaves that Definition a done-only node with no name, which falls back to
          // the generic "Command {json}" card.
          return { id: String(event.data.commandId), role: 'start' }
        }
        if (event.type === 'command/done') {
          return { id: String(event.data.commandId), role: 'update' }
        }
        return null
      },
      start(context, match) {
        const event = match && match.event ? match.event : {}
        return { status: 'pending', summary: null, error: '', time: event.time === undefined ? null : event.time }
      },
      update(context, match) {
        const data = match.event.data || {}
        const time = context.state ? context.state.time : null
        if (data.kind !== 'success') {
          return { status: 'error', summary: null, error: String(data.text || '命令没有成功'), time }
        }
        try {
          const parsed = JSON.parse(String(data.text))
          if (!parsed || typeof parsed.book !== 'string' || !parsed.book) throw new Error('missing book')
          return {
            status: 'ready',
            summary: {
              book: parsed.book,
              title: String(parsed.title || ''),
              format: String(parsed.format || ''),
              paragraphCount: Number(parsed.paragraphCount) || 0,
            },
            error: '',
            time,
          }
        } catch {
          return { status: 'error', summary: null, error: '无法解析 /read 的返回值', time }
        }
      },
      buildViewNode(context) {
        if (context.start === undefined || !context.state) return null
        const state = context.state
        return {
          key: context.key,
          kind: KIND,
          id: context.id,
          target: 'chat',
          anchorSeq: context.start.event.seq,
          location: context.start.location,
          visibility: 'visible',
          data: { status: state.status, summary: state.summary, error: state.error, time: state.time },
        }
      },
    }

    /* ── settings section ────────────────────────────────────────────────── */

    function Settings() {
      const config = useShared(selectConfig)
      const [root, setRoot] = React.useState(config.libraryRoot)
      const [message, setMessage] = React.useState({ text: '', error: false })
      const [capturing, setCapturing] = React.useState(false)
      const [library, setLibrary] = React.useState(null)
      const typedRoot = React.useRef(false)

      function say(text, error) {
        setMessage({ text: text || '', error: Boolean(error) })
      }

      async function loadLibrary() {
        try {
          const payload = await call('/library')
          setLibrary(payload)
        } catch (error) {
          setLibrary({ error: error.message, books: [] })
        }
      }

      React.useEffect(() => {
        refreshConfig()
          .then((loaded) => {
            if (!typedRoot.current) setRoot(loaded.libraryRoot)
          })
          .catch((error) => say(error.message, true))
        void loadLibrary()
      }, [])

      async function persist(patch, okText) {
        try {
          await saveConfig(patch)
          say(okText || '已保存', false)
          return true
        } catch (error) {
          say(error.message, true)
          return false
        }
      }

      // Range inputs fire continuously; persist after the hand stops moving.
      const pending = React.useRef(null)
      function applySoon(patch) {
        shared.config = Object.assign({}, shared.config, patch)
        emit()
        clearTimeout(pending.current)
        pending.current = setTimeout(() => void persist(patch), 350)
      }

      React.useEffect(() => {
        if (!capturing) return undefined
        shared.capturing = true
        const onKey = (event) => {
          if (event.isComposing || event.keyCode === 229) return
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
            setCapturing(false)
            say('已取消', false)
            return
          }
          if (isModifierCode(event.code)) return
          const chord = chordOf(event)
          setCapturing(false)
          void persist({ bossKey: chord }, `老板键已设为 ${chordLabel(chord)}`)
        }
        window.addEventListener('keydown', onKey, true)
        return () => {
          shared.capturing = false
          window.removeEventListener('keydown', onKey, true)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [capturing])

      const row = (label, control) => h('div', { className: 'dcrSetRow' }, h('label', null, label), h('div', { className: 'dcrSetCtl' }, control))

      const fontOptions = [0, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 28]

      return h(
        'div',
        { className: 'dcrSet' },
        row(
          '书库根目录',
          h(
            React.Fragment,
            null,
            h('input', {
              type: 'text',
              value: root,
              spellCheck: false,
              placeholder: '~/Books',
              onChange: (event) => {
                typedRoot.current = true
                setRoot(event.target.value)
              },
              onKeyDown: (event) => {
                if (event.key === 'Enter') void persist({ libraryRoot: root }).then((ok) => ok && loadLibrary())
              },
            }),
            h('button', { type: 'button', className: 'dcrBtn', onClick: () => void persist({ libraryRoot: root }).then((ok) => ok && loadLibrary()) }, '保存'),
          ),
        ),
        row(
          '字号',
          h(
            'select',
            {
              className: 'dcrSelect',
              value: String(config.fontSize),
              onChange: (event) => void persist({ fontSize: Number(event.target.value) }),
            },
            fontOptions.map((size) => h('option', { key: size, value: String(size) }, size === 0 ? '跟随会话字号' : `${size} px`)),
          ),
        ),
        row(
          '行距',
          h(
            React.Fragment,
            null,
            h('input', {
              type: 'range',
              min: '1.2',
              max: '2.6',
              step: '0.1',
              value: String(config.lineHeight),
              onChange: (event) => applySoon({ lineHeight: Number(event.target.value) }),
            }),
            h('span', { className: 'dcrSetVal' }, Number(config.lineHeight).toFixed(1)),
          ),
        ),
        row(
          '老板键',
          h(
            React.Fragment,
            null,
            h(
              'button',
              {
                type: 'button',
                className: 'dcrKeyBox',
                'data-capturing': capturing ? 'true' : 'false',
                onClick: () => {
                  say('请按下新的组合键（需含 Ctrl / Alt / Meta 之一），Esc 取消', false)
                  setCapturing(true)
                },
              },
              capturing ? '请按组合键…' : chordLabel(config.bossKey),
            ),
            h('span', { className: 'dcrSetMsg' }, '按一次折叠为 ···（正文从页面移除），再按恢复'),
          ),
        ),
        message.text ? h('div', { className: 'dcrSetMsg', 'data-error': message.error ? 'true' : 'false' }, message.text) : null,
        h(
          'div',
          { className: 'dcrLib' },
          h(
            'div',
            { className: 'dcrSetMsg', 'data-error': library && library.error ? 'true' : 'false' },
            !library
              ? '正在读取书库…'
              : library.error
                ? library.error
                : `书库 ${library.root} · ${library.books.length} 本${library.truncated ? '（仅显示前若干本）' : ''} · 在会话里输入 /read 书名 打开`,
          ),
          library && library.books
            ? library.books.map((book) =>
                h(
                  'div',
                  { key: book.book, className: 'dcrLibRow', title: book.book },
                  h('span', { className: 'dcrLibName' }, book.book),
                  h(
                    'span',
                    { className: 'dcrLibPct' },
                    book.progress && book.progress.total
                      ? `${((book.progress.index / book.progress.total) * 100).toFixed(1)}%`
                      : '未读',
                  ),
                ),
              )
            : null,
        ),
      )
    }

    /* ── plugin ──────────────────────────────────────────────────────────── */

    const name = KIND
    const inject = ['slots', 'uiConversation']

    function apply(ctx) {
      ctx.effect(() => installStyles(), 'dsh-chat-reader: styles')

      // Config first, so the boss key and the card's font are right on first paint.
      ctx.effect(() => {
        refreshConfig().catch(() => {})
        return () => {}
      }, 'dsh-chat-reader: config')

      ctx.effect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
        window.addEventListener('keydown', onBossKey, true)
        return () => window.removeEventListener('keydown', onBossKey, true)
      }, 'dsh-chat-reader: boss key')

      ctx.effect(() => ctx.uiConversation.events.register(readerDefinition), 'dsh-chat-reader: chat node')

      ctx.slots.inject('conversation.chat.node', () =>
        ctx.slots.register({ name: 'conversation.chat.node', key: KIND }, ReaderCard),
      )
      ctx.slots.inject('conversation.chat.commandview', () =>
        ctx.slots.register({ name: 'conversation.chat.commandview', key: COMMAND }, HiddenCommandRow),
      )
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({ name: 'settings.section', id: KIND, order: 22, label: '阅读' }, Settings),
      )
    }

    // Extra keys are for the test suite; the loader reads name / inject / apply.
    module.exports = {
      name,
      inject,
      apply,
      readerDefinition,
      reducer,
      INITIAL,
      chapterAt,
      chordOf,
      chordLabel,
      fractionOf,
      topParagraph,
      onBossKey,
      shared,
      setBoss,
    }
    return module.exports
  },
})
