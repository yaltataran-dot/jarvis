import { BRIDGE_HTTP_URL } from '../config'
import { trace } from './trace'
import { fetchKnown } from './knownFetch'

/** Ask the bridge whether the user has already told JARVIS the answer (bridge/knowledgeRoute.mjs). Read-only; never throws. */
export const knownAnswer = (said: string): Promise<string | null> =>
  fetchKnown(said, { url: `${BRIDGE_HTTP_URL}/knowledge/answer`, trace })
