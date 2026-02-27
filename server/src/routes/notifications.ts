import { Hono } from 'hono'
import { db } from '../db'
import { notifications, notificationTypes, type NotificationType } from '../db/schema'
import { eq, desc } from 'drizzle-orm'

const notificationsApp = new Hono()
  .get('/', async (c) => {
    const userId = c.req.query('userId')
    if (!userId) return c.json({ error: 'userId required' }, 400)

    const data = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, Number(userId)))
      .orderBy(desc(notifications.createdAt))

    return c.json(data)
  })

  .post('/', async (c) => {
    const body = await c.req.json()
    const { userId, type, title, message } = body

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

  .patch('/:id/read', async (c) => {
    const id = Number(c.req.param('id'))
    const [updated] = await db
      .update(notifications)
      .set({ read: true })
      .where(eq(notifications.id, id))
      .returning()

    return updated ? c.json(updated) : c.json({ error: 'Not found' }, 404)
  })

  .delete('/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const [deleted] = await db
      .delete(notifications)
      .where(eq(notifications.id, id))
      .returning()

    return deleted ? c.json({ success: true }) : c.json({ error: 'Not found' }, 404)
  })

export default notificationsApp
