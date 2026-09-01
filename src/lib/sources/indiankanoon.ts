import { logger } from '../logger'

/**
 * Indian Kanoon API client.
 *
 * Used instead of scraping because every official portal (sci.gov.in,
 * judgments.ecourts.gov.in) gates search behind a captcha. Section 52(1)(q)(iv)
 * exempts judgments from copyright, but that is not permission to defeat an
 * access control — so we go through a licensed API instead.
 *
 * Billing is pre-paid: if the balance runs out the API returns no results
 * rather than erroring loudly, which is why callers must treat an empty `docs`
 * array as a condition worth logging.
 */

const BASE_URL = 'https://api.indiankanoon.org'

export interface IkSearchDoc {
  tid: number
  title: string
  publishdate: string | null
  docsource: string | null
  headline?: string
}

export interface IkDocument {
  tid: number
  title: string
  text: string
  publishdate: string | null
  docsource: string | null
  url: string
}

function apiKey(): string {
  const key = process.env.INDIANKANOON_API_KEY
  if (!key) {
    throw new Error('Indian Kanoon is not configured — set INDIANKANOON_API_KEY.')
  }
  return key
}

/** Every Indian Kanoon endpoint is POST, with parameters in the query string. */
async function ikPost<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString()

  const res = await fetch(`${BASE_URL}${path}${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey()}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(45_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    logger.error({ status: res.status, path, body: body.slice(0, 300) }, 'Indian Kanoon request failed')
    if (res.status === 401 || res.status === 403) {
      throw new Error('Indian Kanoon rejected the API key.')
    }
    throw new Error(`Indian Kanoon request failed (${res.status}).`)
  }

  const json = (await res.json()) as any
  // The API reports failures in-band rather than by status code.
  if (json?.errmsg) throw new Error(`Indian Kanoon: ${json.errmsg}`)
  return json as T
}

/** `d-m-YYYY`, the format Indian Kanoon's date filters expect. */
function ikDate(d: Date): string {
  return `${d.getUTCDate()}-${d.getUTCMonth() + 1}-${d.getUTCFullYear()}`
}

export interface SearchOptions {
  /** Raw Indian Kanoon query, e.g. `doctypes:supremecourt`. */
  query: string
  /** Restrict to judgments published in the last N days. */
  withinDays?: number
  pagenum?: number
}

export async function searchJudgments(opts: SearchOptions): Promise<IkSearchDoc[]> {
  let formInput = opts.query

  if (opts.withinDays && opts.withinDays > 0) {
    const to = new Date()
    const from = new Date(Date.now() - opts.withinDays * 86_400_000)
    formInput += ` fromdate:${ikDate(from)} todate:${ikDate(to)}`
  }

  const data = await ikPost<{ docs?: IkSearchDoc[]; found?: string }>('/search/', {
    formInput,
    pagenum: opts.pagenum ?? 0,
  })

  const docs = data.docs ?? []
  if (docs.length === 0) {
    logger.warn({ formInput }, 'Indian Kanoon returned no documents — check query or prepaid balance')
  }
  return docs
}

/** Strips the HTML Indian Kanoon returns in `doc` down to plain text. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|br|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function fetchDocument(tid: number): Promise<IkDocument> {
  // maxcites/maxcitedby are set to 0: citation graphs cost extra and the
  // summariser never uses them.
  const data = await ikPost<any>(`/doc/${tid}/`, { maxcites: 0, maxcitedby: 0 })

  const text = htmlToText(String(data.doc ?? ''))
  if (text.length < 200) {
    throw new Error(`Indian Kanoon document ${tid} returned no usable text.`)
  }

  return {
    tid,
    title: String(data.title ?? '').trim(),
    text,
    publishdate: data.publishdate ?? null,
    docsource: data.docsource ?? null,
    // Canonical public citation link, shown as "Full judgment" on the card.
    url: `https://indiankanoon.org/doc/${tid}/`,
  }
}

/**
 * Curated feeds.
 *
 * Judgment feeds surface what changed recently; the citizen-rights feeds are
 * evergreen statute topics that give the daily mix something practical
 * alongside case law.
 */
export const FEEDS: Record<string, { label: string; query: string; withinDays?: number }> = {
  supreme_court: {
    label: 'Supreme Court — recent',
    query: 'doctypes:supremecourt',
    withinDays: 7,
  },
  high_courts: {
    label: 'High Courts — recent',
    query: 'doctypes:highcourts',
    withinDays: 3,
  },
  consumer: {
    label: 'Consumer rights',
    query: 'Consumer Protection Act deficiency in service',
    withinDays: 90,
  },
  traffic: {
    label: 'Traffic & motor vehicles',
    query: 'Motor Vehicles Act compensation accident claim',
    withinDays: 90,
  },
  bns: {
    label: 'BNS / criminal law',
    query: 'Bharatiya Nyaya Sanhita',
    withinDays: 180,
  },
  tenancy: {
    label: 'Rent & tenancy',
    query: 'landlord tenant eviction rent control',
    withinDays: 90,
  },
  employment: {
    label: 'Employment rights',
    query: 'wrongful termination employee wages gratuity',
    withinDays: 90,
  },
}
