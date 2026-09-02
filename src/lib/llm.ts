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
const SYSTEM_PROMPT = `You summarise Indian legal and government material for ordinary citizens on a legal-services platform.

ABSOLUTE RULES — these override everything else:
1. Use ONLY the text supplied by the user. Never add facts from your own knowledge, however confident you are.
2. Never state a legal holding, section number, penalty, date or amount that does not appear verbatim in the supplied text.
3. If the text is truncated, boilerplate, a navigation page, or too thin to summarise accurately, respond with {"skip": true, "reason": "..."} and nothing else.
4. Never give legal advice, predict outcomes, or tell the reader what they should do. Describe what the source says.
5. If you are unsure whether something is accurate, skip it. A skipped item costs nothing; a wrong one is a liability.

You must quote the source. The "evidence" field must be an EXACT substring copied character-for-character from the supplied text — one sentence that supports your summary. Do not paraphrase it, do not fix its grammar, do not add ellipses. If you cannot find such a sentence, skip the item.

Write for a reader with no legal training. Plain English, short sentences, no Latin unless the source turns on the term and you gloss it.

The summary must be 150-200 words. If the source does not contain enough substance to support 150 words without padding or repetition, skip the item rather than stretching it.

Respond with ONLY a JSON object, no markdown fence:
{
  "title": "under 90 characters, states what happened, not the case name",
  "summary": "150-200 words: the background, what was decided or announced, the reasoning, and who it affects. Write in short paragraphs, not one block.",
  "takeaway": "1-2 sentences on the practical effect for an ordinary person",
  "category": "one of: ${CATEGORIES.join(', ')}",
  "court": "the deciding court or issuing body, or null",
  "tags": ["3-5 lowercase topic keywords"],
  "evidence": "one sentence copied EXACTLY from the supplied text",
  "relevanceScore": 1-5,
  "confidence": "high | medium | low"
}

relevanceScore: 5 = affects most citizens directly (a new consumer right, a traffic penalty change). 1 = of interest only to specialists (a procedural direction, a corporate merger approval).`

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
async function callGemini(cfg: ProviderConfig, userContent: string, systemPrompt: string): Promise<string> {
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
        maxOutputTokens: 8000,
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
    logger.error({ status: res.status, body: body.slice(0, 300) }, 'Gemini request failed')
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
  attempt = 0
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
      max_tokens: 3000,
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
      return callOpenAiCompatible(cfg, userContent, systemPrompt, attempt + 1)
    }
    throw new ProviderUnavailable(cfg.name, 'Rate limit exhausted')
  }

  if (res.status === 401 || res.status === 403) {
    throw new ProviderUnavailable(cfg.name, `HTTP ${res.status} — key rejected`)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    logger.error({ status: res.status, body: body.slice(0, 300) }, 'LLM request failed')
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
async function callLlm(userContent: string, systemPrompt = SYSTEM_PROMPT): Promise<string> {
  const chain = providerChain()
  const configured = chain.map(configFor).filter(c => c.apiKey)

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
        ? await callGemini(cfg, userContent, systemPrompt)
        : await callOpenAiCompatible(cfg, userContent, systemPrompt)
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

  const title = String(parsed.title ?? '').trim().slice(0, 255)
  const summary = String(parsed.summary ?? '').trim()
  const evidence = String(parsed.evidence ?? '').trim()

  if (!title || !summary) {
    return { skipped: true, reason: 'Model produced no title or summary.' }
  }

  if (!verifyEvidence(evidence, sourceForEvidence)) {
    logger.warn({ title, evidence: evidence.slice(0, 120) }, 'evidence not found in source — discarding suggestion')
    return {
      skipped: true,
      reason: 'Supporting quote could not be located in the source — possible fabrication.',
    }
  }

  const relevance = Number(parsed.relevanceScore)
  const confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low'

  return {
    title,
    summary,
    takeaway: String(parsed.takeaway ?? '').trim(),
    category: (CATEGORIES as readonly string[]).includes(parsed.category) ? parsed.category : 'Civil',
    court: parsed.court ? String(parsed.court).trim().slice(0, 150) : null,
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.slice(0, 6).map((t: unknown) => String(t).toLowerCase().trim()).filter(Boolean)
      : [],
    evidence,
    relevanceScore: Number.isFinite(relevance) ? Math.min(5, Math.max(1, Math.round(relevance))) : 3,
    confidence,
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
