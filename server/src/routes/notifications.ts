import { Hono } from 'hono'
import { db } from '../db'
import { notifications, notificationTypes, type NotificationType } from '../db/schema'
import { eq, desc, and } from 'drizzle-orm'
import { authMiddleware } from '../middleware/authMiddleware.js'

// Tell Hono that every route in this app has a 'userId' string in context
const notificationsApp = new Hono<{ Variables: { userId: string } }>()

notificationsApp.use('*', authMiddleware)

notificationsApp
  .get('/', async (c) => {
    const userId = c.get('userId')

    const data = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))

    return c.json(data)
  })

  .post('/', async (c) => {
    const userId = c.get('userId')
    const body = await c.req.json()
    const { type, title, message } = body

    if (!Object.values(notificationTypes).includes(type as NotificationType)) {
      return c.json({ error: 'Invalid notification type' }, 400)
    }

    const [notification] = await db.insert(notifications).values({
      userId,
      type: type as NotificationType,
      title,
      message,
    }).returning()

    return c.json(notification, 201)
  })

  .patch('/:id/read', async (c) => {
    const userId = c.get('userId')
    const id = Number(c.req.param('id'))

    const [updated] = await db
      .update(notifications)
      .set({ read: true })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.userId, userId)
        )
      )
      .returning()

    return updated ? c.json(updated) : c.json({ error: 'Notification not found or unauthorized' }, 404)
  })

  .delete('/:id', async (c) => {
    const userId = c.get('userId')
    const id = Number(c.req.param('id'))

    const [deleted] = await db
      .delete(notifications)
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.userId, userId)
        )
      )
      .returning()

    return deleted ? c.json({ success: true }) : c.json({ error: 'Notification not found or unauthorized' }, 404)
  })

export default notificationsApp
