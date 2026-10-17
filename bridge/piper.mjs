/**
 * Local neural speech: Piper (https://github.com/rhasspy/piper, MIT).
 *
 * The keyless voice used to be the browser's own speechSynthesis, which on
 * Windows in Chrome means Microsoft Pavel or Irina — concatenative voices from
 * the Windows 8 era. Piper is a VITS model run with onnxruntime on the CPU: no
 * account, no key, no network, so it neither costs anything nor depends on the
 * VPN being up. A medium Russian voice generates a sentence in a few hundred
 * milliseconds on a 2017 laptop i5, which is less than the sentence ahead of it
 * takes to play — and the speaker primes exactly one sentence ahead.
 *
 * Install with scripts/windows/install-voice.ps1, or by hand:
 *
 *   <JARVIS_PIPER_DIR>/piper/piper(.exe)          the release binary
 *   <JARVIS_PIPER_DIR>/voices/<id>.onnx(.json)    one or more voices
 *
 * JARVIS_PIPER_DIR defaults to %LOCALAPPDATA%\JARVIS\piper on Windows and
 * ~/.local/share/jarvis/piper elsewhere — outside the repository, since the
 * voices are 60 MB each.
 *
 * One long-lived piper process per voice. Spawning one per sentence spends
 * well over a second loading the model every time; kept alive, it reads one
 * JSON line per request from stdin and prints the path of each finished WAV.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { withoutSecrets } from './secrets.mjs'

const DEFAULT_DIR =
  process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'JARVIS', 'piper')
    : join(homedir(), '.local', 'share', 'jarvis', 'piper')

export const PIPER_DIR = process.env.JARVIS_PIPER_DIR || DEFAULT_DIR
const EXE = join(PIPER_DIR, 'piper', process.platform === 'win32' ? 'piper.exe' : 'piper')
const VOICES_DIR = join(PIPER_DIR, 'voices')

/**
 * Delivery. length_scale is duration: above 1 is slower. Measured on Ruslan
 * (syllables per second of speech, four typical lines):
 *
 *   1.08 → 4.3   the old setting; slower than a newsreader, it dragged
 *   1.00 → 4.8   the model's own pace
 *   0.94 → ~5.1  chosen: everyday conversational Russian
 *   0.92 → 5.3
 *   0.88 → 5.3   the model stops getting faster here — it only clips sounds
 *
 * 0.94 sits a step back from where the model saturates, so it gains pace
 * without squeezing the vowels. noise_w is the variation in phoneme length;
 * nudged up from 0.8 it sounds less metronomic.
 */
const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : fallback)
const LENGTH_SCALE = num(process.env.JARVIS_PIPER_LENGTH_SCALE, 0.94)
const NOISE_SCALE = num(process.env.JARVIS_PIPER_NOISE_SCALE, 0.667)
const NOISE_W = num(process.env.JARVIS_PIPER_NOISE_W, 0.9)
/**
 * Seconds of quiet piper adds after each sentence, the last one included. The
 * speaker sends sentences one request at a time, so this is the pause between
 * them. Measured at 0.94: a comma pause inside a line is 130–170 ms; at 0.2
 * the gap between sentences came to ~210 ms, too close to a comma for the
 * sentence to be heard as ended. 0.22 gives ~235 ms — a breath, not a wait.
 */
const SENTENCE_SILENCE = num(process.env.JARVIS_PIPER_SENTENCE_SILENCE, 0.22)

/**
 * Delivery per style. 'normal' is every answer. 'announce' is the start-up
 * greeting, which should sound like something switching on rather than
 * something answering.
 *
 * Measured on the greeting, six renders each (piper's noise makes every render
 * a little different, so single renders prove nothing):
 *
 *   normal    0.94 / 0.667 / 0.9   pitch range p10–p90 6.9 ± 1.2 semitones, 117 Hz
 *   announce  0.90 / 0.8   / 1.0   pitch range p10–p90 9.1 ± 1.2 semitones, 121 Hz
 *
 * noise_scale is the variation the model is allowed in its prosody; 0.8 is
 * still well short of the 1.0+ where piper starts producing artefacts.
 * Piper takes these only on the command line — per-line JSON values are
 * ignored, which was checked — so the style is its own process.
 */
const STYLES = {
  normal: { lengthScale: LENGTH_SCALE, noiseScale: NOISE_SCALE, noiseW: NOISE_W, sentenceSilence: SENTENCE_SILENCE },
  announce: { lengthScale: 0.9, noiseScale: 0.8, noiseW: 1.0, sentenceSilence: 0.15 },
}

/** Anything unrecognised is an ordinary answer. */
export const piperStyle = (style) => (style === 'announce' ? 'announce' : 'normal')

/**
 * The announcer speaks once per power-up and its lines are then cached, so it
 * does not keep a second model in memory: it unloads after this long idle.
 */
const ANNOUNCE_IDLE_MS = 30_000

/**
 * Best-first, for the character: a calm male voice. RUSLAN is a 31-hour
 * single-speaker studio corpus, the largest of the Russian voices, and it
 * shows in the prosody. The rest follow so that whichever one is installed is
 * picked over a female voice.
 */
const PREFERRED = ['ru_RU-ruslan-medium', 'ru_RU-dmitri-medium', 'ru_RU-denis-medium', 'en_GB-alan-medium']

/** A request that has not produced audio in this long has wedged the process. */
const TIMEOUT_MS = 15_000

/** Voice ids installed for a language ('ru' → ru_RU-*, 'en' → en_*). */
export function piperVoices(lang) {
  if (!existsSync(EXE) || !existsSync(VOICES_DIR)) return []
  const prefix = lang === 'en' ? 'en_' : `${lang}_`
  let files = []
  try {
    files = readdirSync(VOICES_DIR)
  } catch {
    return []
  }
  return files
    .filter((f) => f.endsWith('.onnx') && f.startsWith(prefix) && files.includes(`${f}.json`))
    .map((f) => f.slice(0, -'.onnx'.length))
    .sort((a, b) => rank(a) - rank(b))
}

const rank = (id) => {
  const i = PREFERRED.indexOf(id)
  return i === -1 ? PREFERRED.length : i
}

/** The voice to use when the page has not asked for one. */
export function defaultPiperVoice(lang) {
  const voices = piperVoices(lang)
  const asked = process.env.JARVIS_PIPER_VOICE
  if (asked && voices.includes(asked)) return asked
  return voices[0] ?? null
}

let outDir = null
const outputDir = () => {
  if (!outDir) {
    outDir = mkdtempSync(join(tmpdir(), 'jarvis-piper-'))
    process.on('exit', () => {
      try {
        rmSync(outDir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    })
  }
  return outDir
}

/** One running piper process for one voice in one style. */
class Worker {
  constructor(voice, style = 'normal') {
    this.voice = voice
    this.style = style
    this.pending = new Map() // output path -> { resolve, reject, timer }
    this.seq = 0
    this.buffer = ''
    const s = STYLES[style]
    this.proc = spawn(
      EXE,
      [
        '--model', join(VOICES_DIR, `${voice}.onnx`),
        '--json-input',
        '--output_dir', outputDir(),
        '--length_scale', String(s.lengthScale),
        '--noise_scale', String(s.noiseScale),
        '--noise_w', String(s.noiseW),
        '--sentence_silence', String(s.sentenceSilence),
      ],
      // piper looks for espeak-ng-data and onnxruntime next to itself.
      { cwd: join(PIPER_DIR, 'piper'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: withoutSecrets(process.env) },
    )
    this.alive = true
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk) => this.onStdout(chunk))
    // piper logs every request at info level; only keep what says something.
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (/\[(error|critical)\]/i.test(line)) console.error(`[jarvis] piper: ${line.trim()}`)
      }
    })
    this.proc.on('error', (err) => this.die(err))
    this.proc.on('exit', (code) => this.die(new Error(`piper exited (${code})`)))
    this.proc.stdin.on('error', (err) => this.die(err))
  }

  onStdout(chunk) {
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const path = raw.trim()
      const job = this.pending.get(path)
      if (!job) continue
      this.pending.delete(path)
      clearTimeout(job.timer)
      readFile(path)
        .then((wav) => {
          job.resolve(wav)
          return unlink(path)
        })
        .catch((err) => job.reject(err))
    }
  }

  die(err) {
    if (!this.alive) return
    this.alive = false
    for (const job of this.pending.values()) {
      clearTimeout(job.timer)
      job.reject(err)
    }
    this.pending.clear()
    try {
      this.proc.kill()
    } catch {
      /* already gone */
    }
  }

  synth(text) {
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new Error('piper is not running'))
      const path = join(outputDir(), `${process.pid}-${this.voice}-${this.style}-${++this.seq}.wav`)
      const timer = setTimeout(() => {
        this.pending.delete(path)
        reject(new Error('piper timed out'))
        // A wedged process would time out every request after this one too.
        this.die(new Error('piper timed out'))
      }, TIMEOUT_MS)
      this.pending.set(path, { resolve, reject, timer })
      this.proc.stdin.write(`${JSON.stringify({ text, output_file: path })}\n`)
    })
  }
}

/**
 * One process per style, each holding one voice. Each holds its model in
 * memory, and switching voices with V is an audition, not something done
 * mid-sentence — so a voice change replaces the style's process.
 */
const workers = { normal: null, announce: null }
let announceIdle = null

function workerFor(voice, style = 'normal') {
  const current = workers[style]
  if (current?.alive && current.voice === voice) return current
  current?.die(new Error('voice changed'))
  workers[style] = new Worker(voice, style)
  return workers[style]
}

/** Unload the announcer once it has been quiet for a while. */
function scheduleAnnouncerUnload() {
  if (announceIdle) clearTimeout(announceIdle)
  announceIdle = setTimeout(() => {
    announceIdle = null
    workers.announce?.die(new Error('idle'))
    workers.announce = null
  }, ANNOUNCE_IDLE_MS)
  // Never the reason the bridge (or a test run) stays alive.
  announceIdle.unref?.()
}

/** Load the default voice now, so the first sentence does not pay for it. */
export function warmPiper(lang) {
  const voice = defaultPiperVoice(lang)
  if (voice) workerFor(voice)
  return voice
}

/**
 * Short lines repeat constantly — "Да, сэр?" on every wake, "Работаю, сэр."
 * on every tool call — and a repeat should cost nothing. Only short lines are
 * kept, so the cache stays a few megabytes however long the bridge runs.
 */
const CACHE_MAX_ENTRIES = 64
/**
 * 64, not 48: the start-up greeting's longest sentence is 51 characters, and
 * the boot animation is the busiest moment for the CPU — generated fresh, it
 * left a second's pause after "Здравствуйте!". Cached, every power-up after
 * the bridge's first is instant. 64 entries of a few seconds each stay under
 * about fifteen megabytes.
 */
const CACHE_MAX_CHARS = 64
const cache = new Map()

const synthesise = async (chosen, text, style) => {
  try {
    return await workerFor(chosen, style).synth(text)
  } catch (err) {
    if (workers[style]?.alive) throw err
    return workerFor(chosen, style).synth(text)
  } finally {
    if (style === 'announce') scheduleAnnouncerUnload()
  }
}

/**
 * Synthesise one line to a WAV buffer. Retries once on a dead process.
 * `style` is 'normal' (every answer) or 'announce' (the start-up greeting).
 */
export async function piperSpeak(text, lang, voice, style = 'normal') {
  const voices = piperVoices(lang)
  const chosen = voice && voices.includes(voice) ? voice : defaultPiperVoice(lang)
  if (!chosen) throw new Error('no piper voice installed')
  style = piperStyle(style)
  if (text.length > CACHE_MAX_CHARS) return synthesise(chosen, text, style)

  const key = `${chosen}\n${style}\n${text}`
  const hit = cache.get(key)
  if (hit) {
    // Re-insert, so the map's order is least recently used first.
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const wav = await synthesise(chosen, text, style)
  cache.set(key, wav)
  if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value)
  return wav
}

/** Unload every voice. The bridge never needs this; the tests do, to exit. */
export function stopPiper() {
  if (announceIdle) clearTimeout(announceIdle)
  announceIdle = null
  for (const style of Object.keys(workers)) {
    workers[style]?.die(new Error('stopped'))
    workers[style] = null
  }
}

process.on('exit', stopPiper)
