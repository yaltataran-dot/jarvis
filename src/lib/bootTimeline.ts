/**
 * The start-up, as one continuous scene (ui/Boot.tsx), from the energy ring to
 * the working screen — the one place its timing and its intensities are set.
 *
 * The splash, drawn after Downloads\Неоновое кольцо ЮГ-ТРАНСФЕР.png, is the
 * first thing on screen when the page opens, and it is whole from its first
 * frame: the ring lit and turning, the streams of energy out to either side
 * and moving, sparks already in the air. Nothing waits to appear.
 *
 * The click (or clap): the ring brightens a little and the streams start
 * drawing in, never stopping (ENGAGE).
 *
 * The greeting screen, Boot proper, follows once the start has been seen for
 * a moment and the bridge has said which voice it speaks with (App.tsx's
 * ignite): the glow softens and the streams calm, and he greets, once, when
 * that handover has played (HANDOVER_MS).
 *
 * Then the working screen (EXIT): the rings open out to the size of the
 * assistant's own ring and fade into it, the logo settles into its place in
 * the core, and the instruments come up round it (HUD_IN).
 */

/** After the start, the splash keeps the screen at least this long, so the
 *  answer to the click is seen before the handover. */
export const SPLASH_AFTER_START_MS = 1200

/** The handover, splash → greeting screen: glow down, streams calmer. The
 *  greeting is spoken once it has played. */
export const HANDOVER_MS = 1200

/** How long the greeting screen holds, from the start of the handover, before
 *  the working screen (if the start-up itself is done by then). */
export const GREET_SCREEN_MS = 6200

/** The way out to the working screen: the logo settles into the core's own
 *  over LOGO, the rings open out and dissolve over RINGS, and the layer fades
 *  over FADE after DELAY — never before the logo is in place, or two logos
 *  would show, one still moving. */
export const EXIT = { LOGO_MS: 650, RINGS_MS: 1100, DELAY_MS: 650, FADE_MS: 850 } as const

/** The working screen's instruments come up this long after the exit starts,
 *  over this long — as the layer fades, so its core's logo takes over from
 *  the settled one in the same place, and nothing shows through before. */
export const HUD_IN = { DELAY_MS: 650, FADE_MS: 1000 } as const

/** How hard each moment glows — EnergyField and the stylesheet both read it. */
export const ENERGY = {
  /** The click: how much brighter the ring burns, and how far the streams
   *  draw in (a fraction of their length). */
  engageBrightness: 1.1,
  engagePull: 0.25,
  /** The handover: how far in the streams draw at most — never all the way:
   *  they are always on screen — and the softer ring and calmer streams of
   *  the greeting screen. */
  greetPull: 0.5,
  greetBrightness: 0.94,
  calmStreams: 0.6,
} as const

/** Smooth 0→1 between a and b. */
export function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
