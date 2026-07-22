import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import leadsRouter from './routes/leads'
import applicationsRouter from './routes/applications'
import paymentRouter from './routes/payment'

const app = express()
const PORT = process.env.PORT || 4000

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet())

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',')
app.use(cors({
  origin: (origin, cb) => {
    // allow curl / server-side calls (no origin header)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true)
    cb(new Error(`CORS: ${origin} not allowed`))
  },
  credentials: true,
}))

// Global rate limit — 100 req / 15 min per IP
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true }))

app.use(express.json({ limit: '1mb' }))

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }))

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/leads', leadsRouter)
app.use('/api/applications', applicationsRouter)
app.use('/api/payment', paymentRouter)

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[ERROR]', err.message)
  res.status(500).json({ error: 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`✅  LegalX API running on port ${PORT}`)
})

export default app
