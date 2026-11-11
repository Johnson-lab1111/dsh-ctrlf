window.__ModuleLoader__.load({
  id: 'dsh-ctrlf',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * In-conversation find bar.
     *
     * The transcript is ordinary DOM: one scrollport owned by the Conversation
     * plugin, filled with rendered Markdown. This plugin never rewrites that DOM
     * and never builds a text layer of its own — it reads the text nodes, makes
     * Ranges over them and paints matches through the CSS Custom Highlight API.
     * Highlight painting is decoration over the existing layout, so nothing
     * reflows, no node is wrapped in a <mark>, and the host's scroll anchoring
     * keeps working.
     *
     * Matching runs over a virtual concatenation of the visible text nodes, not
     * one node at a time, so a phrase that Markdown split across <strong> and a
     * plain run stays findable. Block boundaries insert a NUL sentinel no needle
     * can contain, so a match never straddles two paragraphs.
     */

    const NS = 'dsh-ctrlf'
    const SCROLL_SELECTOR = '[data-conversation-scroll]'
    const FALLBACK_SELECTORS = ['[data-slot="conversation.session"]', 'main', '#root']
    const ALL_HIGHLIGHT = 'dsh-find-all'
    const ACTIVE_HIGHLIGHT = 'dsh-find-active'
    const CASE_KEY = 'dsh.find.caseSensitive'
    const BOUNDARY = '\u0000'
    const RESCAN_DEBOUNCE_MS = 160
    const BLOCK_TAGS = new Set([
      'P', 'DIV', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD', 'TABLE', 'THEAD', 'TBODY',
      'TFOOT', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE',
      'BLOCKQUOTE', 'ARTICLE', 'SECTION', 'HEADER', 'FOOTER', 'FIGURE',
      'FIGCAPTION', 'DETAILS', 'SUMMARY', 'MAIN', 'ASIDE', 'NAV', 'FORM', 'HR',
    ])
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TEMPLATE'])

    // ── DOM reading ──────────────────────────────────────────────────────

    /** The visible transcript scrollport: the largest one on screen wins. */
    function activeScrollRoot() {
      if (typeof document === 'undefined') return null
      let best = null
      let bestArea = 0
      for (const el of document.querySelectorAll(SCROLL_SELECTOR)) {
        const rect = el.getBoundingClientRect()
        const area = rect.width * rect.height
        if (area > bestArea) {
          bestArea = area
          best = el
        }
      }
      if (best !== null) return best
      for (const selector of FALLBACK_SELECTORS) {
        const el = document.querySelector(selector)
        if (el !== null) return el
      }
      return null
    }

    /** Nearest block container; only decides where a match may not cross. */
    function blockOf(node) {
      let el = node.parentElement
      while (el !== null) {
        if (BLOCK_TAGS.has(el.tagName)) return el
        el = el.parentElement
      }
      return null
    }

    function textAccepted(node) {
      const value = node.nodeValue
      if (value === null || value.length === 0) return false
      const parent = node.parentElement
      if (parent === null) return false
      if (SKIP_TAGS.has(parent.tagName)) return false
      if (parent.closest('[data-find-ignore]') !== null) return false
      return true
    }

    /** Flatten `root` into one searchable string plus the offset → text-node map. */
    function flatten(root) {
      const segments = []
      let text = ''
      let lastBlock = null
      let leading = true
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return textAccepted(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
        },
      })
      let node = walker.nextNode()
      while (node !== null) {
        const block = blockOf(node)
        if (!leading && block !== lastBlock) text += BOUNDARY
        leading = false
        lastBlock = block
        segments.push({ node, start: text.length })
        text += node.nodeValue
        node = walker.nextNode()
      }
      return { text, segments }
    }

    /** Segment holding string offset `pos`, clamped to that segment's end. */
    function locate(segments, pos) {
      let low = 0
      let high = segments.length - 1
      let found = -1
      while (low <= high) {
        const mid = (low + high) >> 1
        if (segments[mid].start <= pos) {
          found = mid
          low = mid + 1
        } else {
          high = mid - 1
        }
      }
      if (found < 0) return null
      const segment = segments[found]
      const length = segment.node.nodeValue.length
      return { segment, offset: Math.max(0, Math.min(pos - segment.start, length)) }
    }

    function rangeBetween(segments, from, to) {
      const start = locate(segments, from)
      const end = locate(segments, to)
      if (start === null || end === null) return null
      const range = document.createRange()
      try {
        range.setStart(start.segment.node, start.offset)
        range.setEnd(end.segment.node, end.offset)
      } catch (error) {
        return null
      }
      return range
    }

    /** Every match of `query` inside `root`, in document order. */
    function collectRanges(root, query, caseSensitive) {
      if (root === null || query.length === 0) return []
      const flat = flatten(root)
      const text = flat.text
      const segments = flat.segments
      if (segments.length === 0) return []
      let haystack = text
      let needle = query
      if (!caseSensitive) {
        const folded = text.toLowerCase()
        const foldedNeedle = query.toLowerCase()
        // Case folding can change length for a few code points; when it does,
        // compare literally instead of mis-indexing the result.
        if (folded.length === text.length && foldedNeedle.length === query.length) {
          haystack = folded
          needle = foldedNeedle
        }
      }
      const ranges = []
      let from = 0
      while (from <= haystack.length - needle.length) {
        const at = haystack.indexOf(needle, from)
        if (at < 0) break
        if (text.slice(at, at + needle.length).indexOf(BOUNDARY) >= 0) {
          from = at + 1
          continue
        }
        const range = rangeBetween(segments, at, at + needle.length)
        if (range !== null) ranges.push(range)
        from = at + needle.length
      }
      return ranges
    }

    // ── Highlight painting ───────────────────────────────────────────────

    function highlightsAvailable() {
      return typeof CSS !== 'undefined' && CSS !== null && CSS.highlights !== undefined && CSS.highlights !== null && typeof Highlight === 'function'
    }

    function clearHighlights() {
      if (!highlightsAvailable()) return
      CSS.highlights.delete(ALL_HIGHLIGHT)
      CSS.highlights.delete(ACTIVE_HIGHLIGHT)
    }

    function paintHighlights(ranges, activeIndex) {
      if (!highlightsAvailable()) return
      if (ranges.length === 0) {
        clearHighlights()
        return
      }
      const all = new Highlight()
      for (const range of ranges) all.add(range)
      CSS.highlights.set(ALL_HIGHLIGHT, all)
      const current = ranges[activeIndex]
      if (current === undefined) {
        CSS.highlights.delete(ACTIVE_HIGHLIGHT)
        return
      }
      const one = new Highlight()
      one.add(current)
      CSS.highlights.set(ACTIVE_HIGHLIGHT, one)
    }

    // ── Scrolling ────────────────────────────────────────────────────────

    /** Bring one match into view, keeping a third of the viewport above it. */
    function revealRange(range, root, behavior) {
      if (range === undefined || range === null || root === null) return
      const rect = range.getBoundingClientRect()
      const box = root.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        const el = range.startContainer.parentElement
        if (el !== null) el.scrollIntoView({ block: 'center', behavior: behavior })
        return
      }
      const delta = rect.top - box.top - box.height / 3
      if (Math.abs(delta) < 4) return
      const top = Math.max(0, root.scrollTop + delta)
      if (typeof root.scrollTo === 'function') root.scrollTo({ top: top, behavior: behavior })
      else root.scrollTop = top
    }

    // ── Store ────────────────────────────────────────────────────────────

    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set(next) {
          const merged = typeof next === 'function' ? next(state) : next
          if (merged === state) return
          state = merged
          for (const listener of [...listeners]) listener()
        },
      }
    }

    function readCasePreference() {
      try {
        return window.localStorage.getItem(CASE_KEY) === '1'
      } catch (error) {
        return false
      }
    }

    function writeCasePreference(value) {
      try {
        window.localStorage.setItem(CASE_KEY, value ? '1' : '0')
      } catch (error) {
        // Storage may be unavailable; the toggle still holds for this page.
      }
    }

    // ── Styles ───────────────────────────────────────────────────────────

    const STYLE = `
.dsh-find {
  position: absolute;
  top: calc(var(--dsh-windows-titlebar-height, 0px) + 12px);
  right: 20px;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 6px 5px 10px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28));
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #ffffff));
  box-shadow: 0 10px 30px -12px rgba(0, 0, 0, 0.4), 0 2px 6px -2px rgba(0, 0, 0, 0.18);
  color: var(--dsw-alias-label-primary, currentColor);
  font-size: 13px;
  line-height: 1.4;
  pointer-events: auto;
}
.dsh-find__input {
  width: 190px;
  min-width: 0;
  padding: 3px 2px;
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
}
.dsh-find__input::placeholder {
  color: var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.9));
}
.dsh-find__count {
  min-width: 56px;
  text-align: right;
  color: var(--dsw-alias-label-secondary, currentColor);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dsh-find__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, currentColor);
  cursor: pointer;
}
.dsh-find__button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.16));
  color: var(--dsw-alias-label-primary, currentColor);
}
.dsh-find__button:disabled {
  opacity: 0.36;
  cursor: default;
}
.dsh-find__button[aria-pressed="true"] {
  background: var(--dsw-alias-button-ghost-active-fill, rgba(128, 128, 128, 0.2));
  color: var(--dsw-alias-label-primary, currentColor);
}
.dsh-find__sep {
  width: 1px;
  height: 16px;
  background: var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28));
  margin: 0 2px;
}
::highlight(dsh-find-all) {
  background-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #3d7dff) 30%, transparent);
  color: inherit;
}
::highlight(dsh-find-active) {
  background-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #3d7dff) 72%, transparent);
  color: var(--dsw-alias-label-primary-inverted, #ffffff);
}
`

    // ── Icons ────────────────────────────────────────────────────────────

    function chevron(up) {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }, h('path', { d: up ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4' }))
    }

    function cross() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round',
      }, h('path', { d: 'M4 4l8 8M12 4l-8 8' }))
    }

    // ── Dictionaries ─────────────────────────────────────────────────────

    const DICTIONARY = {
      zh: {
        placeholder: '在会话中查找',
        previous: '上一个匹配（Shift+Enter）',
        next: '下一个匹配（Enter）',
        close: '关闭查找（Esc）',
        caseSensitive: '区分大小写',
        empty: '无结果',
        range: '{index} / {total}',
        idle: '输入以查找',
      },
      en: {
        placeholder: 'Find in conversation',
        previous: 'Previous match (Shift+Enter)',
        next: 'Next match (Enter)',
        close: 'Close find (Esc)',
        caseSensitive: 'Match case',
        empty: 'No results',
        range: '{index} / {total}',
        idle: 'Type to search',
      },
      ja: {
        placeholder: '会話内を検索',
        previous: '前の一致（Shift+Enter）',
        next: '次の一致（Enter）',
        close: '検索を閉じる（Esc）',
        caseSensitive: '大文字と小文字を区別',
        empty: '一致なし',
        range: '{index} / {total}',
        idle: '入力して検索',
      },
      es: {
        placeholder: 'Buscar en la conversación',
        previous: 'Coincidencia anterior (Shift+Enter)',
        next: 'Siguiente coincidencia (Enter)',
        close: 'Cerrar búsqueda (Esc)',
        caseSensitive: 'Distinguir mayúsculas',
        empty: 'Sin resultados',
        range: '{index} / {total}',
        idle: 'Escribe para buscar',
      },
      fr: {
        placeholder: 'Rechercher dans la conversation',
        previous: 'Correspondance précédente (Maj+Entrée)',
        next: 'Correspondance suivante (Entrée)',
        close: 'Fermer la recherche (Échap)',
        caseSensitive: 'Respecter la casse',
        empty: 'Aucun résultat',
        range: '{index} / {total}',
        idle: 'Saisissez pour rechercher',
      },
      de: {
        placeholder: 'In der Unterhaltung suchen',
        previous: 'Vorheriger Treffer (Umschalt+Eingabe)',
        next: 'Nächster Treffer (Eingabe)',
        close: 'Suche schließen (Esc)',
        caseSensitive: 'Groß-/Kleinschreibung beachten',
        empty: 'Keine Treffer',
        range: '{index} / {total}',
        idle: 'Zum Suchen tippen',
      },
      ru: {
        placeholder: 'Поиск в диалоге',
        previous: 'Предыдущее совпадение (Shift+Enter)',
        next: 'Следующее совпадение (Enter)',
        close: 'Закрыть поиск (Esc)',
        caseSensitive: 'Учитывать регистр',
        empty: 'Нет совпадений',
        range: '{index} / {total}',
        idle: 'Введите запрос',
      },
      pt: {
        placeholder: 'Localizar na conversa',
        previous: 'Ocorrência anterior (Shift+Enter)',
        next: 'Próxima ocorrência (Enter)',
        close: 'Fechar localização (Esc)',
        caseSensitive: 'Diferenciar maiúsculas',
        empty: 'Sem resultados',
        range: '{index} / {total}',
        idle: 'Digite para localizar',
      },
    }

    // ── Plugin ───────────────────────────────────────────────────────────

    function apply(ctx) {
      const translate = (key) => ctx.locale.bind(NS)(key)

      ctx.effect(() => ctx.locale.register(NS, DICTIONARY), 'dsh-ctrlf: dictionaries')

      const store = createStore({
        open: false,
        query: '' ,
        count: 0,
        active: 0,
        caseSensitive: readCasePreference(),
        localeRevision: 0,
        restoreFocusTo: null,
      })

      ctx.effect(() => ctx.locale.subscribe(() => {
        store.set((state) => ({ ...state, localeRevision: state.localeRevision + 1 }))
      }), 'dsh-ctrlf: locale subscription')

      const rangesRef = { current: [] }
      const scanKeyRef = { current: '' }
      const queryKeyRef = { current: '' }

      function openFind() {
        const active = document.activeElement
        const restore = active instanceof HTMLElement && active !== document.body ? active : null
        store.set((state) => (state.open ? state : { ...state, open: true, restoreFocusTo: restore }))
      }

      function closeFind() {
        const state = store.get()
        if (!state.open) return
        clearHighlights()
        rangesRef.current = []
        scanKeyRef.current = ''
        store.set({ ...state, open: false, count: 0, active: 0 })
        const restore = state.restoreFocusTo
        if (restore !== null && restore.isConnected) restore.focus({ preventScroll: true })
      }

      function step(delta) {
        const state = store.get()
        if (!state.open || state.count === 0) return
        const next = (state.active + delta + state.count) % state.count
        store.set({ ...state, active: next })
      }

      function FindBar() {
        const state = React.useSyncExternalStore(store.subscribe, store.get)
        const inputRef = React.useRef(null)
        const [revision, setRevision] = React.useState(0)

        // Focus and select whenever the bar opens, and bind Enter/Escape on the
        // field itself. A native listener is used rather than the React
        // synthetic handler because the host's shortcut service listens on the
        // document at capture time; a React handler on a bubbling div never runs.
        React.useEffect(() => {
          if (!state.open) return undefined
          const input = inputRef.current
          if (input === null) return undefined
          input.focus({ preventScroll: true })
          input.select()
          const onKeyDown = (event) => {
            if (event.isComposing || event.keyCode === 229) return
            if (event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              step(event.shiftKey ? -1 : 1)
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              closeFind()
            }
          }
          input.addEventListener('keydown', onKeyDown)
          return () => input.removeEventListener('keydown', onKeyDown)
        }, [state.open])

        // Rescan when the query, the dictionary or the transcript changes.
        React.useEffect(() => {
          if (!state.open) {
            clearHighlights()
            rangesRef.current = []
            scanKeyRef.current = ''
            return
          }
          const root = activeScrollRoot()
          const key = state.query + BOUNDARY + String(state.caseSensitive) + BOUNDARY + String(revision) + BOUNDARY + String(state.localeRevision)
          if (key === scanKeyRef.current) return
          scanKeyRef.current = key
          rangesRef.current = root === null || state.query.length === 0
            ? []
            : collectRanges(root, state.query, state.caseSensitive)
          const count = rangesRef.current.length
          // A live transcript grows while the bar is open. A rescan because of
          // that growth must not throw the user back to match 1 — only a new
          // query (or a new case setting) resets the cursor.
          const queryKey = state.query + BOUNDARY + String(state.caseSensitive) + BOUNDARY + String(state.localeRevision)
          const queryChanged = queryKey !== queryKeyRef.current
          queryKeyRef.current = queryKey
          const active = queryChanged ? 0 : Math.max(0, Math.min(state.active, Math.max(0, count - 1)))
          if (count !== state.count || active !== state.active) {
            store.set((current) => ({ ...current, count: count, active: active }))
          }
        }, [state.open, state.query, state.caseSensitive, state.localeRevision, revision])

        // Paint every match and travel to the current one.
        React.useEffect(() => {
          const ranges = rangesRef.current
          if (!state.open) {
            clearHighlights()
            return
          }
          if (ranges.length === 0) {
            clearHighlights()
            return
          }
          const active = Math.max(0, Math.min(state.active, ranges.length - 1))
          paintHighlights(ranges, active)
          revealRange(ranges[active], activeScrollRoot(), 'smooth')
        }, [state.open, state.active, state.count, state.query, revision])

        // Follow transcript growth: new turns and streamed text stay scannable.
        React.useEffect(() => {
          if (!state.open) return undefined
          const root = activeScrollRoot()
          if (root === null) return undefined
          let timer = null
          const observer = new MutationObserver(() => {
            if (timer !== null) window.clearTimeout(timer)
            timer = window.setTimeout(() => {
              timer = null
              setRevision((value) => value + 1)
            }, RESCAN_DEBOUNCE_MS)
          })
          observer.observe(root, { childList: true, subtree: true, characterData: true })
          return () => {
            if (timer !== null) window.clearTimeout(timer)
            observer.disconnect()
          }
        }, [state.open])

        React.useEffect(() => () => {
          clearHighlights()
        }, [])

        if (!state.open) return null

        const total = state.count
        const index = total === 0 ? 0 : Math.min(state.active, total - 1) + 1
        const label = total === 0
          ? (state.query.length === 0 ? translate('idle') : translate('empty'))
          : translate('range').replace('{index}', String(index)).replace('{total}', String(total))

        const toggleCase = () => {
          const next = !store.get().caseSensitive
          writeCasePreference(next)
          store.set((current) => ({ ...current, caseSensitive: next }))
        }

        return h(React.Fragment, null,
          h('style', { 'data-dsh-find-style': '', dangerouslySetInnerHTML: { __html: STYLE } }),
          h('div', {
            className: 'dsh-find',
            role: 'search',
            'data-find-ignore': '',
            onKeyDown: (event) => {
              // A composing Enter commits the IME candidate; it is not a step.
              if (event.isComposing || event.keyCode === 229) return
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                closeFind()
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                step(event.shiftKey ? -1 : 1)
              }
            },
            onMouseDown: (event) => {
              // Keep the caret in the field when a control is clicked.
              if (event.target !== inputRef.current) event.preventDefault()
            },
          },
            h('input', {
              ref: inputRef,
              className: 'dsh-find__input',
              type: 'text',
              value: state.query,
              placeholder: translate('placeholder'),
              'aria-label': translate('placeholder'),
              spellCheck: false,
              autoComplete: 'off',
              onChange: (event) => {
                const query = event.target.value
                store.set((current) => ({ ...current, query: query, active: 0 }))
              },
            }),
            h('span', { className: 'dsh-find__count', 'aria-live': 'polite' }, label),
            h('span', { className: 'dsh-find__sep', 'aria-hidden': 'true' }),
            h('button', {
              type: 'button',
              className: 'dsh-find__button',
              title: translate('caseSensitive'),
              'aria-label': translate('caseSensitive'),
              'aria-pressed': state.caseSensitive ? 'true' : 'false',
              onClick: toggleCase,
            }, h('span', { style: { fontSize: 12, fontWeight: 600 } }, 'Aa')),
            h('button', {
              type: 'button',
              className: 'dsh-find__button',
              title: translate('previous'),
              'aria-label': translate('previous'),
              disabled: total === 0,
              onClick: () => step(-1),
            }, chevron(true)),
            h('button', {
              type: 'button',
              className: 'dsh-find__button',
              title: translate('next'),
              'aria-label': translate('next'),
              disabled: total === 0,
              onClick: () => step(1),
            }, chevron(false)),
            h('button', {
              type: 'button',
              className: 'dsh-find__button',
              title: translate('close'),
              'aria-label': translate('close'),
              onClick: closeFind,
            }, cross()),
          ),
        )
      }

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-ctrlf',
        order: 1000,
      }, FindBar))

      /**
       * Window-level bindings. The bar is a transient overlay and must open from
       * anywhere: the composer, a tool row, a code block. Pressing Ctrl+F inside
       * our own field re-opens and re-selects rather than nesting, and Escape
       * leaves only when focus is outside the bar so the bar keeps its own Esc.
       */
      function onKeyDown(event) {
        if (event.isComposing) return
        const modifier = event.ctrlKey || event.metaKey
        if (modifier && !event.altKey && !event.shiftKey && event.code === 'KeyF') {
          event.preventDefault()
          event.stopPropagation()
          openFind()
          return
        }
        if (event.code === 'F3' && store.get().open) {
          event.preventDefault()
          event.stopPropagation()
          step(event.shiftKey ? -1 : 1)
          return
        }
        if (event.code === 'Escape' && store.get().open) {
          const active = document.activeElement
          const inside = active instanceof HTMLElement && active.closest('.dsh-find') !== null
          if (inside) return
          event.preventDefault()
          closeFind()
        }
      }

      ctx.effect(() => {
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, 'dsh-ctrlf: window bindings')

      ctx.effect(() => () => clearHighlights(), 'dsh-ctrlf: highlight cleanup')

    }

    return {
      inject: ['slots', 'locale'],
      apply: apply,
    }
  },
})