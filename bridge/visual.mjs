/**
 * Whether the user asked to SEE something this turn.
 *
 * A composed panel (`display`, or a `blade` of kind markup) goes up only when
 * they did. Measured on "Глянь погоду в Москве": every run searched, spoke, and
 * then composed a weather card nobody asked for — the panel's markup is model
 * output, written after the spoken answer, and the turn was not over until it
 * was. The tool's own description told it to ("If you searched, show the
 * results"), against the system prompt's "a spoken answer they did not ask to
 * see needs no blade at all".
 *
 * Deliberately about the words, not the topic: "глянь погоду" is "look it up",
 * not "put it on screen"; "покажи погоду" is a request to see it. Pictures,
 * articles, video and the camera open as blades of their own kinds and are not
 * judged here — they are asked for by name ("открой камеру", "найди фото").
 */

const SEE = new RegExp(
  [
    // Russian: show, put on screen, display, a panel, draw, a table, a chart,
    // a diagram, a list on screen, visually.
    'покажи', 'показать', 'покажите', 'показывай', 'выведи', 'вывести', 'отобрази',
    'на экран', 'на экране', 'на панел', 'панель', 'нарисуй', 'таблиц', 'график',
    'диаграмм', 'схем', 'визуал', 'наглядно', 'дай посмотреть', 'хочу увидеть',
    'хочу посмотреть', 'посмотреть на',
    // English.
    'show', 'display', 'on screen', 'on the screen', 'panel', 'draw', 'table',
    'chart', 'graph', 'diagram', 'visuali[sz]e', 'let me see',
  ].join('|'),
  'iu',
)

/** True if the question asks for something to be shown. */
export function asksToSee(text) {
  return SEE.test(String(text ?? ''))
}

/** Handed back to the model when it tries to show something nobody asked to see. */
export const NOT_ASKED_TO_SEE =
  'Not shown: the user did not ask to see anything this turn, so nothing goes on ' +
  'screen. Your spoken answer is the whole answer. Do not call display again ' +
  'this turn and do not mention it.'
