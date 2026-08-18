import { Router, Request, Response } from 'express'
import { supabase } from '../lib/supabase'

const router = Router()

// ── GET /api/notifications/stream ────────────────────────────────────────────
// Server-Sent Events stream for lawyer's incoming consultation notifications.
// Frontend connects via EventSource — no Supabase SDK needed in frontend.
// Auth: cookie OR Bearer token.
router.get('/stream', async (req: Request, res: Response) => {
  // Auth check
  const token =
    req.cookies?.lx_access_token ||
    req.headers.authorization?.replace('Bearer ', '')

  if (!token) {
    res.status(401).json({ error: 'Not authenticated' })
    return
  }

  const { data: authData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !authData.user) {
    res.status(401).json({ error: 'Session expired' })
    return
  }

  const user = authData.user
  if (user.user_metadata?.role !== 'lawyer') {
    res.status(403).json({ error: 'Only lawyers can subscribe to notifications' })
    return
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // Important for Nginx / Render proxies
  res.flushHeaders()

  // Send initial heartbeat so client knows connection is alive
  res.write('event: connected\ndata: {"ok":true}\n\n')

  // Subscribe to Supabase Realtime on backend side
  const channel = supabase
    .channel(`sse-lawyer-${user.id}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'consultation_notifications',
        filter: `lawyer_id=eq.${user.id}`,
      },
      (payload) => {
        const n = payload.new as any
        // Check notification hasn't expired
        if (new Date(n.expires_at) <= new Date()) return

        const eventData = JSON.stringify({
          consultationId: n.consultation_id,
          type: n.type,
          clientId: n.client_id,
          expiresAt: n.expires_at,
        })
        res.write(`event: incoming_call\ndata: ${eventData}\n\n`)
      }
    )
    .subscribe()

  // Heartbeat every 20s to keep connection alive through proxies
  const heartbeat = setInterval(() => {
    res.write('event: heartbeat\ndata: {}\n\n')
  }, 20_000)

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(heartbeat)
    supabase.removeChannel(channel)
  })
})

export default router
