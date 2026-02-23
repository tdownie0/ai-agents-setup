import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { eq, desc } from 'drizzle-orm'
import { db } from './db/index.js'
import { users, notifications, notificationTypes, type NotificationType } from './db/schema.js'

const app = new Hono().basePath('/api')

app.use('*', cors())

const routes = app.get('/users', async (c) => {
  const allUsers = await db.select().from(users)
  return c.json(allUsers)
})

// Create notification
.post('/notifications', async (c) => {
  const body = await c.req.json()
  const { userId, type, title, message } = body

  // Validate type
  if (!Object.values(notificationTypes).includes(type as NotificationType)) {
    return c.json({ error: 'Invalid notification type' }, 400)
  }

  const [notification] = await db.insert(notifications).values({
    userId: Number(userId),
    type: type as NotificationType,
    title,
    message,
    read: false,
  }).returning()

  return c.json(notification, 201)
})

// List notifications for a user
.get('/notifications', async (c) => {
  const userId = c.req.query('userId')
  
  if (!userId) {
    return c.json({ error: 'userId query parameter is required' }, 400)
  }

  const userNotifications = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, Number(userId)))
    .orderBy(desc(notifications.createdAt))

  return c.json(userNotifications)
})

// Mark notification as read
.patch('/notifications/:id/read', async (c) => {
  const id = Number(c.req.param('id'))

  const [updated] = await db
    .update(notifications)
    .set({ read: true })
    .where(eq(notifications.id, id))
    .returning()

  if (!updated) {
    return c.json({ error: 'Notification not found' }, 404)
  }

  return c.json(updated)
})

// Delete notification
.delete('/notifications/:id', async (c) => {
  const id = Number(c.req.param('id'))

  const [deleted] = await db
    .delete(notifications)
    .where(eq(notifications.id, id))
    .returning()

  if (!deleted) {
    return c.json({ error: 'Notification not found' }, 404)
  }

  return c.json({ success: true })
})

export type AppType = typeof routes

serve({
  fetch: app.fetch,
  port: 3000,
  hostname: '0.0.0.0' // Add for Docker
}, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
})
