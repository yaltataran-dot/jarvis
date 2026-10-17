import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './ui/ErrorBoundary.tsx'
import { installFaultLog } from './lib/faultLog.ts'

installFaultLog()

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary scope="ui">
    <App />
  </ErrorBoundary>,
)
