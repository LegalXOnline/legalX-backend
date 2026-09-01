import { logger } from './logger'

/**
 * Summarisation for the legal-shorts pipeline.
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

// Groq's free tier allows 8,000 tokens per minute. A Supreme Court judgment
// routinely runs 20k–60k tokens, so the input MUST be trimmed or the very first
// real request is rejected. ~4 chars per token of English, and we leave room
// for the system prompt and the response.
const MAX_INPUT_CHARS = 18_000
const HEAD_CHARS = 11_000
const TAIL_CHARS = 6_000

/**
 * Trims a judgment to fit the token budget.
 *
 * Keeps the head (parties, issues framed, headnote) and the tail (the operative
 * holding and directions), dropping the middle, which is usually recitation of
 * precedent and submissions. Cutting the tail instead would throw away the
 * ruling itself — the one part a summary cannot be written without.
 */
export function trimJudgment(text: string): { text: string; trimmed: boolean } {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (clean.length <= MAX_INPUT_CHARS) return { text: clean, trimmed: false }

  return {
    text:
      clean.slice(0, HEAD_CHARS) +
      '\n\n[... middle of judgment omitted for length ...]\n\n' +
      clean.slice(-TAIL_CHARS),
    trimmed: true,
  }
}

export interface ShortSummary {
  title: string
  summary: string
  takeaway: string
  category: string
  court: string | null
  tags: string[]
}

const CATEGORIES = [
  'Criminal', 'Civil', 'Corporate', 'Family', 'Property',
  'Tax', 'Labour', 'Constitutional', 'Consumer',
] as const

const SYSTEM_PROMPT = `You summarise Indian court judgments for a general audience on a legal-services platform.

Rules:
- Report only what the judgment actually says. Never infer, extrapolate, or add legal advice.
- If the text is truncated and the holding is unclear, say so in the summary rather than guessing.
- Plain English. No Latin unless the judgment turns on the term, and then gloss it.
- Neutral and factual. No opinion on whether the court was right.

Respond with ONLY a JSON object, no markdown fence:
{
  "title": "under 90 characters, states the holding, not the case name",
  "summary": "3-4 sentences: what was disputed, what the court held, and why",
  "takeaway": "1-2 sentences on the practical effect for an ordinary person",
  "category": "one of: ${CATEGORIES.join(', ')}",
  "court": "the deciding court, or null if not stated",
  "tags": ["3-5 lowercase topic keywords"]
}`

/** Strips a ```json fence if the model adds one despite instructions. */
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  return start !== -1 && end > start ? raw.slice(start, end + 1) : raw.trim()
}

export async function summariseJudgment(judgmentText: string): Promise<ShortSummary> {
  const { url, model, apiKey } = providerConfig()
  if (!apiKey) {
    throw new Error('Summarisation is not configured — set GROQ_API_KEY (or OPENROUTER_API_KEY).')
  }

  const { text, trimmed } = trimJudgment(judgmentText)
  if (text.length < 200) {
    throw new Error('Judgment text is too short to summarise (minimum 200 characters).')
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      // Low temperature: this is extraction, not composition. Creativity here
      // means inventing holdings that were never in the judgment.
      temperature: 0.2,
      max_tokens: 900,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `${trimmed ? 'NOTE: this judgment was truncated for length.\n\n' : ''}${text}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    logger.error({ status: res.status, body: body.slice(0, 300) }, 'LLM request failed')
    if (res.status === 429) {
      throw new Error('Summarisation rate limit reached. Wait a minute and try again.')
    }
    throw new Error(`Summarisation failed (${res.status}).`)
  }

  const payload: any = await res.json()
  const content = payload?.choices?.[0]?.message?.content
  if (!content) throw new Error('Summarisation returned an empty response.')

  let parsed: any
  try {
    parsed = JSON.parse(extractJson(content))
  } catch {
    logger.error({ content: String(content).slice(0, 300) }, 'LLM returned unparseable JSON')
    throw new Error('Summarisation returned malformed output. Try again.')
  }

  const category = CATEGORIES.includes(parsed.category) ? parsed.category : 'Civil'

  const result: ShortSummary = {
    title: String(parsed.title ?? '').trim().slice(0, 255),
    summary: String(parsed.summary ?? '').trim(),
    takeaway: String(parsed.takeaway ?? '').trim(),
    category,
    court: parsed.court ? String(parsed.court).trim().slice(0, 150) : null,
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.slice(0, 6).map((t: unknown) => String(t).toLowerCase().trim()).filter(Boolean)
      : [],
  }

  if (!result.title || !result.summary) {
    throw new Error('Summarisation produced no title or summary.')
  }
  return result
}

/** URL-safe slug, with a short suffix so two similar holdings cannot collide. */
export function slugify(title: string, suffix: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
    .replace(/^-|-$/g, '')
  return `${base || 'judgment'}-${suffix}`
}
