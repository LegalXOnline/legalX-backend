import { logger } from './logger'

/**
 * Summarisation for the Knowledge Center.
 *
 * Provider-agnostic on purpose: free tiers change often (Google stopped
 * publishing its limits; Meta withdrew Llama), so the provider is an env var
 * rather than a rewrite. Default is gpt-oss-120b on Groq — Apache 2.0 weights,
 * free tier, no card.
 */

export type LlmProvider = 'groq' | 'openrouter'

interface ProviderConfig {
  url: string
  model: string
  apiKey: string | undefined
}

function providerConfig(): ProviderConfig {
  const provider = (process.env.SHORTS_LLM_PROVIDER ?? 'groq') as LlmProvider
  switch (provider) {
    case 'openrouter':
      return {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        model: process.env.SHORTS_LLM_MODEL ?? 'openai/gpt-oss-120b:free',
        apiKey: process.env.OPENROUTER_API_KEY,
      }
    case 'groq':
    default:
      return {
        url: 'https://api.groq.com/openai/v1/chat/completions',
        model: process.env.SHORTS_LLM_MODEL ?? 'openai/gpt-oss-120b',
        apiKey: process.env.GROQ_API_KEY,
      }
  }
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

Respond with ONLY a JSON object, no markdown fence:
{
  "title": "under 90 characters, states what happened, not the case name",
  "summary": "50-70 words: what the issue was and what was decided or announced",
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

async function callLlm(userContent: string): Promise<string> {
  const { url, model, apiKey } = providerConfig()
  if (!apiKey) {
    throw new Error('Summarisation is not configured — set GROQ_API_KEY (or OPENROUTER_API_KEY).')
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      // Low temperature: this is extraction, not composition. Creativity here
      // means inventing holdings that were never in the source.
      temperature: 0.15,
      max_tokens: 1100,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    logger.error({ status: res.status, body: body.slice(0, 300) }, 'LLM request failed')
    if (res.status === 429) throw new Error('Summarisation rate limit reached. Wait a minute and try again.')
    throw new Error(`Summarisation failed (${res.status}).`)
  }

  const payload: any = await res.json()
  const content = payload?.choices?.[0]?.message?.content
  if (!content) throw new Error('Summarisation returned an empty response.')
  return content
}

/**
 * Produces one suggestion from a source document, or skips it.
 *
 * Returns `{ skipped: true }` for anything the model declines or that fails the
 * evidence check. Callers treat that as a normal outcome, not an error — the
 * pipeline is expected to reject a good share of its candidates.
 */
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

  // The load-bearing check. A quote that is not in the source means the
  // summary was not drawn from it.
  if (!verifyEvidence(evidence, text)) {
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
