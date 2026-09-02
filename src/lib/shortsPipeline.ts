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

/**
 * How much source text is retained per card.
 *
 * The summariser trims its input to 18,000 characters, so anything kept beyond
 * that can never be read back — it was pure storage cost. Supabase's free tier
 * is 500 MB; at the old 200,000-char cap a few thousand cards would have
 * filled it.
 */
export const RAW_SOURCE_MAX_CHARS = 20_000

/**
 * Pause between documents, sized to whichever provider is primary.
 */
function pacingMs(): number {
  const explicit = Number(process.env.SHORTS_PACE_MS)
  if (Number.isFinite(explicit) && explicit >= 0) return explicit
  // Gemini's free tier allows 1,000,000 tokens per minute against Groq's 8,000,
  // so it needs almost no pacing. Groq needs ~22s between documents or the run
  // burns its allowance in seconds and every later candidate 429s.
  const primary = process.env.SHORTS_LLM_PROVIDER ?? 'gemini'
  return primary === 'gemini' ? 1_500 : 22_000
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Live state of the background ingest.
 *
 * A full run takes minutes — fetching each article and summarising it — which
 * is far longer than the Vercel gateway will hold a request open. It returned
 * 502 while the backend carried on working, so the admin saw a failure for a
 * run that actually succeeded. The run now happens in the background and the
 * UI polls this.
 *
 * In-memory because the API is a single Render instance. If it is ever scaled
 * out this must move to the database, or each instance will report only its
 * own runs.
 */
export interface IngestJob {
  status: 'idle' | 'running' | 'done' | 'failed'
  startedAt: string | null
  finishedAt: string | null
  /** Candidates processed so far, and how many there are in total. */
  processed: number
  total: number
  report: IngestReport | null
  error: string | null
}

let currentJob: IngestJob = {
  status: 'idle', startedAt: null, finishedAt: null,
  processed: 0, total: 0, report: null, error: null,
}

export function getIngestJob(): IngestJob {
  return currentJob
}

/**
 * Starts a run in the background if one is not already going.
 *
 * Returns immediately. Refusing to start a second concurrent run matters:
 * two runs would race on the same feed items and burn double the quota
 * producing duplicates the unique index then rejects.
 */
export function startIngest(opts: { feeds?: string[]; target?: number } = {}): IngestJob {
  if (currentJob.status === 'running') return currentJob

  currentJob = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    processed: 0,
    total: 0,
    report: null,
    error: null,
  }

  // Deliberately not awaited — the caller responds straight away.
  void runIngest({
    ...opts,
    onProgress: (processed, total) => {
      currentJob.processed = processed
      currentJob.total = total
    },
  })
    .then(report => {
      currentJob = { ...currentJob, status: 'done', finishedAt: new Date().toISOString(), report }
    })
    .catch(err => {
      currentJob = {
        ...currentJob,
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: err?.message ?? 'Ingest failed',
      }
    })

  return currentJob
}

export interface IngestReport {
  proposed: number
  skipped: { title: string; reason: string }[]
  failed: { url: string; error: string }[]
  suggestions: { id: string; title: string; relevance_score: number | null; confidence: string | null }[]
  /** Set when the run halted before reaching `target` — e.g. a quota ran out. */
  stoppedEarly?: boolean
  stopReason?: string
  /** How many candidates were still unprocessed when it stopped. */
  remaining?: number
  message?: string
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
      raw_source: { headline: item.title, text: sourceText.slice(0, RAW_SOURCE_MAX_CHARS) },
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
  onProgress?: (processed: number, total: number) => void
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
  opts.onProgress?.(0, Math.min(candidates.length, target))

  let processed = 0
  let index = 0
  for (const item of candidates) {
    index += 1
    if (report.proposed >= target) break
    opts.onProgress?.(report.proposed, target)

    // Pace from the second document onward; the first costs nothing to start.
    if (processed > 0) await sleep(pacingMs())
    processed += 1

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

      // A quota or configuration problem applies to every remaining candidate,
      // so stop rather than failing the rest one by one. Whatever was already
      // inserted stays — a partial batch is a useful batch, and the rest can be
      // picked up on the next run.
      if (/rate limit|not configured|unavailable/i.test(message)) {
        report.stoppedEarly = true
        report.stopReason = /rate limit|unavailable/i.test(message)
          ? 'Summarisation quota reached for now.'
          : 'Summarisation is not configured.'
        report.remaining = candidates.length - index
        break
      }
    }
  }

  // Best candidates first, so the editor reads the strongest suggestions while
  // their attention is freshest.
  report.suggestions.sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))

  if (report.stoppedEarly) {
    report.message = report.proposed > 0
      ? `Added ${report.proposed}, then stopped: ${report.stopReason} ${report.remaining ?? 0} candidates are still queued — run again in a minute to continue.`
      : `${report.stopReason} Nothing was added. Try again shortly.`
  } else if (report.proposed === 0) {
    report.message = candidates.length === 0
      ? 'No new items in the feeds — everything has already been seen.'
      : 'Every candidate was rejected by the grounding checks. See the reasons below.'
  }

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

  // Pasted text wins, but only if it is actually a document. A short string is
  // almost always a note or a search phrase typed into the wrong box, so fall
  // back to fetching the URL rather than failing on it.
  const pasted = input.rawText?.trim() ?? ''
  const sourceText = pasted.length >= 250
    ? pasted
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
