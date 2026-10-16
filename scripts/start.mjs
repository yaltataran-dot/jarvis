/**
 * One command to run JARVIS: the bridge (brain) and the Vite dev server (face)
 * together, so a student types `npm start` and nothing else.
 *
 * Two long-running processes normally mean two terminals. This launcher spawns
 * both as children, tags their output so you can tell them apart, and shuts
 * them down together on Ctrl-C — no extra dependency, just Node.
 *
 * Pass --writes to allow JARVIS to take real actions (drive the phone, the
 * browser, send things): `npm start -- --writes`. Pass --calendar-writes to
 * allow Google Calendar writes alone: `npm start -- --calendar-writes`.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { exitReason } from './exitReason.mjs'
import { bridgeEnvFor } from './bridgeEnv.mjs'

/**
 * Put MediaPipe's WebAssembly where the page can actually load it.
 *
 * Hand tracking needs a WASM runtime, and the usual recipe fetches it from a
 * CDN. That fails here twice over. The page's CSP names no CDN in `script-src`,
 * and the runtime arrives as a script — so it is blocked, and the failure
 * surfaces as gesture control simply never starting. And a CDN import is a live
 * supply-chain dependency: executable code, re-resolved on every load, that we
 * do not control and cannot pin against being changed under us.
 *
 * Copying it out of node_modules solves both. It is served from our own origin,
 * so `'self'` covers it; and it is the exact bytes of the version in the
 * lockfile. It stays out of git — 34 MB of build output does not belong in a
 * repository — and is re-copied whenever it is missing, which costs nothing
 * after the first run.
 */
function vendorWasm() {
  const from = 'node_modules/@mediapipe/tasks-vision/wasm'
  const to = 'public/mediapipe'
  if (!existsSync(from)) return // gesture control is optional; carry on without it
  if (existsSync(`${to}/vision_wasm_internal.wasm`)) return
  try {
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
    console.log('  vendored the hand-tracking runtime into public/mediapipe.')
  } catch (err) {
    console.warn(`  could not vendor the hand-tracking runtime: ${err.message}`)
  }
}

// A dim label per process, so the interleaved logs stay readable.
const paint = (tag, colour) => (line) =>
  line
    .toString()
    .split('\n')
    .filter((l) => l.length)
    .map((l) => `\x1b[${colour}m${tag}\x1b[0m ${l}`)
    .join('\n')

const children = []

function run(name, command, args, colour, env) {
  const label = paint(name, colour)
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    shell: false,
  })
  child.stdout.on('data', (d) => process.stdout.write(label(d) + '\n'))
  child.stderr.on('data', (d) => process.stderr.write(label(d) + '\n'))
  child.on('exit', (code, signal) => {
    // A Ctrl+C or a closed console reaches every process on it at once, so a
    // child can end a moment before this launcher hears the same signal.
    // Decide a moment later, so that is reported as the stop it is.
    setTimeout(() => {
      const why = exitReason(code, signal)
      const tag = `\x1b[${colour}m${name}\x1b[0m`
      // Vite ends with code 1 on Ctrl+C: during a stop that is the stop, not a fault.
      if (stopping) return console.log(why.stop ? `${tag} stopped: ${why.text}.` : `${tag} ended during the stop (code ${code}).`)
      // If either half dies the other is useless, so take the whole thing down
      // rather than leave a half-running app that looks alive but cannot answer.
      console.log(`${tag} ${why.stop ? 'was stopped' : 'exited'}: ${why.text}; stopping the rest.`)
      shutdown(why.stop ? 0 : (code ?? 1), `${name} ${why.stop ? 'was stopped' : 'failed'}`)
    }, 250)
  })
  children.push(child)
  return child
}

let stopping = false
function shutdown(code, reason) {
  if (stopping) return
  stopping = true
  console.log(`\nstopping JARVIS — ${reason}.`)
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 600)
}

// Ctrl+C, Ctrl+Break, the console window closing (SIGHUP on Windows), or a
// polite kill: each is a request to stop, and stops both halves together.
const STOPS = { SIGINT: 'Ctrl+C', SIGBREAK: 'Ctrl+Break', SIGHUP: 'the console window was closed', SIGTERM: 'asked to stop (SIGTERM)' }
for (const [sig, what] of Object.entries(STOPS)) {
  try {
    process.on(sig, () => shutdown(0, what))
  } catch {
    /* a signal this platform does not have */
  }
}
// However this process ends, it does not leave a bridge holding the port.
process.on('exit', () => {
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) {
      try {
        c.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }
})

/**
 * Tell the bridge which port the face will actually be on.
 *
 * The bridge only trusts WebSocket origins on localhost:5173-5199 and
 * 4173-4199, which is the right default — a socket that any local page can open
 * is a socket that drives every MCP server on the machine. But a launcher that
 * assigns a port outside that range produces the single most confusing failure
 * this project has: the interface loads, the reactor spins, the microphone
 * hears you, and the brain answers nothing, because the handshake is being 403'd
 * somewhere neither half reports. Passing the port through closes that gap
 * without widening what the bridge trusts by default.
 */
const port = process.env.PORT
const bridgeEnv = bridgeEnvFor(process.argv, process.env)
if (port) console.log(`  serving the face on port ${port}; the bridge will accept it.\n`)
if (bridgeEnv.JARVIS_CALENDAR_WRITES) {
  console.log('  calendar writes allowed for the bridge (--calendar-writes); each still needs its spoken word.\n')
}

vendorWasm()

console.log('\nJ.A.R.V.I.S. starting — the brain and the face.\n')
run('bridge', 'node', ['bridge/server.mjs'], '36', bridgeEnv)
// npm is a shell script on most systems; call the vite binary directly so we do
// not need shell:true (which would break the argument handling above).
run('face', process.execPath, ['node_modules/vite/bin/vite.js'], '35', {})

console.log(
  '\nWhen it says the dev server is ready, open the URL it prints in Chrome,\n' +
    'click INITIALISE, and say "Hey Jarvis". Ctrl-C stops everything.\n',
)
