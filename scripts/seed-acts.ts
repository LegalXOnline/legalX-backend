/**
 * Seeds Knowledge Center cards from a bare Act.
 *
 *   npx tsx scripts/seed-acts.ts "Consumer Protection Act" --category consumer --max-sections 20
 *
 * Reads the Act text from data/acts/<category>.txt unless --file is given,
 * splits it into sections, and explains each one strictly from that text.
 * Cards are created as pending suggestions; add --publish to send them straight
 * to the feed once you trust the output.
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { supabase } from '../src/lib/supabase'
import { explainStatuteSection, slugify } from '../src/lib/llm'
import { splitSections, stripFrontMatter, ACT_TOPICS } from '../src/lib/acts'
import { RAW_SOURCE_MAX_CHARS } from '../src/lib/shortsPipeline'

interface Args {
  act: string
  category: string
  maxSections: number
  file?: string
  publish: boolean
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const positional = argv.filter(a => !a.startsWith('--') && !/^\d+$/.test(a))
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i !== -1 ? argv[i + 1] : undefined
  }

  const act = positional[0]
  const category = flag('category')
  if (!act || !category) {
    console.error('Usage: npx tsx scripts/seed-acts.ts "<Act name>" --category <topic> --max-sections <n> [--file path] [--publish] [--dry-run]')
    console.error(`Topics: ${Object.keys(ACT_TOPICS).join(', ')}`)
    process.exit(1)
  }
  if (!ACT_TOPICS[category]) {
    console.error(`Unknown topic "${category}". Valid: ${Object.keys(ACT_TOPICS).join(', ')}`)
    process.exit(1)
  }

  return {
    act,
    category,
    maxSections: Number(flag('max-sections') ?? 20),
    file: flag('file'),
    publish: argv.includes('--publish'),
    dryRun: argv.includes('--dry-run'),
  }
}

// Gemini's free tier is 1M tokens/minute so it barely needs pacing; Groq's
// 8,000 does. Matches the pacing logic in shortsPipeline.
const PACE_MS = (process.env.SHORTS_LLM_PROVIDER ?? 'gemini') === 'gemini' ? 1_500 : 22_000
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const topic = ACT_TOPICS[args.category]

  const filePath = args.file ?? path.join(process.cwd(), 'data', 'acts', `${args.category}.txt`)
  if (!fs.existsSync(filePath)) {
    console.error(`\nNo Act text found at ${filePath}`)
    console.error('Download the Act, save its text there, and re-run. See data/acts/README.md.')
    process.exit(1)
  }

  const raw = fs.readFileSync(filePath, 'utf8')
  const sections = splitSections(stripFrontMatter(raw))

  console.log(`\nAct      : ${args.act}`)
  console.log(`Topic    : ${topic.label} (card category: ${topic.category})`)
  console.log(`Source   : ${filePath} — ${raw.length.toLocaleString()} chars`)
  console.log(`Sections : ${sections.length} found, processing up to ${args.maxSections}`)
  if (args.dryRun) {
    console.log('\nDRY RUN — sections detected:\n')
    for (const s of sections.slice(0, args.maxSections)) {
      console.log(`  §${s.number.padEnd(5)} ${(s.heading ?? '').slice(0, 60).padEnd(62)} ${s.text.length} chars`)
    }
    return
  }
  console.log('')

  let created = 0, skipped = 0, failed = 0

  for (const section of sections.slice(0, args.maxSections)) {
    // A stable synthetic URL: acts have no per-section public page we can fetch,
    // but source_url is UNIQUE, so this is what makes re-running the script
    // idempotent instead of duplicating every card.
    const sourceUrl = `legalx://act/${args.category}/section-${section.number}`

    const { data: existing } = await supabase
      .from('shorts_cards').select('id').eq('source_url', sourceUrl).maybeSingle()
    if (existing) {
      console.log(`  §${section.number.padEnd(5)} already seeded — skipping`)
      skipped++
      continue
    }

    try {
      const result = await explainStatuteSection({
        actName: args.act,
        sectionNumber: section.number,
        sectionHeading: section.heading,
        sectionText: section.text,
      })

      if ('skipped' in result) {
        console.log(`  §${section.number.padEnd(5)} skipped — ${result.reason}`)
        skipped++
        continue
      }

      const now = new Date().toISOString()
      const { error } = await supabase.from('shorts_cards').insert({
        title: result.title,
        slug: slugify(result.title, crypto.createHash('sha1').update(sourceUrl).digest('hex').slice(0, 6)),
        summary: result.summary,
        takeaway: result.takeaway || null,
        // The topic's display category wins over the model's guess: we know
        // which Act this came from, the model is inferring it.
        category: topic.category,
        court: null,
        source_url: sourceUrl,
        source_name: args.act,
        source_feed: `act:${args.category}`,
        tags: [...new Set([args.category, ...result.tags])].slice(0, 6),
        evidence: result.evidence,
        relevance_score: result.relevanceScore,
        confidence: result.confidence,
        is_published: args.publish,
        review_status: args.publish ? 'approved' : 'pending',
        published_at: args.publish ? now : null,
        raw_source: { act: args.act, section: section.number, text: section.text.slice(0, RAW_SOURCE_MAX_CHARS) },
      })

      if (error) {
        console.log(`  §${section.number.padEnd(5)} insert failed — ${error.message}`)
        failed++
        continue
      }

      console.log(`  §${section.number.padEnd(5)} ✅ ${result.title.slice(0, 62)}`)
      created++
    } catch (err: any) {
      const message = err?.message ?? 'unknown'
      console.log(`  §${section.number.padEnd(5)} failed — ${message}`)
      failed++
      // Quota problems apply to every remaining section; stop rather than
      // burning through them. What has been created already persists.
      if (/rate limit|not configured|unavailable/i.test(message)) {
        console.log('\n  Stopping early — summarisation quota reached. Re-run to continue; already-seeded sections are skipped.')
        break
      }
    }

    await sleep(PACE_MS)
  }

  console.log(`\nDone: ${created} created, ${skipped} skipped, ${failed} failed.`)
  console.log(args.publish
    ? 'Published straight to the Knowledge Center.'
    : 'Waiting in /admin/shorts — review and approve them there.')
}

main().catch(err => {
  console.error('\nSeeding failed:', err?.message ?? err)
  process.exit(1)
})
