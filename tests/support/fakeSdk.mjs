/**
 * The Agent SDK as a bridge under test sees it: the real package, except
 * `query`, which opens no Claude Code process and asks no model. Each session
 * the bridge opens is numbered from 1 and reports to the test over IPC; the
 * test drives it with commands. See tests/sessionCore.test.mjs.
 *
 * Reported (process.send):
 *   { ev: 'query', session, resume, configDir, servers }   a session opened
 *   { ev: 'user', session, text }                          a question the bridge put in
 *   { ev: 'prompt-ended', session }                        its input generator finished
 *   { ev: 'interrupt', session } / { ev: 'close', session } / { ev: 'effort', session, level }
 *
 * Commands (process.on('message')):
 *   { cmd: 'emit', session, msg }        the session's stream yields `msg`
 *   { cmd: 'end', session }              its stream ends, as if Claude Code exited
 *   { cmd: 'fail', session, message }    its stream throws
 *   { cmd: 'next-init', fail?: string }  how the next session's initializationResult settles;
 *                                        acknowledged with { ev: 'next-init-set' }
 */
export * from '@anthropic-ai/claude-agent-sdk'

const report = (m) => process.send?.(m)
const sessions = new Map()
let opened = 0
let nextInit = null

process.on('message', (c) => {
  if (c?.cmd === 'next-init') {
    nextInit = c
    // Acknowledged, so a test can be sure it is set before the bridge opens that session.
    return report({ ev: 'next-init-set' })
  }
  const s = sessions.get(c?.session)
  if (!s) return report({ ev: 'no-such-session', session: c?.session, cmd: c?.cmd })
  if (c.cmd === 'emit') s.push(c.msg)
  else if (c.cmd === 'end') s.end()
  else if (c.cmd === 'fail') s.fail(new Error(c.message ?? 'stream failed'))
})

export function query({ prompt, options = {} }) {
  const id = ++opened
  const queue = []
  let waiter = null
  let ended = false
  let failure = null
  const settle = (fn) => {
    const w = waiter
    waiter = null
    if (w) fn(w)
  }
  const s = {
    push(msg) {
      if (ended) return
      if (waiter) settle((w) => w.resolve({ value: msg, done: false }))
      else queue.push(msg)
    },
    end() {
      ended = true
      settle((w) => w.resolve({ value: undefined, done: true }))
    },
    fail(err) {
      if (waiter) settle((w) => w.reject(err))
      else failure = err
    },
  }
  sessions.set(id, s)

  const init = nextInit
  nextInit = null
  const initialized = init?.fail ? Promise.reject(new Error(init.fail)) : Promise.resolve({})
  initialized.catch(() => {})

  report({
    ev: 'query',
    session: id,
    resume: options.resume ?? null,
    configDir: options.env?.CLAUDE_CONFIG_DIR ?? null,
    servers: Object.keys(options.mcpServers ?? {}),
  })

  // The bridge's input generator, read as the SDK would: each question as it comes.
  void (async () => {
    try {
      for await (const m of prompt) {
        const content = m?.message?.content
        report({ ev: 'user', session: id, text: typeof content === 'string' ? content : JSON.stringify(content) })
      }
      report({ ev: 'prompt-ended', session: id })
    } catch (err) {
      report({ ev: 'prompt-failed', session: id, message: String(err?.message ?? err) })
    }
  })()

  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (failure) {
            const f = failure
            failure = null
            return Promise.reject(f)
          }
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve, reject) => {
            waiter = { resolve, reject }
          })
        },
        return() {
          ended = true
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
    initializationResult: () => initialized,
    interrupt: async () => report({ ev: 'interrupt', session: id }),
    close: () => {
      report({ ev: 'close', session: id })
      s.end()
    },
    applyFlagSettings: async (settings) => report({ ev: 'effort', session: id, level: settings?.effortLevel ?? null }),
  }
}
