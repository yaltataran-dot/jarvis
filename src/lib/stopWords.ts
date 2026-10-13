/**
 * The words that stop him, in one place.
 *
 * Two lists have to agree. OVERRIDE (used by voice.ts) decides what cuts
 * through his speech even when it collides with his own echo; STOP_ONLY (used
 * by App.tsx) decides what, once he has stopped, is NOT sent on to the model.
 * A word in the first and not the second stopped him and then came back as a
 * question — "подожди" got an answer about waiting. Kept free of imports so
 * the tests can check the two against each other.
 */

/** Unicode word boundaries — `\b` only knows ASCII, so it never fires next to Cyrillic. */
export const L = '(?<![\\p{L}\\p{N}_])'
export const R = '(?![\\p{L}\\p{N}_])'

/**
 * Short words that must always cut through, even when they collide with what
 * he happens to be saying. Suppressing "stop" because he just said "stop"
 * would be the single most infuriating failure the voice loop could have.
 */
export const OVERRIDE = new RegExp(
  `${L}(?:stop|wait|jarvis|cancel|enough|quiet|hold on|shut up|never ?mind|forget it|no|` +
    `стоп|хватит|подожди|погоди|постой|отмена|отмени|отбой|тихо|замолчи|молчи|достаточно|забудь|неважно|нет|джарвис)${R}`,
  'iu',
)

/**
 * A spoken stop with nothing else in it: "Стоп", "хватит, сэр", "stop please".
 * By the time it arrives as an utterance the barge-in has already cut him off,
 * so it has done its job — sent on to the model it became a question, and the
 * answer to it was the speech starting all over again. Fillers are allowed on
 * either side because the browser recogniser leaves one-word scraps of his own
 * voice ("сэр") in front of it.
 *
 * Every word OVERRIDE lets cut through belongs here too, except "нет" and his
 * name — those start real sentences ("нет, я про завтра").
 */
const STOP_WORD =
  '(?:stop|enough|cancel|quiet|shut up|wait|hold on|never ?mind|forget it|' +
  'стоп|хватит|отмена|отмени|тихо|замолчи|молчи|достаточно|подожди|погоди|постой|забудь|неважно|не важно|отбой)'
const STOP_FILLER = '(?:please|sir|ok|okay|пожалуйста|сэр|ну|эй|всё|все|ладно|окей)'
export const STOP_ONLY = new RegExp(
  `^(?:${STOP_FILLER}[\\s,.!?]+)*${STOP_WORD}(?:[\\s,.!?]+(?:${STOP_WORD}|${STOP_FILLER}))*[\\s,.!?]*$`,
  'iu',
)
