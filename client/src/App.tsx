import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { UserTable } from './components/UserTable'
import { NotificationBell } from './components/NotificationBell'
import { Auth } from './components/Auth'
import { Button } from './components/ui/button'

function App() {
  const [session, setSession] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })

    return () => subscription.unsubscribe()
  }, [])

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center">Loading...</div>

  }

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-4xl">
        {!session ? (
          <div className="flex flex-col items-center justify-center pt-20">
            <Auth />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-8">
              <div>
                <h1 className="text-3xl font-bold tracking-tight">Users</h1>
                <p className="text-sm text-muted-foreground">{session.user.email}</p>
              </div>

              <div className="flex items-center gap-4">
                <NotificationBell userId={session.user.id} />
                <Button variant="ghost" onClick={() => supabase.auth.signOut()}>
                  Sign Out
                </Button>
              </div>
            </div>
            <div className="rounded-lg border bg-card">
              <UserTable />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default App
