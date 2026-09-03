import crypto from 'crypto'
import { supabase } from './supabase'
import { logger } from './logger'
import { summariseSource, verifyCard, slugify, type Suggestion, type VerifyResult } from './llm'
import { relevanceGate, dedupeKey, isNearDuplicate, type GateVerdict } from './gate'
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
 * Cheap pre-flight check, run BEFORE spending an LLM call.
 *
 * Regulator feeds are dominated by items that are a headline and nothing else —
 * SEBI recovery certificates, release orders, auction results. The model
 * correctly refused all of them, but only after a full request each, which is
 * what exhausted the daily quota before any real content was reached.
 *
 * These are the same signals the model reported in its own refusals:
 * "only a headline", "repetitive", "no substantive content".
 */
export function looksSubstantive(text: string, headline?: string): { ok: boolean; reason?: string } {
  const clean = text.replace(/\s+/g, ' ').trim()

  if (clean.length < 700) {
    return { ok: false, reason: `Only ${clean.length} characters of body text — too thin to summarise.` }
  }

  // A page that is mostly its own headline repeated in nav, breadcrumb and
  // title is a stub with no article behind it.
  if (headline && headline.length > 25) {
    const needle = headline.slice(0, 40).toLowerCase()
    const hay = clean.toLowerCase()
    let count = 0, from = 0
    while (true) {
      const at = hay.indexOf(needle, from)
      if (at === -1) break
      count++
      from = at + needle.length
    }
    if (count >= 3 && clean.length < 2_500) {
      return { ok: false, reason: 'Page repeats its headline with no article body.' }
    }
  }

  // Real prose has sentences. A list of certificate numbers does not.
  const sentences = clean.split(/[.!?]\s/).filter(p => p.trim().split(/\s+/).length >= 8)
  if (sentences.length < 4) {
    return { ok: false, reason: 'Fewer than four full sentences — likely a table or a stub.' }
  }

  return { ok: true }
}

/**
 * Titles that are administrative records rather than legal developments.
 * Matched before fetching, so these cost nothing at all.
 */
const NON_STORY_PATTERNS = [
  /recovery certificate/i,
  /release order/i,
  /remittance order/i,
  /certificate of completion/i,
  /\bdefaulter\b/i,
  /attachment of (bank|demat)/i,
  /money market operations/i,
  /auction (result|of state)/i,
  /\bcut-?off price/i,
  /appoints? (shri|smt|dr)/i,
]

function isNonStory(title: string): boolean {
  return NON_STORY_PATTERNS.some(re => re.test(title))
}

/**
 * Named private individuals.
 *
 * SEBI and RBI enforcement notices are titled after the person they are
 * against — "In the matter of Shri <name>". Summarising those republishes an
 * individual's name on a consumer feed, which serves no reader and is a real
 * harm to the person named. There is no legal update in them either: the
 * general public cannot act on one person's adjudication order.
 *
 * Applied to headline and body, before the gate, so a match costs no LLM call.
 */
const NAME_PATTERN = /(?:^|\s)(?:Shri|Smt\.?|Mr\.?|Mrs\.?|Ms\.?|Dr\.?|M\/s\.?)\s+[A-Z][a-z]+/
const MATTER_PATTERN = /in the matter of/i

/**
 * Honorifics are optional in practice. SEBI titles its orders "General
 * Remittance Order against Sagarkumar Dataniya" — a named private individual
 * with no Shri or Mr in front, which the honorific pattern alone lets through.
 */
const ENFORCEMENT_AGAINST = /\b(?:against|upon|on)\s+(?:Shri|Smt\.?|Mr\.?|Mrs\.?|Ms\.?|Dr\.?|M\/s\.?\s*)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/

/**
 * Words that mark the matched phrase as an organisation rather than a person.
 * An order against a listed company is public-interest news; an order against
 * an individual retail trader is not, and republishing their name is the harm.
 */
const INSTITUTION_WORDS = /\b(?:Bank|Limited|Ltd|Private|Pvt|Corporation|Corp|Company|Board|Authority|Commission|Ministry|Department|Government|Exchange|Securities|Fund|Trust|Services|Industries|Enterprises|Association|Council|Institute|University|Court|Tribunal|Federation|Society|Union|Agency|Bureau|Reserve|India|Insurance|Finance|Financial|Holdings|Capital|Technologies|Solutions|Systems)\b/

/** Enforcement-order titles that are about one named party by construction. */
const ENFORCEMENT_DOC = /\b(?:remittance order|adjudication order|recovery certificate|attachment order|debarment|show cause notice|penalty (?:on|against))\b/i

export function namesPrivateIndividual(text: string, title?: string): boolean {
  const haystacks = [title ?? '', text ?? '']

  for (const h of haystacks) {
    if (!h) continue
    if (NAME_PATTERN.test(h) || MATTER_PATTERN.test(h)) return true
    if (ENFORCEMENT_DOC.test(h)) return true

    const m = ENFORCEMENT_AGAINST.exec(h)
    if (m && !INSTITUTION_WORDS.test(m[1])) return true
  }
  return false
}

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
 * How long to wait when a per-minute quota is hit, and how many times.
 *
 * Per-minute limits refill in a minute, so pausing is nearly always better than
 * abandoning the run. Capped so a genuinely exhausted daily quota cannot make
 * the job hang indefinitely.
 */
const COOLDOWN_MS = Number(process.env.SHORTS_COOLDOWN_MS ?? 65_000)
const MAX_COOLDOWNS = Number(process.env.SHORTS_MAX_COOLDOWNS ?? 3)

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
  status: 'idle' | 'running' | 'done' | 'failed' | 'cancelled'
  startedAt: string | null
  finishedAt: string | null
  /** Candidates processed so far, and how many there are in total. */
  processed: number
  total: number
  report: IngestReport | null
  error: string | null
  /** Set while waiting out a provider quota, so the UI can say why it paused. */
  cooldownUntil: string | null
}

let currentJob: IngestJob = {
  status: 'idle', startedAt: null, finishedAt: null,
  processed: 0, total: 0, report: null, error: null, cooldownUntil: null,
}

export function getIngestJob(): IngestJob {
  return currentJob
}

/**
 * Co-operative cancellation.
 *
 * A run can sit in a 65-second quota cooldown, so the flag is checked both
 * between items and inside the sleep — otherwise "Stop" would appear to do
 * nothing for a minute. Whatever the run already produced is kept: those cards
 * are in the review queue and are still useful.
 */
let cancelRequested = false

export function cancelIngest(): IngestJob {
  if (currentJob.status === 'running') {
    cancelRequested = true
    logger.info({}, 'ingest: cancellation requested')
  }
  return currentJob
}

function isCancelled(): boolean {
  return cancelRequested
}

/** Sleeps in slices so a cancellation does not have to wait out the whole wait. */
async function interruptibleSleep(ms: number): Promise<void> {
  const slice = 500
  let waited = 0
  while (waited < ms) {
    if (isCancelled()) return
    await sleep(Math.min(slice, ms - waited))
    waited += slice
  }
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

  cancelRequested = false
  currentJob = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    processed: 0,
    total: 0,
    report: null,
    error: null,
    cooldownUntil: null,
  }

  // Deliberately not awaited — the caller responds straight away.
  void runIngest({
    ...opts,
    onProgress: (processed, total) => {
      currentJob.processed = processed
      currentJob.total = total
      currentJob.cooldownUntil = null
    },
    onCooldown: (_attempt, waitMs) => {
      currentJob.cooldownUntil = new Date(Date.now() + waitMs).toISOString()
    },
  })
    .then(report => {
      currentJob = {
        ...currentJob,
        status: cancelRequested ? 'cancelled' : 'done',
        finishedAt: new Date().toISOString(),
        report,
      }
      cancelRequested = false
    })
    .catch(err => {
      currentJob = {
        ...currentJob,
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: err?.message ?? 'Ingest failed',
      }
      cancelRequested = false
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
  sourceText: string,
  gate?: GateVerdict,
  check?: VerifyResult
): Promise<{ id: string; title: string; relevance_score: number | null; confidence: string | null } | null> {
  const { data, error } = await supabase
    .from('shorts_cards')
    .insert({
      title: suggestion.title,
      slug: slugify(suggestion.title, urlHash(item.link)),
      summary: suggestion.summary,
      takeaway: suggestion.takeaway || null,
      // Tier drives ordering: high-relevance cards surface first in both the
      // review queue and the public feed.
      // The gate is the authority on category — it saw the same text and its
      // whole job was classification. The generator's guess is a fallback.
      category: gate?.category && gate.category !== 'none' ? gate.category : suggestion.category,
      court: suggestion.court,
      judgment_date: parsePubDate(item.pubDate),
      dedupe_key: dedupeKey(suggestion.title),
      audience: gate?.audience ?? null,
      affects_whom: suggestion.affectsWhom || gate?.affectsWhom || null,
      action_required: suggestion.actionRequired,
      deadline: suggestion.deadline,
      expires_on: gate?.expiresOn ?? suggestion.deadline,
      key_points: suggestion.keyPoints,
      statute_reference: suggestion.statuteReference,
      gate_reason: gate?.reason ?? null,
      relevance_tier: gate?.tier ?? null,
      verified: check?.verified ?? null,
      // Kept so a reviewer sees exactly what the check questioned, rather than
      // a bare pass/fail.
      verifier_notes: check && check.unsupported.length
        ? check.unsupported.map(u => `[${u.severity}] ${u.claim} — ${u.problem}`).join('\n')
        : null,
      confidence_score: suggestion.confidenceScore,
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
  onCooldown?: (attempt: number, waitMs: number) => void
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

  // Drop administrative notices by title before fetching anything. These are
  // the bulk of a regulator feed and none of them is a legal development.
  const beforeFilter = candidates.length
  candidates = candidates.filter(item => {
    if (!isNonStory(item.title)) return true
    report.skipped.push({
      title: item.title.slice(0, 90),
      reason: 'Administrative notice — filtered before fetching.',
    })
    return false
  })
  if (beforeFilter !== candidates.length) {
    logger.info({ filtered: beforeFilter - candidates.length }, 'ingest: administrative notices filtered')
  }
  logger.info({ candidates: candidates.length, target }, 'ingest: candidates after dedupe')
  opts.onProgress?.(0, Math.min(candidates.length, target))

  let processed = 0
  let index = 0
  let cooldowns = 0
  let retryItem: FeedItem | null = null

  // A plain for-of cannot re-serve an item, and after a cooldown we want to
  // retry the one that failed rather than skip it.
  const queue = [...candidates]
  while (queue.length > 0 || retryItem) {
    const item: FeedItem = retryItem ?? queue.shift()!
    retryItem = null
    index += 1
    if (report.proposed >= target) break

    if (isCancelled()) {
      report.stoppedEarly = true
      report.stopReason = 'Stopped by the operator.'
      report.remaining = queue.length
      break
    }

    opts.onProgress?.(report.proposed, target)

    // Pace from the second document onward; the first costs nothing to start.
    if (processed > 0) await interruptibleSleep(pacingMs())
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

      // Second gate, now that we have the body: reject stubs without paying
      // for an LLM call to tell us they are stubs.
      const substance = looksSubstantive(sourceText, item.title)
      if (!substance.ok) {
        report.skipped.push({ title: item.title.slice(0, 90), reason: substance.reason! })
        continue
      }

      // Privacy gate. Enforcement notices against a named person must not
      // become feed cards — see namesPrivateIndividual.
      if (namesPrivateIndividual(sourceText, item.title)) {
        report.skipped.push({
          title: item.title.slice(0, 90),
          reason: 'Names a private individual — enforcement notices are not published',
        })
        continue
      }

      // ── Stage 1: relevance gate ──────────────────────────────────────────
      // A cheap yes/no before the expensive generator. Most regulator items
      // stop here, which is the point — the generator can only ever write a
      // card, so it must not be shown things that should not become one.
      const verdict = await relevanceGate(sourceText, {
        title: item.title,
        sourceName: item.sourceName,
      })

      if (!verdict.cardWorthy) {
        report.skipped.push({
          title: item.title.slice(0, 90),
          reason: `Gate: ${verdict.reason}`,
        })
        continue
      }

      // Near-duplicate check on the normalised headline. Two VRRR notices a
      // day apart are different URLs and the same card, so source_url alone
      // cannot catch them.
      const key = dedupeKey(item.title)
      if (key.length > 12) {
        // Compare against recent keys by token overlap, not equality — the
        // same story rarely arrives with an identical headline.
        const { data: recent } = await supabase
          .from('shorts_cards')
          .select('dedupe_key')
          .not('dedupe_key', 'is', null)
          .order('created_at', { ascending: false })
          .limit(300)

        const twin = (recent ?? []).find(r => isNearDuplicate(key, String(r.dedupe_key)))
        if (twin) {
          report.skipped.push({
            title: item.title.slice(0, 90),
            reason: 'Near-duplicate of an existing card.',
          })
          continue
        }
      }

      // ── Stage 2: card generator ──────────────────────────────────────────
      const result = await summariseSource(sourceText, {
        title: item.title,
        sourceName: item.sourceName,
      })

      if ('skipped' in result) {
        report.skipped.push({ title: item.title.slice(0, 90), reason: result.reason })
        continue
      }

      // The generator's own confidence gates the queue: below 0.75 the audit
      // spec requires mandatory human review, which is where it goes anyway,
      // so it is kept but flagged rather than dropped.
      if (result.unsupportedClaims.length > 0) {
        logger.warn(
          { title: result.title, claims: result.unsupportedClaims },
          'generator self-reported unsupported claims'
        )
      }

      // ── Stage 3: verifier ────────────────────────────────────────────────
      // An independent pass over the generated card. A high-severity finding
      // or a bad citation stops the card here rather than letting a reviewer
      // catch it — or not.
      const check = await verifyCard(result, sourceText)
      if (!check.verified && check.unsupported.some(u => u.severity === 'high')) {
        report.skipped.push({
          title: item.title.slice(0, 90),
          reason: `Verifier: ${check.unsupported.find(u => u.severity === 'high')?.problem ?? 'unsupported claim'}`,
        })
        continue
      }

      const inserted = await insertSuggestion(item, result, sourceText, verdict, check)
      if (inserted) {
        report.suggestions.push(inserted)
        report.proposed += 1
      }
    } catch (err: any) {
      const message = err?.message ?? 'unknown error'

      // A missing key will never fix itself — stop immediately.
      if (/not configured/i.test(message)) {
        report.failed.push({ url: item.link, error: message })
        report.stoppedEarly = true
        report.stopReason = 'Summarisation is not configured.'
        report.remaining = candidates.length - index
        break
      }

      // A rate limit DOES fix itself. Per-minute quotas refill in a minute, so
      // wait it out and retry this same item rather than abandoning the run —
      // that is the difference between four cards and twelve.
      if (/rate limit|unavailable/i.test(message) && cooldowns < MAX_COOLDOWNS) {
        cooldowns += 1
        logger.warn(
          { cooldown: cooldowns, waitMs: COOLDOWN_MS, remaining: candidates.length - index },
          'ingest: quota reached, pausing before retry'
        )
        opts.onCooldown?.(cooldowns, COOLDOWN_MS)
        await interruptibleSleep(COOLDOWN_MS)
        if (isCancelled()) {
          report.stoppedEarly = true
          report.stopReason = 'Stopped by the operator during a quota pause.'
          report.remaining = queue.length + 1
          break
        }
        retryItem = item          // put it back at the front
        continue
      }

      report.failed.push({ url: item.link, error: message })

      if (/rate limit|unavailable/i.test(message)) {
        report.stoppedEarly = true
        report.stopReason = `Summarisation quota reached, and it did not recover after ${MAX_COOLDOWNS} pauses.`
        report.remaining = candidates.length - index
        break
      }
    }
  }

  // Best candidates first, so the editor reads the strongest suggestions while
  // their attention is freshest.
  report.suggestions.sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))

  if (report.stopReason?.startsWith('Stopped by the operator')) {
    report.message = report.proposed > 0
      ? `Stopped. ${report.proposed} suggestion${report.proposed === 1 ? '' : 's'} were saved before you cancelled.`
      : 'Stopped before anything was created.'
  } else if (report.stoppedEarly) {
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
