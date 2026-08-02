import { useState } from "react"
import { invoke } from "@tauri-apps/api/core"

// Root application shell for recordForge.
// Provides the main window chrome and a placeholder greeting to verify the Tauri + React + Tailwind setup.
function AppShell() {
  const [greetMsg, setGreetMsg] = useState("")
  const [name, setName] = useState("")

  async function greet() {
    setGreetMsg(await invoke("greet", { name }))
  }

  return (
    <main className="flex h-screen w-full flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight">recordForge</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Local-first screen recorder and lightweight editor
        </p>
      </div>

      <form
        className="flex w-full max-w-sm items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          greet()
        }}
      >
        <input
          className="flex-1 rounded-lg border border-border bg-muted px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Enter a name..."
          value={name}
        />
        <button
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          type="submit"
        >
          Greet
        </button>
      </form>

      {greetMsg ? (
        <p className="text-sm" data-testid="greet-message">
          {greetMsg}
        </p>
      ) : null}
    </main>
  )
}

export default AppShell
