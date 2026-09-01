import crypto from 'crypto'
import { supabase } from './supabase'
import { logger } from './logger'
import { summariseSource, slugify, type Suggestion } from './llm'
import { FEED_SOURCES, fetchFeed, fetchArticleText, type FeedItem } from './sources/rss'

/**
 * Candidates below this are never shown to an editor. A 1–2 is a procedural
 * direction or a corporate filing — true, but not why anyone opens a consumer
 * legal app.
 */
const MIN_RELEVANCE = 3

export interface IngestReport {
  proposed: number
  skipped: { title: string; reason: string }[]
  failed: { url: string; error: string }[]
  suggestions: { id: string; title: string; relevance_score: number | null; confidence: string | null }[]
}

/** Stable id for a source URL, used to dedupe and to suffix slugs. */
function urlHash(url: string): string {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 8)
}

/**
 * Filters out anything already seen — published, pending, or previously
 * rejected. Rejected items matter most here: without this the same article
 * an editor declined yesterday reappears every morning.
 */
async function dropAlreadySeen(items: FeedItem[]): Promise<FeedItem[]> {
  if (items.length === 0) return []
  const urls = items.map(i => i.link)
  const { data } = await supabase
    .from('shorts_cards').select('source_url').in('source_url', urls)
  const seen = new Set((data ?? []).map(r => r.source_url))
  return items.filter(i => !seen.has(i.link))
}

async function insertSuggestion(
  item: FeedItem,
  suggestion: Suggestion,
  sourceText: string
): Promise<{ id: string; title: string; relevance_score: number | null; confidence: string | null } | null> {
  const { data, error } = await supabase
    .from('shorts_cards')
    .insert({
      title: suggestion.title,
      slug: slugify(suggestion.title, urlHash(item.link)),
      summary: suggestion.summary,
      takeaway: suggestion.takeaway || null,
      category: suggestion.category,
      court: suggestion.court,
      judgment_date: parsePubDate(item.pubDate),
      source_url: item.link,
      source_name: item.sourceName,
      source_feed: item.sourceFeed,
      tags: suggestion.tags,
      evidence: suggestion.evidence,
      relevance_score: suggestion.relevanceScore,
      confidence: suggestion.confidence,
      is_published: false,
      review_status: 'pending',
      raw_source: { headline: item.title, text: sourceText.slice(0, 200_000) },
    })
    .select('id, title, relevance_score, confidence')
    .single()

  if (error) {
    // 23505 = a concurrent run inserted it first; not a real failure.
    if ((error as any).code !== '23505') {
      logger.error({ err: error.message, url: item.link }, 'suggestion insert failed')
    }
    return null
  }
  return data
}

function parsePubDate(raw?: string): string | null {
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/**
 * The daily run: gather candidates from the enabled feeds, summarise each under
 * the grounding contract, and file whatever survives as pending suggestions.
 *
 * Deliberately proposes more than will be published — an editor picks the best
 * few. Nothing here ever publishes.
 */
export async function runIngest(opts: {
  feeds?: string[]
  /** How many suggestions to aim for. The editor will keep roughly half. */
  target?: number
} = {}): Promise<IngestReport> {
  const target = Math.min(Math.max(opts.target ?? 8, 1), 20)

  const sources = FEED_SOURCES.filter(
    s => (opts.feeds?.length ? opts.feeds.includes(s.id) : s.enabled)
  )
  if (sources.length === 0) {
    throw new Error('No feed sources are enabled.')
  }

  const report: IngestReport = { proposed: 0, skipped: [], failed: [], suggestions: [] }

  // Gather candidates across all feeds first, so one prolific source cannot
  // crowd out the rest of the day's mix.
  let candidates: FeedItem[] = []
  for (const source of sources) {
    try {
      candidates.push(...(await fetchFeed(source)))
    } catch (err: any) {
      report.failed.push({ url: source.url, error: err?.message ?? 'feed fetch failed' })
    }
  }

  candidates = await dropAlreadySeen(candidates)
  logger.info({ candidates: candidates.length, target }, 'ingest: candidates after dedupe')

  for (const item of candidates) {
    if (report.proposed >= target) break

    try {
      // The feed description is usually a stub; the article body is what the
      // summariser actually needs.
      let sourceText = ''
      try {
        sourceText = await fetchArticleText(item.link)
      } catch {
        sourceText = item.description ?? ''
      }
      if (sourceText.length < 250 && item.description) {
        sourceText = `${item.title}\n\n${item.description}`
      }

      const result = await summariseSource(sourceText, {
        title: item.title,
        sourceName: item.sourceName,
      })

      if ('skipped' in result) {
        report.skipped.push({ title: item.title.slice(0, 90), reason: result.reason })
        continue
      }

      if (result.relevanceScore < MIN_RELEVANCE) {
        report.skipped.push({
          title: item.title.slice(0, 90),
          reason: `Relevance ${result.relevanceScore}/5 — below the ${MIN_RELEVANCE} threshold.`,
        })
        continue
      }

      const inserted = await insertSuggestion(item, result, sourceText)
      if (inserted) {
        report.suggestions.push(inserted)
        report.proposed += 1
      }
    } catch (err: any) {
      const message = err?.message ?? 'unknown error'
      report.failed.push({ url: item.link, error: message })
      // A rate limit or missing key will hit every remaining item too.
      if (/rate limit|not configured/i.test(message)) break
    }
  }

  // Best candidates first, so the editor reads the strongest suggestions while
  // their attention is freshest.
  report.suggestions.sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))

  logger.info(
    { proposed: report.proposed, skipped: report.skipped.length, failed: report.failed.length },
    'ingest complete'
  )
  return report
}

/**
 * One-off draft from an operator-supplied source: a URL to fetch, or text
 * pasted directly. Used for anything the feeds miss.
 */
export async function draftFromSource(input: {
  sourceUrl: string
  rawText?: string
  sourceName?: string
}): Promise<{ id: string; title: string } | { skipped: true; reason: string }> {
  const { data: existing } = await supabase
    .from('shorts_cards').select('id, title').eq('source_url', input.sourceUrl).maybeSingle()
  if (existing) {
    throw new Error(`Already ingested as "${existing.title}".`)
  }

  const sourceText = input.rawText?.trim()
    ? input.rawText
    : await fetchArticleText(input.sourceUrl)

  const result = await summariseSource(sourceText, { sourceName: input.sourceName })
  if ('skipped' in result) return { skipped: true, reason: result.reason }

  const item: FeedItem = {
    title: result.title,
    link: input.sourceUrl,
    sourceName: input.sourceName ?? 'Manual entry',
    sourceFeed: 'manual',
  }
  const inserted = await insertSuggestion(item, result, sourceText)
  if (!inserted) throw new Error('Could not save the draft.')
  return { id: inserted.id, title: inserted.title }
}
