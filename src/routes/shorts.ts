import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { supabase } from '../lib/supabase'
import { validateQuery } from '../lib/validation'

const router = Router()

// Public feed — no auth. Only ever selects published cards; the unreviewed
// queue is reachable exclusively through the admin routes.
const PUBLIC_COLUMNS =
  'id, title, slug, summary, takeaway, category, court, judgment_date, source_url, tags, likes_count, published_at, created_at'

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
      .from('shorts_cards')
      .select('category')
      .eq('is_published', true)
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
