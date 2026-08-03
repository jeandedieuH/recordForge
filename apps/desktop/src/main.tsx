import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
// Vendored Inter Variable so the app renders identically offline.
import "@fontsource-variable/inter"
import "./styles/index.css"

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
