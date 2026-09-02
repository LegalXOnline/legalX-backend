import { logger } from './logger'
import { callModel, trimSource } from './llm'

/**
 * Stage 1 — the relevance gate.
 *
 * The generator could never decline. Told "write a card about this press
 * release", it wrote one — for VRRR auctions, forex reserves, staff
 * appointments alike. Relevance was never actually asked, so every RBI release
 * became a card and the feed filled with material addressed to banks.
 *
 * This is a separate, cheaper call whose only job is yes/no. It defaults to
 * reject, and roughly 80% of a regulator feed should stop here — that is the
 * intent, not a failure. The expensive generator then only ever sees items
 * that earned it.
 */

export const CATEGORIES = [
  'property_rent',
  'family_marriage',
  'money_consumer',
  'crime_safety',
  'business_compliance',
  'cyber_online',
] as const

export type Category = (typeof CATEGORIES)[number]

export const CATEGORY_LABELS: Record<Category, string> = {
  property_rent:       'Property & Rent',
  family_marriage:     'Family & Marriage',
  money_consumer:      'Money & Consumer',
  crime_safety:        'Crime & Safety',
  business_compliance: 'Business & Compliance',
  cyber_online:        'Cyber & Online',
}

export type RelevanceTier = 'high' | 'moderate' | 'reject'

export interface GateVerdict {
  cardWorthy: boolean
  /**
   * high     — changes what someone can do, must do, or is entitled to.
   * moderate — real legal or regulatory news worth knowing, but not directly
   *            actionable by the reader today.
   * reject   — institution-facing operations, macro statistics, admin.
   */
  tier: RelevanceTier
  reason: string
  audience: 'public' | 'institution' | 'mixed'
  category: Category | 'none'
  affectsWhom: string
  timeBound: boolean
  expiresOn: string | null
}

const GATE_PROMPT = `You are a relevance filter for a legal awareness feed read by ordinary Indian
citizens and small business owners. You sort each item into one of three tiers.

TIERS

"high" — it changes what an ordinary individual or small business owner can do,
must do, is entitled to, or must pay, in a way they could act on. You can name
a specific person and a specific action.

"moderate" — genuine legal or regulatory news that an ordinary reader would find
worth knowing, but which does not require or enable action from them today.
A ruling that settles a point of law, a new rule taking effect later, an
enforcement action that shows how a law is applied, a change affecting a trade
or profession. It must still be ABOUT law, rights, obligations or enforcement —
not about markets, statistics, or an institution's own plumbing.

"reject" — everything else. When in doubt between moderate and reject, reject.

ALWAYS "reject" — never card-worthy, no matter how newsworthy:
- Monetary policy operations: repo, reverse repo, VRRR, OMO, LAF, SDF, bond
  auctions, liquidity adjustment, T-bill issuance
- Macro statistics: balance of payments, current account deficit, forex
  reserves, GDP, IIP, WPI/CPI prints, FDI inflow data
- Documents addressed to banks, NBFCs, primary dealers, or market participants
  about their own operations
- A regulator's internal administration: staff appointments, office moves,
  organisational structure, its own service SLAs, annual report releases
- Conference speeches, inaugurations, MoUs, awards, obituaries
- Draft or discussion papers not yet in force
- Anything whose practical takeaway is "no action is required by individuals"

"high" — only if it clearly does one of these for an ordinary person:
- Creates, changes, or removes a legal right, protection, or entitlement
- Creates or changes an obligation, deadline, penalty, fee, or tax
- Changes how a person files, claims, complains, registers, or appeals
- Changes limits on liability, compensation, or refunds
- Brings a new law, amendment, or rule into force, or repeals one
- A court ruling that changes the outcome of disputes ordinary people have
- A new grievance, redressal, or reporting mechanism people can use

DECIDING
Ask, in order:
1. Is this about law, rights, obligations, or enforcement at all?
   No → "reject".
2. Who is the audience — the public, or an institution about its own
   operations? Institution only → "reject".
3. Can you name a concrete person and a concrete action they would take now?
   Yes → "high".
4. Would an ordinary reader still find it worth knowing, even with no action
   to take? Yes → "moderate". No → "reject".

Judge only what the text says. Do not use outside knowledge to make an item
sound more relevant than it is. Do not infer consequences the text does not
state.

Return JSON only:
{
  "tier": "high" | "moderate" | "reject",
  "reason": "<one sentence, name the person and action, or why there is none>",
  "audience": "public" | "institution" | "mixed",
  "category": "property_rent" | "family_marriage" | "money_consumer" |
              "crime_safety" | "business_compliance" | "cyber_online" | "none",
  "affects_whom": "<who specifically, or empty if rejected>",
  "time_bound": true | false,
  "expires_on": "<YYYY-MM-DD if it stops mattering after a date, else null>"
}

If tier is "reject", category must be "none".`

/** Cheapest model available — this call is a yes/no, not composition. */
function gateModel(): string {
  return process.env.SHORTS_GATE_MODEL ?? 'gemini-2.5-flash-lite'
}

function parseDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

export async function relevanceGate(
  text: string,
  context?: { title?: string; sourceName?: string }
): Promise<GateVerdict> {
  const { text: trimmed } = trimSource(text)

  const header = [
    context?.title ? `HEADLINE: ${context.title}` : null,
    context?.sourceName ? `SOURCE: ${context.sourceName}` : null,
  ].filter(Boolean).join('\n')

  const raw = await callModel(
    `${header}\n\n---\n\n${trimmed}`,
    GATE_PROMPT,
    { model: gateModel(), maxTokens: 700 }
  )

  let parsed: any
  try {
    parsed = JSON.parse(raw.replace(/```(?:json)?/g, '').trim())
  } catch {
    logger.warn({ raw: raw.slice(0, 200) }, 'gate returned unparseable JSON — rejecting')
    // An unreadable verdict is not a pass. Failing closed is the whole point
    // of a gate.
    return {
      cardWorthy: false, tier: 'reject', reason: 'Gate response could not be parsed.',
      audience: 'institution', category: 'none', affectsWhom: '',
      timeBound: false, expiresOn: null,
    }
  }

  const tier: RelevanceTier =
    ['high', 'moderate', 'reject'].includes(parsed.tier) ? parsed.tier : 'reject'
  const cardWorthy = tier !== 'reject'
  const category = CATEGORIES.includes(parsed.category) ? parsed.category as Category : 'none'

  return {
    cardWorthy,
    tier,
    reason: String(parsed.reason ?? '').slice(0, 300),
    audience: ['public', 'institution', 'mixed'].includes(parsed.audience) ? parsed.audience : 'institution',
    // The contract says a rejected item has no category; enforce it rather
    // than trusting the model to remember.
    category: cardWorthy ? (category === 'none' ? 'money_consumer' : category) : 'none',
    affectsWhom: cardWorthy ? String(parsed.affects_whom ?? '').slice(0, 100) : '',
    timeBound: parsed.time_bound === true,
    expiresOn: parseDate(parsed.expires_on),
  }
}

/**
 * Expansions for abbreviations that make the same story look like two.
 * "VRRR auction" and "variable rate reverse repo auction" are one item.
 */
const ABBREVIATIONS: [RegExp, string][] = [
  [/\bvrrr\b/g, 'variable rate reverse repo'],
  [/\bvrr\b/g, 'variable rate repo'],
  [/\bomo\b/g, 'open market operation'],
  [/\blaf\b/g, 'liquidity adjustment facility'],
  [/\bsdf\b/g, 'standing deposit facility'],
  [/\bmsf\b/g, 'marginal standing facility'],
  [/\bcad\b/g, 'current account deficit'],
  [/\bbop\b/g, 'balance of payments'],
  [/\bgst\b/g, 'goods and services tax'],
  [/\bt-?bill\b/g, 'treasury bill'],
]

/**
 * Normalised headline used to catch near-duplicates.
 *
 * A UNIQUE source_url cannot stop two VRRR auction notices published a day
 * apart: different URLs, effectively the same card. Dates, figures, ordinals
 * and stop words are stripped, and abbreviations expanded, so what remains is
 * the shape of the story.
 */
export function dedupeKey(title: string): string {
  let t = title.toLowerCase()
  for (const [re, full] of ABBREVIATIONS) t = t.replace(re, full)

  return t
    .replace(/\b\d{1,2}[-/ ](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-/ ]?\d{0,4}\b/gi, ' ')
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s*\d{0,4}\b/gi, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b(?:first|second|third|fourth|fifth|q[1-4])\b/g, ' ')
    .replace(/[₹$]?[\d,.]+(?:\s*(?:crore|lakh|billion|million|bn|mn))?/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\b(?:the|a|an|of|on|in|for|to|and|as|at|by|with|its|it)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Whether two normalised headlines describe the same story.
 *
 * Token overlap rather than string equality: an exact key match missed
 * "schedules overnight VRRR auction" against "schedules overnight variable
 * rate reverse repo auction" even after expansion, because one carries extra
 * words. Jaccard over the smaller set is tolerant of that without collapsing
 * genuinely different items.
 */
export function isNearDuplicate(a: string, b: string, threshold = 0.7): boolean {
  const setA = new Set(a.split(' ').filter(w => w.length > 2))
  const setB = new Set(b.split(' ').filter(w => w.length > 2))
  if (setA.size < 3 || setB.size < 3) return false

  let shared = 0
  for (const w of setA) if (setB.has(w)) shared++

  return shared / Math.min(setA.size, setB.size) >= threshold
}
