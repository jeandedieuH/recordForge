import { convexQuery, useConvexMutation } from "@convex-dev/react-query"
import { useMutation, useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Inbox } from "lucide-react"
import { api } from "../../convex/_generated/api"
import { Button, EmptyState } from "@recordforge/ui"

export const Route = createFileRoute("/")({
  component: Home,
})

function Home() {
  const { data } = useSuspenseQuery(convexQuery(api.tasks.get, {}))
  const seed = useMutation({
    mutationFn: useConvexMutation(api.tasks.seed),
  })

  if (data.length === 0) {
    return (
      <main className="container mx-auto py-8">
        <h1 className="text-2xl font-bold">recordForge web</h1>
        <div className="mt-8">
          <EmptyState
            icon={Inbox}
            title="No tasks yet"
            description="Get started by seeding the sample task list."
            action={
              <Button loading={seed.isPending} onClick={() => seed.mutate({})}>
                Seed sample tasks
              </Button>
            }
          />
        </div>
      </main>
    )
  }

  return (
    <main className="container mx-auto py-8">
      <h1 className="text-2xl font-bold">recordForge web</h1>
      <ul className="mt-4 space-y-2">
        {data.map((task) => (
          <li key={task._id} className="text-muted-foreground">
            {task.text}
          </li>
        ))}
      </ul>
    </main>
  )
}
