import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installBrowserApiStub } from './browser-stub'

installBrowserApiStub()

// Tag the platform so CSS can leave room for the macOS traffic-light buttons
// in the (frameless) draggable header.
try {
  if (window.electron?.process?.platform === 'darwin') {
    document.body.classList.add('is-mac')
  }
} catch {
  // best-effort; non-Electron (browser stub) just skips the class
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
