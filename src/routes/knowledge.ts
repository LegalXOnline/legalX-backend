import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { supabase } from '../lib/supabase'
import { validateQuery } from '../lib/validation'

const router = Router()

/**
 * Know Your Rights — the second Knowledge Centre section.
 *
 * Public and unauthenticated. Every query in this file filters
 * is_published = true inline; there is deliberately no config flag or
 * environment switch that could turn the gate off, because an unreviewed
 * explainer about criminal law is exactly the thing that must never leak.
 *
 * One literal per column list, not a concatenation: Supabase infers the row
 * type from the string, and joining pieces makes it opaque.
 */
const LIST_COLUMNS = 'id, slug, title, question, direct_answer, category, case_reference, cta_type, source, source_url, published_at, last_reviewed_at'

const DETAIL_COLUMNS = 'id, slug, title, question, direct_answer, explanation, card_text, category, case_reference, suggested_questions, source, source_url, source_tid, cta_type, reviewed_by, last_reviewed_at, published_at, created_at'

const listQuerySchema = z.object({
  category: z.string().max(60).trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(24),
})

const searchQuerySchema = z.object({
  q: z.string().min(2).max(120).trim(),
  limit: z.coerce.number().int().min(1).max(30).default(20),
})

// ── GET /api/knowledge ────────────────────────────────────────────────────────
// Paginated list. Offset paging rather than a cursor: this set is curated and
// near-static, so pages do not drift underneath a reader mid-scroll.
router.get('/', validateQuery(listQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category, page, limit } = req.validatedQuery as z.infer<typeof listQuerySchema>
    const from = (page - 1) * limit

    let query = supabase
      .from('knowledge_cards')
      .select(LIST_COLUMNS, { count: 'exact' })
      .eq('is_published', true)
      .order('published_at', { ascending: false, nullsFirst: false })
      .range(from, from + limit - 1)

    if (category && category !== 'all') query = query.eq('category', category)

    const { data, error, count } = await query
    if (error) throw error

    res.json({
      cards: data ?? [],
      total: count ?? 0,
      page,
      limit,
      hasMore: (count ?? 0) > from + (data?.length ?? 0),
    })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/knowledge/categories ─────────────────────────────────────────────
// Counts for the filter chips. Only published rows are counted, so a chip
// never promises cards a reader cannot open.
router.get('/categories', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('knowledge_cards')
      .select('category')
      .eq('is_published', true)
    if (error) throw error

    const counts = new Map<string, number>()
    for (const row of data ?? []) {
      const key = (row as { category: string }).category
      counts.set(key, (counts.get(key) ?? 0) + 1)
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

// ── GET /api/knowledge/search ─────────────────────────────────────────────────
router.get('/search', validateQuery(searchQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, limit } = req.validatedQuery as z.infer<typeof searchQuerySchema>
    // Escape PostgREST's or() delimiters so a comma or parenthesis in the
    // query cannot alter the filter expression.
    const safe = q.replace(/[(),]/g, ' ').trim()

    const { data, error } = await supabase
      .from('knowledge_cards')
      .select(LIST_COLUMNS)
      .eq('is_published', true)
      .or(`title.ilike.%${safe}%,direct_answer.ilike.%${safe}%,case_reference.ilike.%${safe}%`)
      .limit(limit)
    if (error) throw error

    res.json({ cards: data ?? [] })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/knowledge/slugs ──────────────────────────────────────────────────
// Feeds the sitemap. lastmod comes from last_reviewed_at so a re-review lifts
// the date without needing the card to be republished.
router.get('/slugs', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('knowledge_cards')
      .select('slug, last_reviewed_at, published_at')
      .eq('is_published', true)
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(5000)
    if (error) throw error

    res.json({ cards: data ?? [] })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/knowledge/:slug ──────────────────────────────────────────────────
// Registered last so it cannot shadow /categories, /search or /slugs.
router.get('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = String(req.params.slug ?? '').slice(0, 120)

    const { data, error } = await supabase
      .from('knowledge_cards')
      .select(DETAIL_COLUMNS)
      .eq('slug', slug)
      .eq('is_published', true)
      .maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Not found' })

    // Related cards for internal linking. Same category, published, excluding
    // this one — suggested_questions are prompts, not links, so the related
    // rail is what actually connects pages for a crawler.
    const { data: related } = await supabase
      .from('knowledge_cards')
      .select('slug, title, direct_answer, category')
      .eq('is_published', true)
      .eq('category', (data as { category: string }).category)
      .neq('slug', slug)
      .limit(4)

    res.json({ card: data, related: related ?? [] })
  } catch (err) {
    next(err)
  }
})

export default router
