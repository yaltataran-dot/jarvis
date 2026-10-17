import { useEffect, useState } from 'react'
import { useThree } from '@react-three/fiber'
import { watchContext } from './contextWatch'
import { recordFault } from '../lib/faultLog'

/**
 * Mounted inside the <Canvas>. Renders nothing; keeps the WebGL context
 * recoverable and turns an unrecoverable loss into an error the scene boundary
 * can catch (an error thrown from a timer would never reach a boundary, so it
 * is carried through state and thrown during render).
 */
export function ContextGuard() {
  const canvas = useThree((s) => s.gl.domElement)
  const invalidate = useThree((s) => s.invalidate)
  const [fatal, setFatal] = useState<Error | null>(null)

  useEffect(
    () =>
      watchContext(canvas, {
        onLost: () => console.warn('[jarvis] WebGL context lost; waiting for restore'),
        onRestored: () => {
          console.info('[jarvis] WebGL context restored')
          invalidate()
        },
        onGiveUp: () => {
          const err = new Error('WebGL context was lost and not restored')
          recordFault('webgl', err)
          setFatal(err)
        },
      }),
    [canvas, invalidate],
  )

  if (fatal) throw fatal
  return null
}
