import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { supabase } from '../lib/supabase'
import { validateQuery } from '../lib/validation'

const router = Router()

// Public feed — no auth. Only ever selects published cards; the unreviewed
// queue is reachable exclusively through the admin routes.
// One literal, not a concatenation: Supabase infers the row type from this
// string, and joining pieces makes it opaque and collapses the result type.
const PUBLIC_COLUMNS = 'id, title, slug, summary, takeaway, category, court, judgment_date, source_url, source_name, tags, likes_count, published_at, created_at, relevance_tier, affects_whom, action_required, deadline, key_points, statute_reference, expires_on'

/**
 * Today in ISO date form, for the expiry filter.
 *
 * Time-bound cards ("auction on Sep 1") were staying in the feed after they
 * stopped meaning anything. Anything with expires_on in the past is dropped
 * from every public query.
 */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** PostgREST filter excluding expired cards. Rows with no expiry never expire. */
function unexpiredFilter(): string {
  return `expires_on.is.null,expires_on.gte.${today()}`
}

const archiveQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  category: z.string().max(100).trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(24),
})

const searchQuerySchema = z.object({
  q: z.string().min(1).max(120).trim(),
  limit: z.coerce.number().int().min(1).max(30).default(20),
})

const shortsQuerySchema = z.object({
  category: z.string().max(100).trim().optional(),
  // Cursor pagination: the feed is an infinite scroll, and offsets drift when
  // new cards are published mid-session.
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
})

// ── GET /api/shorts ───────────────────────────────────────────────────────────
router.get('/', validateQuery(shortsQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category, before, limit } = req.validatedQuery as z.infer<typeof shortsQuerySchema>

    let query = supabase
      .from('shorts_cards')
      .select(PUBLIC_COLUMNS)
      .eq('is_published', true)
      .order('created_at', { ascending: false })
      .limit(limit + 1) // one extra row tells us whether more exist

    if (category && category !== 'all') query = query.eq('category', category)
    if (before) query = query.lt('created_at', before)
    query = query.or(unexpiredFilter())

    const { data, error } = await query
    if (error) throw error

    const rows = data ?? []
    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows

    res.json({
      shorts: items,
      hasMore,
      nextCursor: hasMore ? items[items.length - 1]?.created_at ?? null : null,
    })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/shorts/categories ────────────────────────────────────────────────
// Powers the filter chips. Derived from published cards so a category with no
// live content never appears as an empty filter.
router.get('/categories', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('shorts_cards').select('category').eq('is_published', true)
      .or(unexpiredFilter())
    if (error) throw error

    const counts = new Map<string, number>()
    for (const row of data ?? []) {
      if (row.category) counts.set(row.category, (counts.get(row.category) ?? 0) + 1)
    }

    res.json({
      categories: [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
    })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/shorts/archive ───────────────────────────────────────────────────
// Everything published, grouped by month. Declared BEFORE /:slug or Express
// would match "archive" as a slug.
router.get('/archive', validateQuery(archiveQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { month, category, page, limit } = req.validatedQuery as z.infer<typeof archiveQuerySchema>
    const from = (page - 1) * limit

    let query = supabase
      .from('shorts_cards')
      .select(PUBLIC_COLUMNS, { count: 'exact' })
      .eq('is_published', true)

    if (category && category !== 'all') query = query.eq('category', category)
    if (month) {
      // month is YYYY-MM; bound it to that calendar month.
      const start = `${month}-01T00:00:00Z`
      const next = new Date(start)
      next.setUTCMonth(next.getUTCMonth() + 1)
      query = query.gte('published_at', start).lt('published_at', next.toISOString())
    }

    const { data, error, count } = await query
      .or(unexpiredFilter())
      .order('published_at', { ascending: false })
      .range(from, from + limit - 1)
    if (error) throw error

    res.json({ shorts: data ?? [], total: count ?? 0, page, limit })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/shorts/months ────────────────────────────────────────────────────
// Month buckets with counts, for the archive navigation.
router.get('/months', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('shorts_cards')
      .select('published_at')
      .eq('is_published', true)
      .not('published_at', 'is', null)
      .order('published_at', { ascending: false })
    if (error) throw error

    const counts = new Map<string, number>()
    for (const row of data ?? []) {
      const key = String(row.published_at).slice(0, 7)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    res.json({ months: [...counts.entries()].map(([month, count]) => ({ month, count })) })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/shorts/search ────────────────────────────────────────────────────
// People arriving from Google come with a question, not a category. Declared
// before /:slug or Express would read "search" as a slug.
router.get('/search', validateQuery(searchQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, limit } = req.validatedQuery as z.infer<typeof searchQuerySchema>
    const term = q.replace(/[%_,()]/g, '').trim()
    if (term.length < 2) return res.json({ shorts: [], query: q })

    const { data, error } = await supabase
      .from('shorts_cards')
      .select(PUBLIC_COLUMNS)
      .eq('is_published', true)
      .or(unexpiredFilter())
      .or(
        `title.ilike.%${term}%,summary.ilike.%${term}%,` +
        `takeaway.ilike.%${term}%,statute_reference.ilike.%${term}%`
      )
      .order('published_at', { ascending: false })
      .limit(limit)
    if (error) throw error

    return res.json({ shorts: data ?? [], query: q })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/shorts/:slug ─────────────────────────────────────────────────────
// Single card, for share links and SEO.
router.get('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('shorts_cards')
      .select(PUBLIC_COLUMNS)
      .eq('slug', String(req.params.slug))
      .eq('is_published', true)
      .maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Short not found' })

    return res.json({ short: data })
  } catch (err) {
    next(err)
  }
})

export default router
