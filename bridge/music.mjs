/**
 * Yandex Music, as the model sees it: three tools over yandexMusic.mjs.
 *
 * The plain commands ("пауза", "следующий трек", "включи Мне нравится") never
 * reach the model — the page recognises them and calls the bridge's /music
 * route directly. These tools are for everything looser: "поставь что-нибудь из
 * Цоя", "а кто это поёт?", a request that needs a question back before
 * anything is played.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { musicAction } from './yandexMusic.mjs'

/** What a result means, in words the model can repeat without inventing. */
export function describeResult(r) {
  const track = r.title ? `«${r.title}»${r.artist ? ` — ${r.artist}` : ''}` : ''
  const where = r.source ? ` (reported by ${r.source}, not the Yandex Music app)` : ''
  switch (r.code) {
    case 'ok': {
      const parts = []
      if (r.playlist) parts.push(`The user's playlist «${r.playlist}».`)
      else if (r.found) parts.push(`Found: «${r.found.title}»${r.found.artist ? ` — ${r.found.artist}` : ''}.`)
      parts.push(
        r.playing
          ? `Now playing ${track || '— the player gives no title'}${where}.`
          : track
            ? `Paused on ${track}${where}.`
            : `Paused${where}.`,
      )
      if (typeof r.volume === 'number') parts.push(`Volume ${r.volume}%.`)
      return parts.join(' ')
    }
    case 'unconfirmed':
      return `The command was sent but the player did not change — do NOT say it worked.${track ? ` Player shows ${track}, ${r.playing ? 'playing' : 'paused'}.` : ''}`
    case 'not-installed':
      return 'Yandex Music is not installed on this computer.'
    case 'not-running':
      return 'Yandex Music is not running, and Windows sees no other player. It can be started by asking to play or open it.'
    case 'no-control':
      return 'Yandex Music was opened by hand, without the control port: search, playlists and volume are unavailable until it is restarted (action "restart"), which closes and reopens it.'
    case 'nothing-playing':
      return 'Nothing is loaded in the player.'
    case 'idle':
      return 'Yandex Music is open, but Windows sees no playback in it.'
    case 'unknown':
      return `It could not be determined what is playing${r.message ? ` (${r.message})` : ''}. Say so; do not guess.`
    case 'empty':
      return `The user's playlist «${r.playlist}» is empty — nothing to play.`
    case 'ambiguous':
      return `Several of the user's playlists match: ${(r.options ?? []).join(', ')}. Ask which one.`
    case 'not-found':
      return r.playlists
        ? `The user has no playlist by that name. Their playlists: ${r.playlists.join(', ') || 'none'}.`
        : 'The search found nothing.'
    default:
      return `Failed: ${r.message ?? 'Yandex Music did not respond'}.`
  }
}

const QUIET = new Set(['ok', 'not-found', 'nothing-playing', 'idle', 'ambiguous', 'empty'])
const reply = (r) => ({ ...(QUIET.has(r.code) ? {} : { isError: true }), content: [{ type: 'text', text: describeResult(r) }] })

export function musicServer(ym) {
  return createSdkMcpServer({
    name: 'jarvis_music',
    version: '1.0.0',
    instructions:
      "Control the user's Yandex Music desktop app: play, pause, next/previous track, volume, what is playing, " +
      "the user's own playlists (including «Мне нравится», their liked tracks), and search for a song, artist or album. " +
      'Every result reports what the player actually did.',
    alwaysLoad: true,
    tools: [
      tool(
        'music_control',
        'Control Yandex Music playback. open: start the app. play: start or resume. pause: pause (also for "turn the music off"). ' +
          'next / prev: change track. now: what is playing (any player Windows sees, including a browser tab). ' +
          'restart: close and reopen the app so search, playlists and volume work (only when asked). ' +
          'volume: change it — delta +1 or -1 is one 10% step, or set 0–100.',
        {
          action: z.enum(['open', 'play', 'pause', 'next', 'prev', 'now', 'restart', 'volume']),
          delta: z.number().int().min(-1).max(1).optional(),
          set: z.number().int().min(0).max(100).optional(),
        },
        async (args) => reply(await musicAction(ym, args)),
      ),
      tool(
        'music_playlist',
        "Play one of the USER'S OWN playlists from their collection. liked: true for «Мне нравится» (their liked tracks — " +
          '"мои любимые", "избранное", "лайки"). Otherwise name: the playlist name as said. Never use music_search for the ' +
          "user's own playlists — it finds public ones. If several match, the result lists them: ask which.",
        {
          liked: z.boolean().optional(),
          name: z.string().max(100).optional(),
          play: z.boolean().optional(),
        },
        async ({ liked, name, play }) => reply(await musicAction(ym, { action: 'playlist', liked: liked === true, name: name ?? '', play: play ?? true })),
      ),
      tool(
        'music_search',
        'Search all of Yandex Music and, unless play is false, play the first result of the given kind. ' +
          'For songs, artists and albums — not for the user\'s own playlists (music_playlist). ' +
          'If the request is ambiguous (which song? which artist?), ask the user first instead of guessing.',
        {
          query: z.string().min(1).max(200),
          kind: z.enum(['track', 'album', 'artist', 'playlist', 'any']).optional(),
          play: z.boolean().optional(),
        },
        async ({ query, kind, play }) => reply(await musicAction(ym, { action: 'search', query, kind: kind ?? 'any', play: play ?? true })),
      ),
    ],
  })
}
