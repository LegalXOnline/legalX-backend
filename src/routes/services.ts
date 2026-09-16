import { Router, Request, Response } from 'express'
import { DOCUMENTS, getDocument } from '../lib/documents'

const router = Router()

/**
 * The service catalogue.
 *
 * Public and unauthenticated: this is the same list the website renders, and
 * the mobile app needs it before anyone has signed in. The data is static, so
 * it is served from memory rather than the database.
 */

/** Numeric price in rupees, parsed once from the pricing block. */
function priceOf(total: string, fallback: number): number {
  const digits = total.replace(/[^\d]/g, '')
  return digits ? Number(digits) : fallback
}

// ── GET /api/services ────────────────────────────────────────────────────────
// The list view: enough for a card, without the FAQ and form schema that only
// the detail screen needs.
router.get('/', (_req: Request, res: Response) => {
  res.json({
    services: DOCUMENTS.map(d => ({
      id: d.slug,
      slug: d.slug,
      title: d.title,
      tag: d.tag,
      tagline: d.tagline,
      description: d.shortDesc,
      shortDesc: d.shortDesc,
      priceLine: d.pricing.total,
      priceNumeric: priceOf(d.pricing.total, d.pricing.drafting),
      duration: d.duration,
      estimatedTime: d.estimatedTime,
      legalAct: d.legalAct,
    })),
  })
})

/**
 * The stages an application passes through.
 *
 * Copy is identical to the website's service page, kept here so the app and
 * the site cannot describe the same process differently. The price is
 * interpolated per service, exactly as the site does it.
 */
function howItWorks(total: string) {
  return [
    { n: '01', title: 'Requirements', description: 'Answer a short questionnaire about your specific needs.' },
    { n: '02', title: 'Your Details', description: 'Provide the names, addresses, and relevant party information.' },
    { n: '03', title: 'Review', description: 'Preview the draft before proceeding.' },
    { n: '04', title: 'Payment', description: `Pay securely. ${total} — no hidden charges.` },
  ]
}

// ── GET /api/services/:slug ──────────────────────────────────────────────────
router.get('/:slug', (req: Request, res: Response) => {
  const doc = getDocument(String(req.params.slug ?? '').slice(0, 120))
  if (!doc) return res.status(404).json({ error: 'Service not found' })

  return res.json({
    service: {
      ...doc,
      id: doc.slug,
      description: doc.shortDesc,
      priceLine: doc.pricing.total,
      priceNumeric: priceOf(doc.pricing.total, doc.pricing.drafting),
      breadcrumb: `Services / ${doc.tag}`,
      howItWorks: howItWorks(doc.pricing.total),
    },
  })
})

export default router
