/**
 * The bridge's requests of the page, and the page's replies — moved out of
 * server.mjs unchanged. One registry per socket: server.mjs builds it with the
 * socket and its send, hands `ask` to the camera tool (vision.mjs), and
 * passes every `reply` frame to `reply`.
 */

/**
 * @param {{ socket: { readyState: number, OPEN: number }, send: (msg: object) => void }} o
 */
export function createPageRequests({ socket, send }) {
  /**
   * Asking the browser for something and waiting for the answer.
   *
   * Every other tool here pushes — a panel, a blade, a retint — and never needs
   * a reply. The camera is the exception: the hardware is over there and the
   * model is here, so a frame has to come back. Correlated by id because a turn
   * can have more than one request in flight, and timed out because a browser
   * that has been closed mid-question would otherwise hang the turn until the
   * two-minute idle timer noticed.
   */
  const waiting = new Map()
  let asks = 0

  const ask = (kind, args, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== socket.OPEN) {
        return reject(new Error('the interface is not connected'))
      }
      const id = `q${++asks}`
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error('the interface did not answer in time'))
      }, timeoutMs)
      waiting.set(id, { resolve, timer })
      send({ type: kind, id, ...args })
    })

  /** A `reply` frame: settles the request it names; one nobody is waiting on is dropped. */
  const reply = (msg) => {
    const slot = waiting.get(msg.id)
    if (slot) {
      waiting.delete(msg.id)
      clearTimeout(slot.timer)
      slot.resolve(msg)
    }
  }

  return { ask, reply }
}
