import { BRIDGE_HTTP_URL } from '../config'
import type { MusicIntent, MusicResult } from './musicIntent'

/**
 * Carry out a music command through the bridge (bridge/yandexMusic.mjs).
 *
 * Never throws: a bridge that is down, slow or answering nonsense comes back as
 * code 'bridge', which he says out loud rather than going quiet. The ceiling is
 * generous because starting the app and loading search results is real work.
 */
export async function runMusic(intent: Exclude<MusicIntent, { action: 'clarify' }>): Promise<MusicResult> {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/music`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(intent),
      signal: AbortSignal.timeout(45_000),
    })
    if (!res.ok) return { code: 'bridge' }
    const r = (await res.json()) as MusicResult
    return r && typeof r.code === 'string' ? r : { code: 'bridge' }
  } catch {
    return { code: 'bridge' }
  }
}
