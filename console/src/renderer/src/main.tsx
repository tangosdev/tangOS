import React from 'react'
import ReactDOM from 'react-dom/client'
import '@tangos/ui/aero.css'
import './app.css'
import App from './App'
import ModulePopout from './components/ModulePopout'

const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
const popoutModule = params.get('popout')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {popoutModule ? <ModulePopout module={popoutModule} /> : <App />}
  </React.StrictMode>
)
