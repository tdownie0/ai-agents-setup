import { useEffect, useState } from 'react'
import { hc } from 'hono/client'
import type { AppType } from '../../server/src/index'

const client = hc<AppType>('http://localhost:3000/')

function App() {
  const [users, setUsers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const res = await client.api.users.$get()
        if (res.ok) {
          const data = await res.json()
          setUsers(data)
        }
      } catch (error) {
        console.error('Failed to fetch users:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchUsers()
  }, [])

  if (loading) return <div>Loading users...</div>

  return (
    <div style={{ padding: '20px' }}>
      <h1>Users</h1>
      {users.length === 0 ? (
        <p>No users found.</p>
      ) : (
        <ul>
          {users.map((user) => (
            <li key={user.id}>
              {user.fullName} ({user.email})
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default App
