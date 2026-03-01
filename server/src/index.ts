import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import usersHandler from './routes/users.js'
import notificationsHandler from './routes/notifications.js'

const app = new Hono().basePath('/api')

app.use('*', cors())
app.use('*', logger())

app.get('/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }))

const routes = app
  .route('/users', usersHandler)
  .route('/notifications', notificationsHandler)

// Export Type for Hono RPC (Frontend Type Safety)
export type AppType = typeof routes

const port = 3000
console.log(`🚀 Server starting on http://0.0.0.0:${port}`)

serve({
  fetch: app.fetch,
  port,
  hostname: '0.0.0.0'
})
