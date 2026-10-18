/**
 * What the bridge asks the interface to show: a panel (a card beside the
 * reactor) or a blade (the big surface). The bridge builds these
 * (bridge/panels.mjs), the transport passes them on (src/lib/bridge.ts) and the
 * store holds them (src/store.ts). Types only: nothing here exists at run time.
 *
 * Moved here from src/store.ts so the transport no longer imports the UI store
 * for them (docs/ARCHITECTURE.md, "Debts"); src/store.ts re-exports them.
 */

/**
 * A card on the heads-up display.
 *
 * JARVIS authors the markup and picks the treatment — this is a delivery
 * envelope, not a template. The `html` is sanitised before it reaches the DOM.
 */
export type Panel = {
  id: string
  title: string
  html: string
  anim: 'materialise' | 'sweep' | 'unfold' | 'stagger' | 'snap'
  slot: 'right' | 'left' | 'wide'
  accent: 'default' | 'amber' | 'violet' | 'green' | 'red'
  hold: 'turn' | 'sticky'
}

/**
 * A blade — the big surface.
 *
 * A panel is a card you glance at while listening. A blade is the thing you
 * actually look at, and the difference is not decoration: an article you are
 * meant to READ needs a column of a certain width and a height you can scroll,
 * and no amount of styling makes that work inside a 320px card beside the
 * reactor. So blades own their own geometry, stack rather than replace each
 * other, and can be pulled forward or thrown full screen by the user.
 */
export type Blade = {
  id: string
  title: string
  kind: 'article' | 'image' | 'gallery' | 'video' | 'embed' | 'markup' | 'camera'
  /** article / image / video / embed. */
  url?: string
  /** gallery. */
  images?: string[]
  /** markup — sanitised exactly as a panel body is. */
  html?: string
  /** article only: the words restyled, or the real page. */
  mode?: 'reader' | 'live'
  size: 'compact' | 'tall' | 'wide' | 'full'
  hold: 'turn' | 'sticky'
}
