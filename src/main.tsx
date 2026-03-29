import { createRoot } from 'react-dom/client'
import loader from '@monaco-editor/loader'
import * as monaco from 'monaco-editor'
import { App } from './App'
import './index.css'

// Force Monaco to use the bundled local runtime instead of trying to
// lazily resolve editor assets in Electron.
loader.config({ monaco })

createRoot(document.getElementById('root')!).render(<App />)
