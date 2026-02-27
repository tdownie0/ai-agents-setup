import { Hono } from 'hono'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'

const usersApp = new Hono()
  .get('/', async (c) => {
      const allUsers = await db.select().from(users)
      return c.json(allUsers)
  })

export default usersApp
