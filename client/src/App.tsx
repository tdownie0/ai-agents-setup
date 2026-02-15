import { UserTable } from './components/UserTable'

function App() {
  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-3xl font-bold tracking-tight mb-8">Users</h1>
        <div className="rounded-lg border bg-card">
          <UserTable />
        </div>
      </div>
    </div>
  )
}

export default App
