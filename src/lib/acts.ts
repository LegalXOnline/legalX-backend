/**
 * Statute ingestion for the Knowledge Center.
 *
 * Act text is supplied as a file rather than fetched: every official source
 * (indiacode.nic.in, legislative.gov.in) returns 403 to automated clients, and
 * asking a model to recall an Act from training data is exactly the failure
 * this pipeline is built to prevent — a wrong section number or penalty
 * published under a law firm's name is a liability event.
 *
 * So a human downloads the Act once, drops the text in data/acts/, and every
 * card is then grounded in that verbatim text.
 */

export interface ActSection {
  number: string
  heading?: string
  text: string
}

export interface ActTopic {
  /** CLI value, e.g. `consumer`. Becomes a tag on every card from this Act. */
  id: string
  /** Display category on the card — must be one of the CATEGORIES in llm.ts. */
  category: string
  label: string
}

/**
 * Topic → display category. The CLI takes the topic (`posco`, `cyber`), which
 * is more specific than the card categories the public feed filters on.
 */
export const ACT_TOPICS: Record<string, ActTopic> = {
  posco:         { id: 'posco',         category: 'Criminal',  label: 'Protection of Children from Sexual Offences' },
  cyber:         { id: 'cyber',         category: 'Criminal',  label: 'Information Technology / cyber law' },
  traffic:       { id: 'traffic',       category: 'Criminal',  label: 'Motor Vehicles / traffic' },
  consumer:      { id: 'consumer',      category: 'Consumer',  label: 'Consumer protection' },
  cheque_ni_act: { id: 'cheque_ni_act', category: 'Civil',     label: 'Negotiable Instruments / cheque bounce' },
  property:      { id: 'property',      category: 'Property',  label: 'Property and tenancy' },
  labour:        { id: 'labour',        category: 'Labour',    label: 'Employment and labour' },
  family:        { id: 'family',        category: 'Family',    label: 'Family law' },
}

/**
 * Splits a bare Act into numbered sections.
 *
 * Indian bare acts number sections as `12.` or `12A.` at the start of a line,
 * usually followed by a heading. This is intentionally conservative: a chunk
 * that does not clearly start a section is appended to the previous one rather
 * than being guessed at, because a mis-split section produces a card that
 * quotes one provision under another's number.
 */
export function splitSections(actText: string): ActSection[] {
  const clean = actText
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  // `1.` / `12A.` / `304B.` at the start of a line.
  const pattern = /^\s*(\d{1,3}[A-Z]{0,2})\.\s+(.{0,120}?)(?:\.|—|–|-|\n)/gm

  const marks: { number: string; heading: string; start: number }[] = []
  let m: RegExpExecArray | null
  while ((m = pattern.exec(clean)) !== null) {
    marks.push({ number: m[1], heading: m[2].trim(), start: m.index })
  }

  if (marks.length === 0) return []

  const sections: ActSection[] = []
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].start
    const end = i + 1 < marks.length ? marks[i + 1].start : clean.length
    const text = clean.slice(start, end).trim()

    // Too short to be a real provision — almost always a table-of-contents
    // line or a cross-reference. Skipping beats explaining a fragment.
    if (text.length < 200) continue

    sections.push({
      number: marks[i].number,
      heading: marks[i].heading || undefined,
      text,
    })
  }
  return sections
}

/** Removes front matter that is not a provision: preamble, contents, notes. */
export function stripFrontMatter(actText: string): string {
  const markers = [
    /\n\s*CHAPTER\s+I\b/i,
    /\n\s*1\.\s+Short title/i,
    /\n\s*BE it enacted/i,
  ]
  for (const marker of markers) {
    const match = actText.match(marker)
    if (match?.index !== undefined && match.index > 0) {
      return actText.slice(match.index)
    }
  }
  return actText
}
