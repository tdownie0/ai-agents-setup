import { useEffect, useState } from 'react'
import { hc } from 'hono/client'
import type { AppType } from '../../../server/src/index'
import type { User } from '../types/user'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const client = hc<AppType>('http://localhost:3000/')

interface UserTableProps {
  caption?: string
}

export function UserTable({ caption = 'A list of all users in the system.' }: UserTableProps) {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        setLoading(true)
        setError(null)
        
        const res = await client.api.users.$get()
        
        if (!res.ok) {
          throw new Error(`Failed to fetch users: ${res.status} ${res.statusText}`)
        }
        
        const data = await res.json()
        setUsers(data)
      } catch (err) {
        console.error('Failed to fetch users:', err)
        setError(err instanceof Error ? err.message : 'An unknown error occurred')
      } finally {
        setLoading(false)
      }
    }

    fetchUsers()
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-muted-foreground">Loading users...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
        <div className="text-destructive font-medium">Error loading users</div>
        <div className="text-destructive/80 text-sm mt-1">{error}</div>
      </div>
    )
  }

  if (users.length === 0) {
    return (
      <div className="text-center p-8 text-muted-foreground">
        No users found.
      </div>
    )
  }

  return (
    <Table>
      <TableCaption>{caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[100px]">ID</TableHead>
          <TableHead>Full Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead className="text-right">Created At</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((user) => (
          <TableRow key={user.id}>
            <TableCell className="font-medium">{user.id}</TableCell>
            <TableCell>{user.fullName}</TableCell>
            <TableCell>{user.email}</TableCell>
            <TableCell className="text-right">
              {new Date(user.createdAt).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
