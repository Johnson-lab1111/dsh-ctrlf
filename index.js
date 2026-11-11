/**
 * Host half of the in-conversation find bar.
 *
 * The capability lives entirely in the browser: the bar reads the transcript the
 * Client already rendered and paints matches through the CSS Custom Highlight
 * API. Nothing is persisted and no session event is written.
 *
 * What little is left here is one arrival counter, so an operator can tell
 * whether an already-open page executed a freshly installed bundle:
 *
 *   GET /api/dsh-ctrlf/loaded — one request per page load; the
 *       response carries only the arrival count and the last arrival time.
 *
 * It reports nothing about the environment, the process, or the caller, and the
 * route sits behind the connection service's owner-only admission, so a request
 * without the session cookie is rejected before this handler runs.
 */
const LOADED_PATH = '/api/dsh-ctrlf/loaded'
/** Kept bounded: this is a health signal, not a log. */
const MAX_PINGS = 32

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

export function apply(ctx, config) {
  const state = { loadedAt: Date.now(), pings: [] }

  ctx.effect(() => () => {
    if (globalThis.__DSH_CTRLF_HOST__ === state) delete globalThis.__DSH_CTRLF_HOST__
  }, 'dsh-ctrlf: load marker')
  globalThis.__DSH_CTRLF_HOST__ = state

  // A profile without the HTTP connection service keeps a working bar; only the
  // arrival counter disappears.
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: LOADED_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => {
        const at = Date.now()
        state.pings.push(at)
        if (state.pings.length > MAX_PINGS) state.pings.shift()
        return json({ ok: true, pings: state.pings.length, lastPingAt: at })
      },
    }), 'dsh-ctrlf: arrival counter')
  })
}