import { UserTable } from './components/UserTable'
import { NotificationBell } from './components/NotificationBell'

function App() {
  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold tracking-tight">Users</h1>
          <NotificationBell userId={1} />
        </div>
        <div className="rounded-lg border bg-card">
          <UserTable />
        </div>
      </div>
    </div>
  )
}

export default App
