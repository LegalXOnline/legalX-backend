import 'dotenv/config'
import crypto from 'crypto'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import { rateLimit } from 'express-rate-limit'
import csrf from 'csrf'
import { logger } from './lib/logger'
import { startKeepAlive } from './lib/keepAlive'
import leadsRouter from './routes/leads'
import applicationsRouter from './routes/applications'
import paymentRouter from './routes/payment'
import authRouter from './routes/auth'
import lawyersRouter from './routes/lawyers'
import adminRouter from './routes/admin'

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      csrfSecret?: string
      id?: string
      startTime?: number
    }
  }
}

const app = express()
const PORT = process.env.PORT || 4000

// ── Request ID & Logging Middleware ──────────────────────────────────────────────
app.use((req, res, next) => {
  req.id = crypto.randomUUID()
  req.startTime = Date.now()

  res.on('finish', () => {
    const duration = Date.now() - (req.startTime ?? Date.now())
    logger.info({
      reqId: req.id,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    }, 'HTTP request')
  })

  next()
})

// ── CSRF Protection ──────────────────────────────────────────────────────────────
const csrfProtection = new csrf()
const CSRF_COOKIE_NAME = 'csrf_token'
const CSRF_HEADER_NAME = 'x-csrf-token'

// Generate CSRF token for each session
app.use((req, res, next) => {
  const secret = csrfProtection.secretSync()
  req.csrfSecret = secret
  const token = csrfProtection.create(secret)
  const isProd = process.env.NODE_ENV === 'production'
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false, // Must be readable by frontend JS
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax', // 'none' allows cross-origin AJAX with credentials
    path: '/',
  })
  res.locals.csrfToken = token
  next()
})

// Validate CSRF token on state-changing requests
const validateCsrf = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()

  const token = req.headers[CSRF_HEADER_NAME] as string || req.body._csrf
  const secret = req.csrfSecret

  if (!token || !secret || !csrfProtection.verify(secret, token)) {
    return res.status(403).json({ error: 'Invalid CSRF token' })
  }
  next()
}

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet())

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',')
app.use(cors({
  origin: (origin, cb) => {
    // allow curl / server-side calls (no origin header)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true)
    // Allow any vercel.app or netlify.app subdomain in production for preview deployments
    if (process.env.NODE_ENV === 'production' && (origin.endsWith('.vercel.app') || origin.endsWith('.netlify.app'))) {
      return cb(null, true)
    }
    cb(new Error(`CORS: ${origin} not allowed`))
  },
  credentials: true, // Required for cookies to be sent cross-origin
}))

// Global rate limit — 100 req / 15 min per IP
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true }))

app.use(express.json({ limit: '1mb' }))
app.use(cookieParser()) // Parse HttpOnly cookies for auth

// ── Health check ─────────────────────────────────────────────────────────────
import { supabase } from './lib/supabase'

app.get('/health', async (_req, res) => {
  const start = Date.now()
  let dbStatus = 'ok'
  let dbLatency = 0

  try {
    const dbStart = Date.now()
    const { error } = await supabase.from('leads').select('id').limit(1)
    dbLatency = Date.now() - dbStart
    if (error) throw error
  } catch {
    dbStatus = 'error'
  }

  const latency = Date.now() - start
  const status = dbStatus === 'ok' ? 200 : 503

  res.status(status).json({
    ok: dbStatus === 'ok',
    ts: new Date().toISOString(),
    latency: `${latency}ms`,
    database: {
      status: dbStatus,
      latency: `${dbLatency}ms`,
    },
  })
})

// ── Routes ────────────────────────────────────────────────────────────────────
// Public routes that don't need CSRF (login, signup, public lawyer directory)
app.use('/api/auth', authRouter)
app.use('/api/lawyers', lawyersRouter)

// Protected routes with CSRF validation
app.use('/api/leads', validateCsrf, leadsRouter)
app.use('/api/applications', validateCsrf, applicationsRouter)
app.use('/api/payment', validateCsrf, paymentRouter)
app.use('/api/admin', validateCsrf, adminRouter)

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({
    reqId: req.id,
    err: {
      message: err.message,
      stack: err.stack,
      name: err.name,
    },
  }, 'Unhandled error')
  res.status(500).json({ error: 'Internal server error' })
})

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, '✅  LegalX API running')
  // Start self-ping keep-alive cron (production only)
  startKeepAlive(process.env.RENDER_EXTERNAL_URL || '')
})

// ── Graceful shutdown ──────────────────────────────────────────────────────────
let isShuttingDown = false

async function shutdown(signal: string) {
  if (isShuttingDown) return
  isShuttingDown = true
  logger.warn({ signal }, 'Shutdown signal received, starting graceful shutdown...')

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed')
    process.exit(0)
  })

  // Force close after 10 seconds
  setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit')
    process.exit(1)
  }, 10_000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

export default app
