/**
 * Imports the Know Your Rights export into knowledge_cards.
 *
 *   npx tsx scripts/seed-knowledge-cards.ts [--cards docs/cards.json]
 *                                           [--raw docs/raw_documents.json]
 *                                           [--dry]
 *
 * Idempotent: rows are upserted on id, so re-running after a fresh export
 * updates in place rather than duplicating. Card text is copied verbatim —
 * nothing here rewrites an answer.
 *
 * Requires migrations/20240906000001_knowledge_cards.sql to have been run.
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { supabase } from '../src/lib/supabase'
import { slugifyTitle } from '../src/lib/knowledgeSlug'

interface CardExport {
  id: string
  content_type?: string
  category: string
  title: string
  question?: string
  direct_answer?: string
  explanation?: string
  card_text?: string
  case_reference?: string
  suggested_questions?: string[]
  source_url?: string
  source_tid?: string
  content_hash?: string
  raw_document_id?: string
  source?: string
  cta_type?: string
  is_published?: boolean
  published_at?: string | null
  created_at?: string | null
  reviewed_by?: string | null
  last_reviewed_at?: string | null
}

interface RawExport {
  id: string
  source?: string
  external_id?: string
  url?: string
  title?: string
  doc_type?: string
  raw_text?: string
  content_hash?: string
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const DRY = process.argv.includes('--dry')
const CARDS_PATH = resolve(process.cwd(), arg('cards', 'docs/cards.json'))
const RAW_PATH   = resolve(process.cwd(), arg('raw', 'docs/raw_documents.json'))

function load<T>(path: string): T[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`${path} is not a JSON array`)
  return parsed as T[]
}

/**
 * Slugs must be unique — the column has a UNIQUE constraint and the URL is
 * the card's identity. Titles happen to be distinct in the current export,
 * but truncation to 70 characters could still collide, so a numeric suffix is
 * appended rather than letting the insert fail.
 */
function assignSlugs(cards: CardExport[]): Map<string, string> {
  const used = new Set<string>()
  const out = new Map<string, string>()

  for (const card of cards) {
    const base = slugifyTitle(card.title) || card.id.slice(0, 8)
    let slug = base
    let n = 2
    while (used.has(slug)) slug = `${base.slice(0, 66)}-${n++}`
    used.add(slug)
    out.set(card.id, slug)
  }
  return out
}

async function upsertChunked<T>(table: string, rows: T[], size = 100) {
  let done = 0
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size)
    const { error } = await supabase.from(table).upsert(chunk as never, { onConflict: 'id' })
    if (error) throw new Error(`${table} upsert failed at row ${i}: ${error.message}`)
    done += chunk.length
    process.stdout.write(`\r  ${table}: ${done}/${rows.length}`)
  }
  process.stdout.write('\n')
}

async function main() {
  const cards = load<CardExport>(CARDS_PATH)
  const raws  = load<RawExport>(RAW_PATH)

  const slugs = assignSlugs(cards)
  const published = cards.filter(c => c.is_published === true).length

  console.log(`cards:  ${cards.length} (${published} published, ${cards.length - published} awaiting review)`)
  console.log(`raw:    ${raws.length}`)

  const byCategory = cards.reduce<Record<string, number>>((acc, c) => {
    acc[c.category] = (acc[c.category] ?? 0) + 1
    return acc
  }, {})
  console.log('categories:', byCategory)

  if (DRY) {
    console.log('\n--dry: nothing written. Sample slugs:')
    for (const c of cards.slice(0, 5)) console.log(`  ${slugs.get(c.id)}`)
    return
  }

  const rawRows = raws.map(r => ({
    id: r.id,
    source: r.source ?? null,
    external_id: r.external_id ?? null,
    url: r.url ?? null,
    title: r.title ?? null,
    doc_type: r.doc_type ?? null,
    raw_text: r.raw_text ?? null,
    content_hash: r.content_hash ?? null,
  }))

  // Raw documents first: cards reference them.
  await upsertChunked('knowledge_raw_documents', rawRows)

  const rawIds = new Set(raws.map(r => r.id))

  const cardRows = cards.map(c => ({
    id: c.id,
    slug: slugs.get(c.id)!,
    content_type: c.content_type ?? 'rights_explainer',
    category: c.category,
    title: c.title,
    question: c.question ?? null,
    direct_answer: c.direct_answer ?? null,
    explanation: c.explanation ?? null,
    card_text: c.card_text ?? null,
    case_reference: c.case_reference ?? null,
    suggested_questions: c.suggested_questions ?? [],
    source_url: c.source_url ?? null,
    source_tid: c.source_tid ?? null,
    source: c.source ?? null,
    content_hash: c.content_hash ?? null,
    // Drop dangling references rather than letting the insert fail on a card
    // whose source document was not in the same export.
    raw_document_id: c.raw_document_id && rawIds.has(c.raw_document_id) ? c.raw_document_id : null,
    cta_type: c.cta_type ?? null,
    is_published: c.is_published === true,
    published_at: c.published_at ?? null,
    created_at: c.created_at ?? new Date().toISOString(),
    reviewed_by: c.reviewed_by ?? null,
    last_reviewed_at: c.last_reviewed_at ?? null,
  }))

  await upsertChunked('knowledge_cards', cardRows)

  const { count } = await supabase
    .from('knowledge_cards')
    .select('id', { count: 'exact', head: true })
    .eq('is_published', true)

  console.log(`\nDone. ${count ?? 0} card(s) are live; the rest are in the admin review queue.`)
}

main().catch(err => {
  console.error('\nseed failed:', err.message)
  process.exit(1)
})
