import { Router, Request, Response, NextFunction } from 'express'
import { supabase, supabaseAuthValidator } from '../lib/supabase'
import { logger } from '../lib/logger'
import { validateParams, validateQuery, uuidParamSchema, adminListQuerySchema } from '../lib/validation'

const router = Router()

/** Resolves the caller from the HttpOnly cookie (or a mobile Bearer token). */
async function getUser(req: Request) {
  const token =
    req.cookies?.lx_access_token ||
    req.headers.authorization?.replace('Bearer ', '')
  if (!token) return null

  const { data, error } = await supabaseAuthValidator.auth.getUser(token)
  if (error || !data.user) return null

  const { data: account } = await supabase
    .from('accounts').select('role').eq('id', data.user.id).maybeSingle()

  return { id: data.user.id, role: account?.role ?? data.user.user_metadata?.role ?? 'client' }
}

// ── GET /api/notifications/stream ────────────────────────────────────────────
// Server-Sent Events. The browser connects with EventSource and its cookie;
// no Supabase SDK or anon key is needed on the frontend, and the user's JWT
// never has to be readable by JavaScript.
//
// Supabase Realtime is consumed *here*, server-side, and relayed to the one
// authenticated user who owns these rows.
router.get('/stream', async (req: Request, res: Response) => {
  const user = await getUser(req)
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' })
    return
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // required for Render/Nginx proxies
  res.flushHeaders()
  res.write('event: connected\ndata: {"ok":true}\n\n')

  // General in-app notifications for this account.
  const notifChannel = supabase
    .channel(`sse-notifications-${user.id}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'notifications', filter: `account_id=eq.${user.id}` },
      payload => {
        const n = payload.new as any
        res.write(`event: notification\ndata: ${JSON.stringify({
          id: n.id,
          title: n.title,
          message: n.message,
          type: n.type,
          link: n.link,
          isRead: n.is_read,
          createdAt: n.created_at,
        })}\n\n`)
      }
    )
    .subscribe()

  // Incoming-call ring signal — lawyers only, and separate because these
  // expire in seconds and drive a full-screen prompt rather than the bell.
  const callChannel = user.role === 'lawyer'
    ? supabase
        .channel(`sse-lawyer-calls-${user.id}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'consultation_notifications', filter: `lawyer_id=eq.${user.id}` },
          payload => {
            const n = payload.new as any
            if (new Date(n.expires_at) <= new Date()) return
            res.write(`event: incoming_call\ndata: ${JSON.stringify({
              consultationId: n.consultation_id,
              type: n.type,
              clientId: n.client_id,
              expiresAt: n.expires_at,
            })}\n\n`)
          }
        )
        .subscribe()
    : null

  const heartbeat = setInterval(() => {
    res.write('event: heartbeat\ndata: {}\n\n')
  }, 20_000)

  req.on('close', () => {
    clearInterval(heartbeat)
    supabase.removeChannel(notifChannel)
    if (callChannel) supabase.removeChannel(callChannel)
  })
})

// ── GET /api/notifications ───────────────────────────────────────────────────
router.get('/', validateQuery(adminListQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await getUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }

    const { page, pageSize } = req.validatedQuery as any
    const from = (page - 1) * pageSize

    const { data, error, count } = await supabase
      .from('notifications')
      .select('id, title, message, type, is_read, link, created_at', { count: 'exact' })
      .eq('account_id', user.id)
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1)
    if (error) throw error

    const { count: unread } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', user.id)
      .eq('is_read', false)

    res.json({ notifications: data ?? [], total: count ?? 0, unread: unread ?? 0, page, pageSize })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /api/notifications/:id/read ────────────────────────────────────────
router.patch('/:id/read', validateParams(uuidParamSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await getUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }

    // Scoped by account_id as well as id, so one user cannot mark another
    // user's notification read by guessing a UUID.
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', String(req.params.id))
      .eq('account_id', user.id)
    if (error) throw error

    res.json({ message: 'Marked read' })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /api/notifications/read-all ────────────────────────────────────────
router.patch('/read-all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await getUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }

    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('account_id', user.id)
      .eq('is_read', false)
    if (error) throw error

    res.json({ message: 'All marked read' })
  } catch (err) {
    next(err)
  }
})

export default router
