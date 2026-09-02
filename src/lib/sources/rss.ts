import { logger } from '../logger'

/**
 * RSS / article ingestion for the Knowledge Center.
 *
 * Sources are configured here rather than hardcoded into the pipeline so the
 * list can be tuned without a code change, and so each one carries its own
 * licence note. Only add feeds whose content may lawfully be summarised and
 * republished — government releases and official notifications. Commercial
 * legal-news sites (Live Law, Bar & Bench, SCC Online) publish original
 * editorial work that is copyrighted; summarising their articles and
 * republishing is infringement regardless of attribution.
 */

export interface FeedSource {
  id: string
  label: string
  url: string
  /** Shown on the public card as provenance. */
  sourceName: string
  enabled: boolean
  /** Why this source is lawful to summarise — kept next to the URL on purpose. */
  licenceNote: string
}

export const FEED_SOURCES: FeedSource[] = [
  {
    id: 'rbi_press',
    label: 'RBI — Press releases',
    url: 'https://www.rbi.org.in/pressreleases_rss.xml',
    sourceName: 'Reserve Bank of India',
    enabled: true,
    licenceNote: 'Regulator press releases, published for public dissemination.',
  },
  {
    id: 'sebi',
    label: 'SEBI — Press releases',
    url: 'https://www.sebi.gov.in/sebirss.xml',
    sourceName: 'Securities and Exchange Board of India',
    enabled: true,
    licenceNote: 'Regulator press releases, published for public dissemination.',
  },
  {
    // Disabled: PIB returns 403 to any non-browser User-Agent. It publishes no
    // robots.txt disallowing crawlers, so this is a blanket WAF filter rather
    // than a stated policy — enable it only after setting SHORTS_USER_AGENT,
    // and knowing that is what you are doing.
    id: 'pib_all',
    label: 'PIB — Government press releases (403s our crawler)',
    url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3',
    sourceName: 'Press Information Bureau',
    enabled: false,
    licenceNote: 'Blocked: returns 403 unless SHORTS_USER_AGENT is set to a browser string.',
  },
]

/**
 * Identifies this crawler. Several Indian government sites (pib.gov.in,
 * indiacode.nic.in) return 403 to any User-Agent that is not a known browser —
 * a blanket WAF filter, not a stated policy: neither publishes a robots.txt
 * that disallows crawling.
 *
 * The default is honest and contactable. Overriding it via env is a deliberate
 * decision for the operator to make, not one this code makes silently.
 */
const USER_AGENT = process.env.SHORTS_USER_AGENT ?? 'LegalXOnline/1.0 (+https://legalxonline.com)'

export interface FeedItem {
  title: string
  link: string
  description?: string
  pubDate?: string
  sourceName: string
  sourceFeed: string
}

/** Minimal RSS/Atom parse. Avoids a dependency for what is a handful of tags. */
function parseFeed(xml: string, source: FeedSource): FeedItem[] {
  const items: FeedItem[] = []
  // Handles both RSS <item> and Atom <entry>.
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) ?? []

  for (const block of blocks) {
    const pick = (tag: string): string | undefined => {
      const cdata = block.match(new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, 'i'))
      if (cdata) return cdata[1].trim()
      const plain = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
      return plain ? decodeEntities(plain[1].trim()) : undefined
    }

    const title = pick('title')
    // Atom puts the URL in an attribute rather than the element body.
    const link = pick('link') ?? block.match(/<link[^>]*href="([^"]+)"/i)?.[1]
    if (!title || !link) continue

    items.push({
      title,
      link: link.trim(),
      description: pick('description') ?? pick('summary'),
      pubDate: pick('pubDate') ?? pick('published') ?? pick('updated'),
      sourceName: source.sourceName,
      sourceFeed: source.id,
    })
  }
  return items
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}

export async function fetchFeed(source: FeedSource): Promise<FeedItem[]> {
  const res = await fetch(source.url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    // 403 here is almost always the UA filter described above, not a real
    // authorisation failure — log it distinctly so it is not mistaken for one.
    logger.warn(
      { feed: source.id, status: res.status },
      res.status === 403
        ? 'feed rejected this crawler (User-Agent filter) — see SHORTS_USER_AGENT'
        : 'feed fetch failed'
    )
    return []
  }
  const xml = await res.text()
  const items = parseFeed(xml, source)
  logger.info({ feed: source.id, items: items.length }, 'feed fetched')
  return items
}

/**
 * Pulls the readable body out of an article page.
 *
 * Government pages carry a great deal of navigation and inline script; without
 * stripping those the summariser is handed mostly boilerplate and produces
 * confident nonsense about menu labels.
 */
export function extractReadableText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')

  text = text
    .replace(/<\/(p|div|br|h[1-6]|li|tr|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  text = decodeEntities(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  // Drop navigation debris: very short lines that carry no sentence.
  return text
    .split('\n')
    .filter(line => {
      const t = line.trim()
      if (t.length === 0) return false
      if (t.length < 40 && !/[.!?]$/.test(t)) return false
      return true
    })
    .join('\n')
    .trim()
}

export async function fetchArticleText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error('That site refused an automated fetch. Paste the text instead.')
    }
    throw new Error(`Could not fetch the article (HTTP ${res.status}).`)
  }

  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/pdf')) {
    // Parsing PDFs would mean a new dependency; the operator can paste the text
    // instead, which is one step and always works.
    throw new Error('That link is a PDF. Copy the text and use "Paste text" instead.')
  }

  return extractReadableText(await res.text())
}
