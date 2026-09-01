import { supabase } from './supabase'
import { logger } from './logger'
import { summariseJudgment, slugify } from './llm'
import { searchJudgments, fetchDocument, FEEDS } from './sources/indiankanoon'

export interface IngestResult {
  feed: string
  created: number
  skipped: number
  failed: number
  cards: { id: string; title: string; slug: string | null; category: string }[]
  failures: { tid: number; error: string }[]
  message?: string
}

/** Indian Kanoon publishes dates as `DD-MM-YYYY`; Postgres wants `YYYY-MM-DD`. */
function parseIkDate(raw: string | null): string | null {
  if (!raw) return null
  const m = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10)
}

/**
 * The daily pipeline: search a feed, fetch each document, summarise it, and
 * file it as a draft.
 *
 * Never publishes. An AI summary of case law goes out under the LegalX name
 * only after a person has read it — see is_published in the migration.
 */
export async function runAutoIngest(feed: string, limit: number): Promise<IngestResult> {
  const config = FEEDS[feed]
  if (!config) {
    throw new Error(`Unknown feed "${feed}". Valid: ${Object.keys(FEEDS).join(', ')}`)
  }

  const found = await searchJudgments({ query: config.query, withinDays: config.withinDays })
  if (found.length === 0) {
    return {
      feed, created: 0, skipped: 0, failed: 0, cards: [], failures: [],
      message: 'Indian Kanoon returned no documents. Check the query or the prepaid balance.',
    }
  }

  // Drop anything already ingested before spending API credit or LLM quota on
  // fetching and summarising it.
  const urlFor = (tid: number) => `https://indiankanoon.org/doc/${tid}/`
  const { data: seen } = await supabase
    .from('shorts_cards').select('source_url').in('source_url', found.map(d => urlFor(d.tid)))
  const seenUrls = new Set((seen ?? []).map(r => r.source_url))

  const fresh = found.filter(d => !seenUrls.has(urlFor(d.tid))).slice(0, limit)

  const cards: IngestResult['cards'] = []
  const failures: IngestResult['failures'] = []

  for (const doc of fresh) {
    try {
      const full = await fetchDocument(doc.tid)
      const summary = await summariseJudgment(full.text)

      const { data: card, error } = await supabase
        .from('shorts_cards')
        .insert({
          title: summary.title,
          slug: slugify(summary.title, String(doc.tid).slice(-6)),
          summary: summary.summary,
          takeaway: summary.takeaway || null,
          category: summary.category,
          court: full.docsource || summary.court,
          judgment_date: parseIkDate(full.publishdate),
          source_url: full.url,
          tags: summary.tags,
          is_published: false,
          raw_source: { tid: doc.tid, feed, text: full.text.slice(0, 200_000) },
        })
        .select('id, title, slug, category')
        .single()

      if (error) {
        // 23505 = a concurrent run already inserted it; not a real failure.
        if ((error as any).code !== '23505') failures.push({ tid: doc.tid, error: error.message })
        continue
      }
      cards.push(card)
    } catch (err: any) {
      const message = err?.message ?? 'unknown error'
      failures.push({ tid: doc.tid, error: message })
      logger.warn({ tid: doc.tid, feed, err: message }, 'shorts auto-ingest: document failed')
      // A rate limit will hit every remaining document too — stop rather than
      // burn the rest of the quota re-failing.
      if (/rate limit/i.test(message)) break
    }
  }

  logger.info({ feed, created: cards.length, failed: failures.length }, 'shorts auto-ingest complete')

  return {
    feed,
    created: cards.length,
    skipped: found.length - fresh.length,
    failed: failures.length,
    cards,
    failures,
  }
}
