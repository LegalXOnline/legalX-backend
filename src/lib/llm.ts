import { logger } from './logger'
import { sendProviderFailureAlert } from './email'

/**
 * Summarisation for the Knowledge Center.
 *
 * Provider-agnostic on purpose: free tiers change often (Google stopped
 * publishing its limits; Meta withdrew Llama), so the provider is an env var
 * rather than a rewrite. Default is gpt-oss-120b on Groq — Apache 2.0 weights,
 * free tier, no card.
 */

export type LlmProvider = 'gemini' | 'groq' | 'openrouter'

interface ProviderConfig {
  name: LlmProvider
  model: string
  apiKey: string | undefined
}

function configFor(provider: LlmProvider): ProviderConfig {
  switch (provider) {
    case 'gemini':
      return {
        name: 'gemini',
        model: process.env.SHORTS_GEMINI_MODEL ?? 'gemini-2.5-flash',
        apiKey: process.env.GEMINI_API_KEY,
      }
    case 'openrouter':
      return {
        name: 'openrouter',
        model: process.env.SHORTS_LLM_MODEL ?? 'openai/gpt-oss-120b:free',
        apiKey: process.env.OPENROUTER_API_KEY,
      }
    case 'groq':
    default:
      return {
        name: 'groq',
        model: process.env.SHORTS_LLM_MODEL ?? 'openai/gpt-oss-120b',
        apiKey: process.env.GROQ_API_KEY,
      }
  }
}

/**
 * Provider order: the configured primary, then the fallback.
 *
 * Gemini leads because its free tier allows 1,000,000 tokens per minute against
 * Groq's 8,000 — the difference between summarising a long judgment in one call
 * and not being able to at all. Groq backs it up so an expired Gemini key
 * degrades the pipeline instead of stopping it.
 */
function providerChain(): LlmProvider[] {
  const primary = (process.env.SHORTS_LLM_PROVIDER ?? 'gemini') as LlmProvider
  const fallback = (process.env.SHORTS_LLM_FALLBACK ?? 'groq') as LlmProvider
  return primary === fallback ? [primary] : [primary, fallback]
}

// Groq's free tier allows 8,000 tokens per minute. Long source documents must
// be trimmed or the request is rejected outright. ~4 chars per token of
// English, leaving room for the system prompt and the response.
const MAX_INPUT_CHARS = 18_000
const HEAD_CHARS = 11_000
const TAIL_CHARS = 6_000

/**
 * Trims a document to fit the token budget.
 *
 * Keeps the head (parties, issue, headnote) and the tail (the operative holding
 * or the actual announcement), dropping the middle, which is usually recitation
 * of precedent and submissions. Cutting the tail instead would throw away the
 * conclusion — the one part a summary cannot be written without.
 */
export function trimSource(text: string): { text: string; trimmed: boolean } {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (clean.length <= MAX_INPUT_CHARS) return { text: clean, trimmed: false }
  return {
    text:
      clean.slice(0, HEAD_CHARS) +
      '\n\n[... middle omitted for length ...]\n\n' +
      clean.slice(-TAIL_CHARS),
    trimmed: true,
  }
}

export const CATEGORIES = [
  'Criminal', 'Civil', 'Corporate', 'Family', 'Property',
  'Tax', 'Labour', 'Constitutional', 'Consumer',
] as const

export interface Suggestion {
  title: string
  summary: string
  takeaway: string
  category: string
  court: string | null
  tags: string[]
  /** Verbatim sentence from the source supporting the summary. Verified below. */
  evidence: string
  /** 1–5: how much this matters to an ordinary citizen. */
  relevanceScore: number
  confidence: 'high' | 'medium' | 'low'
  affectsWhom: string
  actionRequired: 'yes' | 'no' | 'conditional'
  deadline: string | null
  keyPoints: string[]
  statuteReference: string | null
  /** 0–1 self-assessment. Below 0.75 forces human review. */
  confidenceScore: number
  /** The model's own list of claims the source does not support. */
  unsupportedClaims: string[]
}

export interface SkippedSuggestion {
  skipped: true
  reason: string
}

/**
 * Statute explainers.
 *
 * Same grounding contract as everything else: the section text is supplied by
 * the caller and the model may only restate it. It must NOT recall the Act from
 * training data — a wrong section number or penalty published under a law
 * firm's name is exactly the failure this whole design exists to prevent.
 */
const STATUTE_PROMPT = `You explain sections of Indian statutes to ordinary citizens on a legal-services platform.

ABSOLUTE RULES — these override everything else:
1. Use ONLY the section text supplied by the user. Never recall the Act from memory, however familiar it looks.
2. Never state a penalty, time limit, threshold or cross-reference that is not written in the supplied text.
3. If the supplied text is a heading, a fragment, or too thin to explain accurately, respond with {"skip": true, "reason": "..."} and nothing else.
4. Never give legal advice or tell the reader what to do in their situation. Explain what the section says.
5. If unsure, skip. A skipped section costs nothing; a wrong one is a liability.

The "evidence" field must be an EXACT substring copied character-for-character from the supplied section text. Do not paraphrase or tidy it.

Write for a reader with no legal training. Explain what the section does, when it applies, and what it requires or forbids.

Respond with ONLY a JSON object, no markdown fence:
{
  "title": "under 90 characters, plain-English statement of what the section does",
  "summary": "150-200 words explaining the section in short paragraphs",
  "takeaway": "1-2 sentences on when this matters to an ordinary person",
  "category": "one of: ${CATEGORIES.join(', ')}",
  "court": null,
  "tags": ["3-5 lowercase topic keywords"],
  "evidence": "text copied EXACTLY from the supplied section",
  "relevanceScore": 1-5,
  "confidence": "high | medium | low"
}`

/**
 * The grounding contract.
 *
 * Hallucination in a legal feed is not a cosmetic problem — a fabricated
 * holding published under a law firm's name is a liability event. Four
 * mechanisms work together here:
 *
 *   1. An explicit instruction to use ONLY the supplied text.
 *   2. A required `evidence` field quoting the source verbatim. This is checked
 *      in code afterwards; an unverifiable quote means the summary was invented,
 *      and the suggestion is discarded before an editor ever sees it.
 *   3. A `skip` escape hatch, so the model has a sanctioned way to decline
 *      rather than inventing something to satisfy the schema.
 *   4. A relevance score, so thin or irrelevant items are filtered automatically.
 */
const SYSTEM_PROMPT = `You write short legal-awareness cards for ordinary Indians. Your reader has no
legal training, is not a banker, and is reading on a phone. They came because
something in their life might be affected.

ABSOLUTE RULES
1. Use ONLY the source text provided. If the text does not state something,
   leave it out. Never add section numbers, Act names, dates, penalty amounts,
   or case names from your own knowledge.
2. Never say what the reader "should" do about their own situation. Explain
   what the rule is and what it requires. Advice is the lawyer's job, not the
   card's.
3. If the source is unclear on a point, say the source does not specify it
   rather than filling the gap.
4. Write in plain English. Any legal term you must use, explain in the same
   sentence in ordinary words.
5. Never use a repealed statute as if it were current. The Indian Penal Code,
   the Code of Criminal Procedure and the Indian Evidence Act were replaced on
   1 July 2024 by the Bharatiya Nyaya Sanhita, the Bharatiya Nagarik Suraksha
   Sanhita and the Bharatiya Sakshya Adhiniyam. If the source text is about a
   repealed law, say so explicitly in the summary.

FIELDS

headline (max 70 characters)
  What changed, in the reader's words. No clickbait, no questions, no
  "Everything you need to know". A person scanning a feed should understand
  the change from the headline alone.

summary (180-220 words)
  What the rule now is and what changed. Concrete over abstract: real numbers,
  real deadlines, real thresholds — but only ones the source states. Lead with
  the change, not the background. No sentence that only restates the headline.

what_it_means (max 200 characters, one or two sentences)
  The single most useful consequence, for a named kind of person. Start with
  who: "If you rent a flat in Delhi..." / "For anyone who has filed a consumer
  complaint...". Never write "no action is required" — if that is the honest
  answer, this item should not have reached you, and you must set
  confidence below 0.3 and say so in unsupported_claims.

affects_whom (max 100 characters)
  The specific group. "Tenants in Maharashtra", not "the general public".

action_required
  "yes" if the reader must do something by a date, "no" if it changes their
  rights without requiring action, "conditional" if only in some situations.

deadline
  YYYY-MM-DD if the source states one, else null. Never invent a date.

key_points (2-4 items, max 90 characters each)
  The facts a reader would want to remember. Each must be traceable to a
  specific statement in the source.

statute_reference
  Exact Act, section, circular, or case name as stated in the source. If the
  source does not name one, use null. Never construct a citation.

evidence
  One sentence copied EXACTLY, character for character, from the source text,
  which supports the summary. Do not paraphrase or tidy it. If you cannot find
  one, set confidence below 0.3.

confidence (0.0-1.0)
  How well the source supports the card as written. Below 0.75 sends it to
  mandatory human review.

unsupported_claims (array, usually empty)
  Any statement in your own output that the source text does not directly
  support. Be honest here — this is the safety net, not a formality. An empty
  array on a card that stretched the source is worse than admitting the stretch.

Return JSON only, with exactly these keys:
{
  "headline": "", "summary": "", "what_it_means": "", "affects_whom": "",
  "action_required": "yes|no|conditional", "deadline": null,
  "key_points": [], "statute_reference": null, "evidence": "",
  "confidence": 0.0, "unsupported_claims": []
}`

/** Strips a ```json fence if the model adds one despite instructions. */
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  return start !== -1 && end > start ? raw.slice(start, end + 1) : raw.trim()
}

/** Collapses whitespace and punctuation variants so quote matching is robust. */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Confirms the model's quote actually appears in the source.
 *
 * This is the load-bearing anti-hallucination check. A model that invents a
 * holding almost always invents the supporting quote too, so a quote that
 * cannot be located is strong evidence the summary is fabricated.
 *
 * Matching is lenient about whitespace and quote characters (models reformat
 * those) but strict about words.
 */
export function verifyEvidence(evidence: string, sourceText: string): boolean {
  if (!evidence || evidence.length < 25) return false
  const needle = normalise(evidence).replace(/^["']|["']$/g, '')
  const haystack = normalise(sourceText)
  if (haystack.includes(needle)) return true

  // Allow a trimmed quote: models often clip a leading clause. Require a long
  // contiguous run to match so this cannot degrade into fuzzy matching.
  const words = needle.split(' ')
  if (words.length >= 12) {
    const window = words.slice(0, 12).join(' ')
    return haystack.includes(window)
  }
  return false
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Marks failures that should trigger a fallback and an ops alert. */
class ProviderUnavailable extends Error {
  constructor(public provider: string, message: string) {
    super(message)
  }
}

// ── Gemini ────────────────────────────────────────────────────────────────────
/**
 * Transient upstream errors — 500, 502, 503, 504.
 *
 * These are not quota problems and say nothing about the key, so falling
 * straight to the backup provider would be wrong; the right move is to wait a
 * moment and ask again. A 503 from Gemini killed a whole run before this.
 */
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504])
const MAX_TRANSIENT_RETRIES = 3

async function callGemini(
  cfg: ProviderConfig,
  userContent: string,
  systemPrompt: string,
  maxTokens?: number,
  attempt = 0
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey! },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      generationConfig: {
        temperature: 0.15,
        // Generous, because on thinking-capable models the reasoning is billed
        // against this budget before any JSON is emitted. Too low and responses
        // arrive truncated, which reads as "malformed output".
        maxOutputTokens: maxTokens ?? 8000,
        // Gemini can enforce the shape server-side, which removes the whole
        // class of "model wrapped the JSON in prose" failures.
        responseMimeType: 'application/json',
        // This task is extraction against a supplied text, not a problem that
        // rewards deliberation. Newer Gemini models think by default and either
        // time out or exhaust the output budget doing it.
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
    signal: AbortSignal.timeout(90_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')

    // Google reports a bad or revoked key as 400 with API_KEY_INVALID, not 401
    // — checking status alone let a dead key fall through as a generic error
    // and never reach the fallback.
    const keyOrQuotaProblem =
      res.status === 401 ||
      res.status === 403 ||
      res.status === 429 ||
      /API_KEY_INVALID|API key not valid|PERMISSION_DENIED|RESOURCE_EXHAUSTED|quota/i.test(body)

    if (keyOrQuotaProblem) {
      throw new ProviderUnavailable('Gemini', `HTTP ${res.status}: ${body.slice(0, 180)}`)
    }
    // Retry transient upstream failures with exponential backoff before
    // giving up on this provider.
    if (TRANSIENT_STATUSES.has(res.status) && attempt < MAX_TRANSIENT_RETRIES) {
      const wait = 2 ** attempt * 1500
      logger.warn({ status: res.status, attempt: attempt + 1, wait }, 'Gemini transient error — retrying')
      await sleep(wait)
      return callGemini(cfg, userContent, systemPrompt, maxTokens, attempt + 1)
    }

    logger.error({ status: res.status, body: body.slice(0, 300) }, 'Gemini request failed')
    // Exhausted retries on a transient error means this provider is not
    // answering — hand over to the fallback rather than failing the run.
    if (TRANSIENT_STATUSES.has(res.status)) {
      throw new ProviderUnavailable('Gemini', `HTTP ${res.status} after ${MAX_TRANSIENT_RETRIES} retries`)
    }
    throw new Error(`Summarisation failed (${res.status}).`)
  }

  const payload: any = await res.json()
  const candidate = payload?.candidates?.[0]
  if (candidate?.finishReason === 'MAX_TOKENS') {
    throw new Error('Summarisation was cut off before completing. Try again.')
  }
  const content = candidate?.content?.parts?.map((p: any) => p.text).join('') ?? ''
  if (!content) throw new ProviderUnavailable('Gemini', 'Empty response')
  return content
}

// ── OpenAI-compatible (Groq, OpenRouter) ──────────────────────────────────────
async function callOpenAiCompatible(
  cfg: ProviderConfig,
  userContent: string,
  systemPrompt: string,
  attempt = 0,
  maxTokens?: number
): Promise<string> {
  const url = cfg.name === 'openrouter'
    ? 'https://openrouter.ai/api/v1/chat/completions'
    : 'https://api.groq.com/openai/v1/chat/completions'

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.15,
      // gpt-oss is a reasoning model: its chain of thought is billed against
      // this budget before a single character of JSON is emitted. Too low and
      // responses arrive truncated mid-string.
      max_tokens: maxTokens ?? 3000,
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  })

  if (res.status === 429) {
    const body = await res.text().catch(() => '')
    // Groq states the exact wait in the error body; honour it rather than
    // guessing. One retry only.
    const waitSeconds = Number(body.match(/try again in ([\d.]+)s/)?.[1] ?? 0)
    if (attempt === 0 && waitSeconds > 0 && waitSeconds < 30) {
      logger.info({ waitSeconds }, 'LLM rate limited — waiting and retrying once')
      await sleep(Math.ceil(waitSeconds * 1000) + 500)
      return callOpenAiCompatible(cfg, userContent, systemPrompt, attempt + 1, maxTokens)
    }
    throw new ProviderUnavailable(cfg.name, 'Rate limit exhausted')
  }

  if (res.status === 401 || res.status === 403) {
    throw new ProviderUnavailable(cfg.name, `HTTP ${res.status} — key rejected`)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')

    if (TRANSIENT_STATUSES.has(res.status) && attempt < MAX_TRANSIENT_RETRIES) {
      const wait = 2 ** attempt * 1500
      logger.warn({ status: res.status, attempt: attempt + 1, wait }, 'LLM transient error — retrying')
      await sleep(wait)
      return callOpenAiCompatible(cfg, userContent, systemPrompt, attempt + 1, maxTokens)
    }

    logger.error({ status: res.status, body: body.slice(0, 300) }, 'LLM request failed')
    if (TRANSIENT_STATUSES.has(res.status)) {
      throw new ProviderUnavailable(cfg.name, `HTTP ${res.status} after ${MAX_TRANSIENT_RETRIES} retries`)
    }
    throw new Error(`Summarisation failed (${res.status}).`)
  }

  const payload: any = await res.json()
  const choice = payload?.choices?.[0]
  const content = choice?.message?.content

  if (choice?.finish_reason === 'length') {
    logger.warn({ model: cfg.model }, 'LLM response hit the token cap and was truncated')
    throw new Error('Summarisation was cut off before completing. Try again.')
  }
  if (!content) throw new Error('Summarisation returned an empty response.')
  return content
}

/**
 * Runs the request against the primary provider, falling back on the secondary
 * if the primary is unavailable.
 *
 * "Unavailable" means a rejected key or an exhausted quota — conditions that
 * will not fix themselves within the run. A transient 5xx is not retried on the
 * fallback, because it says nothing about the primary's health.
 */
/**
 * Runs a prompt through the provider chain.
 *
 * Exported so the relevance gate can reuse the same fallback and alerting
 * without duplicating it, while pointing at a cheaper model.
 */
export async function callModel(
  userContent: string,
  systemPrompt: string,
  opts: { model?: string; maxTokens?: number } = {}
): Promise<string> {
  return callLlm(userContent, systemPrompt, opts)
}

async function callLlm(
  userContent: string,
  systemPrompt = SYSTEM_PROMPT,
  opts: { model?: string; maxTokens?: number } = {}
): Promise<string> {
  const chain = providerChain()
  const configured = chain.map(configFor)
    .map(c => opts.model && c.name === 'gemini' ? { ...c, model: opts.model } : c)
    .filter(c => c.apiKey)

  if (configured.length === 0) {
    throw new Error(
      'Summarisation is not configured — set GEMINI_API_KEY (or GROQ_API_KEY).'
    )
  }

  let lastError: Error | null = null

  for (let i = 0; i < configured.length; i++) {
    const cfg = configured[i]
    try {
      const content = cfg.name === 'gemini'
        ? await callGemini(cfg, userContent, systemPrompt, opts.maxTokens)
        : await callOpenAiCompatible(cfg, userContent, systemPrompt, 0, opts.maxTokens)
      if (i > 0) {
        logger.warn({ provider: cfg.name }, 'summarised via fallback provider')
      }
      return content
    } catch (err: any) {
      lastError = err
      if (!(err instanceof ProviderUnavailable)) throw err

      const next = configured[i + 1]
      logger.error(
        { provider: cfg.name, reason: err.message, fallback: next?.name ?? null },
        'summarisation provider unavailable'
      )
      // Fire-and-forget: an ops email must not delay or fail the ingest run.
      sendProviderFailureAlert({
        provider: cfg.name,
        reason: err.message,
        fallbackProvider: next?.name ?? null,
      }).catch(() => {})
    }
  }

  throw new Error(
    `All summarisation providers are unavailable. Last error: ${lastError?.message ?? 'unknown'}`
  )
}

/**
 * Produces one suggestion from a source document, or skips it.
 *
 * Returns `{ skipped: true }` for anything the model declines or that fails the
 * evidence check. Callers treat that as a normal outcome, not an error — the
 * pipeline is expected to reject a good share of its candidates.
 */
/** Parses and validates a model response against the source it was drawn from. */
function parseSuggestion(content: string, sourceForEvidence: string): Suggestion | SkippedSuggestion {
  let parsed: any
  try {
    parsed = JSON.parse(extractJson(content))
  } catch {
    logger.warn({ content: String(content).slice(0, 300) }, 'LLM returned unparseable JSON')
    return { skipped: true, reason: 'Model returned malformed output.' }
  }

  if (parsed?.skip === true) {
    return { skipped: true, reason: String(parsed.reason ?? 'Model declined to summarise.') }
  }

  // The generator emits `headline`; the statute path still emits `title`.
  const title = String(parsed.headline ?? parsed.title ?? '').trim().slice(0, 255)
  const summary = String(parsed.summary ?? '').trim()
  const takeaway = String(parsed.what_it_means ?? parsed.takeaway ?? '').trim()
  const evidence = String(parsed.evidence ?? '').trim()

  if (!title || !summary) {
    return { skipped: true, reason: 'Model produced no headline or summary.' }
  }

  const confidenceScore = Number(parsed.confidence)
  const score = Number.isFinite(confidenceScore) ? Math.min(1, Math.max(0, confidenceScore)) : 0.5

  const unsupported = Array.isArray(parsed.unsupported_claims)
    ? parsed.unsupported_claims.map((c: unknown) => String(c)).filter(Boolean)
    : []

  // The prompt requires the model to flag this itself when the honest answer
  // is "nothing changes for you". Trust it and drop the card.
  if (/no (immediate )?action (is )?required/i.test(takeaway)) {
    return { skipped: true, reason: 'Card states no action is required — not useful to a reader.' }
  }

  if (score < 0.3) {
    return { skipped: true, reason: `Model reported confidence ${score.toFixed(2)} — too low to keep.` }
  }

  if (!verifyEvidence(evidence, sourceForEvidence)) {
    logger.warn({ title, evidence: evidence.slice(0, 120) }, 'evidence not found in source — discarding')
    return {
      skipped: true,
      reason: 'Supporting quote could not be located in the source — possible fabrication.',
    }
  }

  const action = ['yes', 'no', 'conditional'].includes(parsed.action_required)
    ? parsed.action_required : 'no'

  return {
    title,
    summary,
    takeaway,
    // Category is decided by the gate, which sees the same text and is the
    // single authority on it. Anything here is a placeholder the caller
    // overwrites.
    category: String(parsed.category ?? 'money_consumer'),
    court: parsed.court ? String(parsed.court).trim().slice(0, 150) : null,
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.slice(0, 6).map((t: unknown) => String(t).toLowerCase().trim()).filter(Boolean)
      : [],
    evidence,
    // Map the 0–1 self-assessment onto the 1–5 scale the queue sorts by.
    relevanceScore: Math.max(1, Math.min(5, Math.round(score * 5))),
    confidence: score >= 0.85 ? 'high' : score >= 0.75 ? 'medium' : 'low',
    affectsWhom: String(parsed.affects_whom ?? '').slice(0, 100),
    actionRequired: action,
    deadline: typeof parsed.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.deadline)
      ? parsed.deadline : null,
    keyPoints: Array.isArray(parsed.key_points)
      ? parsed.key_points.slice(0, 4).map((k: unknown) => String(k).slice(0, 90)).filter(Boolean)
      : [],
    statuteReference: parsed.statute_reference ? String(parsed.statute_reference).slice(0, 200) : null,
    confidenceScore: score,
    unsupportedClaims: unsupported,
  }
}

/** Explains one statutory section, grounded strictly in the supplied text. */
export async function explainStatuteSection(input: {
  actName: string
  sectionNumber: string
  sectionHeading?: string
  sectionText: string
}): Promise<Suggestion | SkippedSuggestion> {
  const { text } = trimSource(input.sectionText)
  if (text.length < 200) {
    return { skipped: true, reason: 'Section text too short to explain reliably.' }
  }

  const content = await callLlm(
    `ACT: ${input.actName}
SECTION: ${input.sectionNumber}` +
    (input.sectionHeading ? `
HEADING: ${input.sectionHeading}` : '') +
    `

---

${text}`,
    STATUTE_PROMPT
  )
  return parseSuggestion(content, text)
}

export async function summariseSource(
  sourceText: string,
  context?: { title?: string; sourceName?: string }
): Promise<Suggestion | SkippedSuggestion> {
  const { text, trimmed } = trimSource(sourceText)
  if (text.length < 250) {
    return { skipped: true, reason: 'Source text too short to summarise reliably.' }
  }

  const header = [
    context?.title ? `HEADLINE: ${context.title}` : null,
    context?.sourceName ? `SOURCE: ${context.sourceName}` : null,
    trimmed ? 'NOTE: this document was truncated for length.' : null,
  ].filter(Boolean).join('\n')

  const content = await callLlm(`${header}\n\n---\n\n${text}`)
  return parseSuggestion(content, text)
}

// ── Stage 3: verifier ─────────────────────────────────────────────────────────
const VERIFIER_PROMPT = `You are checking a generated card against its source text. You are not
improving the card. You are finding what it claims that the source does not
support.

You will receive SOURCE TEXT and CARD JSON.

For every factual statement in the card — every number, date, threshold,
section number, name, and every cause-and-effect claim — locate the exact
sentence in the source that supports it.

Flag a claim as unsupported when it is:
- absent from the source
- stated more strongly than the source states it ("must" where the source
  says "may"; "all" where the source says "certain")
- a consequence the source does not draw
- a citation, date, or figure the source does not contain

Do not flag: plain-language rewording that preserves meaning, or ordinary
summarisation that drops detail without changing it.

Return JSON only:
{
  "verified": true | false,
  "unsupported": [
    {"claim": "<quote from card>", "problem": "<why>",
     "severity": "high|medium|low"}
  ],
  "citation_ok": true | false,
  "confidence": 0.0
}

verified is false if any unsupported item has severity "high", or if
citation_ok is false.`

export interface VerdictIssue {
  claim: string
  problem: string
  severity: 'high' | 'medium' | 'low'
}

export interface VerifyResult {
  verified: boolean
  unsupported: VerdictIssue[]
  citationOk: boolean
  confidence: number
}

/**
 * Independent check of a generated card against its source.
 *
 * A separate call on purpose: the generator has already committed to its
 * output, and asking it to mark its own work invites agreement. This is the
 * cheapest insurance a legal product has — one extra model call against the
 * cost of publishing a fabricated holding.
 *
 * Failing open would defeat the point, so an unreadable verdict counts as
 * unverified.
 */
export async function verifyCard(
  card: Suggestion,
  sourceText: string
): Promise<VerifyResult> {
  const { text } = trimSource(sourceText)

  const payload = {
    headline: card.title,
    summary: card.summary,
    what_it_means: card.takeaway,
    key_points: card.keyPoints,
    statute_reference: card.statuteReference,
    deadline: card.deadline,
  }

  try {
    const raw = await callLlm(
      `SOURCE TEXT:\n${text}\n\n---\n\nCARD JSON:\n${JSON.stringify(payload, null, 2)}`,
      VERIFIER_PROMPT,
      { maxTokens: 1200 }
    )
    const parsed = JSON.parse(extractJson(raw))

    const unsupported: VerdictIssue[] = Array.isArray(parsed.unsupported)
      ? parsed.unsupported.map((u: any) => ({
          claim: String(u.claim ?? '').slice(0, 300),
          problem: String(u.problem ?? '').slice(0, 300),
          severity: ['high', 'medium', 'low'].includes(u.severity) ? u.severity : 'medium',
        }))
      : []

    const citationOk = parsed.citation_ok !== false
    const hasHigh = unsupported.some(u => u.severity === 'high')

    return {
      // Recomputed rather than trusted: the contract says a high-severity
      // finding means unverified, so enforce it here.
      verified: parsed.verified === true && !hasHigh && citationOk,
      unsupported,
      citationOk,
      confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0,
    }
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'verifier failed — treating card as unverified')
    return {
      verified: false,
      unsupported: [{ claim: '(verifier unavailable)', problem: String(err?.message ?? 'unknown'), severity: 'medium' }],
      citationOk: false,
      confidence: 0,
    }
  }
}

/** URL-safe slug, with a short suffix so two similar titles cannot collide. */
export function slugify(title: string, suffix: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
    .replace(/^-|-$/g, '')
  return `${base || 'update'}-${suffix}`
}
