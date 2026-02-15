import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { db } from './db/index.js'
import { users } from './db/schema.js'

const app = new Hono().basePath('/api')

app.use('*', cors())

const routes = app.get('/users', async (c) => {
  const allUsers = await db.select().from(users)
  return c.json(allUsers)
})

export type AppType = typeof routes

serve({
  fetch: app.fetch,
  port: 3000,
  hostname: '0.0.0.0' // Add for Docker
}, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
})
