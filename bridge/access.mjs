/**
 * The Origin and Host checks — who may talk to this bridge, over HTTP and on
 * the sockets. Moved out of server.mjs unchanged, as one function of the
 * environment so the rules can be tested on their own: server.mjs calls it
 * once at start-up with process.env, and uses what it returns exactly where it
 * used these before — before any HTTP route, and in the WebSocket handshake.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function createAccess(env = process.env) {
  /**
   * Who is allowed to talk to this bridge.
   *
   * A WebSocket handshake is not subject to the same-origin policy: the browser
   * sends it on behalf of whatever page asked, no preflight stands in the way,
   * and the page reads every byte that comes back. Without a check here, any tab
   * the user happens to have open could open a socket to ws://localhost:8787,
   * drive the agent with every MCP server on this machine, and read back every
   * token and panel. The Origin header is the only thing that separates our own
   * dev server from someone else's page, so it is checked explicitly.
   *
   * A missing Origin means a non-browser client — curl, a script, a native app.
   * That is also exactly what local malware looks like, so it is refused on the
   * socket unless JARVIS_ALLOW_NO_ORIGIN=1 says otherwise.
   */
  const EXTRA_ORIGINS = new Set(
    (env.JARVIS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  )
  const ALLOW_NO_ORIGIN = env.JARVIS_ALLOW_NO_ORIGIN === '1'

  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

  /**
   * Vite takes the next free port when 5173 is busy and `vite preview` starts at
   * 4173, so the dev ranges are allowed rather than two exact numbers. Anything
   * else — including localhost on a port some other app is serving — has to be
   * named in JARVIS_ALLOWED_ORIGINS.
   */
  const isDevPort = (port) =>
    (port >= 5173 && port <= 5199) || (port >= 4173 && port <= 4199)

  function originAllowed(origin) {
    if (!origin) return ALLOW_NO_ORIGIN
    if (EXTRA_ORIGINS.has(origin.replace(/\/+$/, ''))) return true
    let url
    try {
      url = new URL(origin)
    } catch {
      return false
    }
    if (url.protocol !== 'http:') return false
    if (!LOCAL_HOSTS.has(url.hostname)) return false
    return isDevPort(Number(url.port))
  }

  /**
   * Which Host header the bridge answers to — the guard against DNS rebinding.
   *
   * Same-origin GETs carry no Origin, so a page on attacker.example whose name
   * is re-pointed at 127.0.0.1 would pass the origin check above and read /file,
   * /img and /page through the user's SSH tunnel. Its requests still name
   * attacker.example in Host, so only loopback names (any port — the tunnel may
   * remap it) and hosts listed in JARVIS_ALLOWED_ORIGINS / JARVIS_ALLOWED_HOSTS
   * are served.
   */
  const EXTRA_HOSTS = new Set(
    [
      ...[...EXTRA_ORIGINS].map((o) => {
        try {
          return new URL(o).hostname
        } catch {
          return ''
        }
      }),
      ...(env.JARVIS_ALLOWED_HOSTS ?? '').split(','),
    ]
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )

  function hostAllowed(host) {
    if (!host) return false
    let name
    try {
      name = new URL(`http://${host}`).hostname.toLowerCase()
    } catch {
      return false
    }
    return LOCAL_HOSTS.has(name) || EXTRA_HOSTS.has(name)
  }

  return { originAllowed, hostAllowed, extraOrigins: EXTRA_ORIGINS, allowNoOrigin: ALLOW_NO_ORIGIN }
}
