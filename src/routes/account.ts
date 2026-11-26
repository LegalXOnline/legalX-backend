import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { supabase } from '../lib/supabase'
import { logger } from '../lib/logger'
import { validateBody } from '../lib/validation'
import { requireAuth, type AuthedRequest } from '../lib/auth'
import { servicePriceInRupees } from '../lib/pricing'
import {
  applicationStatus, consultationStatus, paymentMethodLabel, byNewest,
  ticketCategoryLabel, ticketStatusLabel, toStoredCategory, ticketAcceptsReplies,
  type Order,
} from '../lib/account'

/**
 * The client's own account area: order history, saved items and support.
 *
 * Every screen behind this has existed on Android since the app was built and
 * has been showing a permanent empty state, because none of it had an
 * endpoint. The website has no account area at all.
 */
const router = Router()

// Everything here is the caller's own data; there is no public surface.
router.use(requireAuth)

// ── GET /api/account/orders ──────────────────────────────────────────────────
router.get('/orders', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const me = req.user!.id

    const [apps, consults, topups] = await Promise.all([
      // Document requests reach the client through the lead that owns them.
      supabase
        .from('applications')
        .select('id, service_slug, status, created_at, leads!inner(account_id, service_title)')
        .eq('leads.account_id', me)
        .order('created_at', { ascending: false })
        .limit(100),
      supabase
        .from('consultations')
        .select('id, type, status, payment_status, total_amount, created_at, lawyer_id')
        .eq('client_id', me)
        .order('created_at', { ascending: false })
        .limit(100),
      supabase
        .from('wallet_transactions')
        .select('id, amount, description, created_at')
        .eq('account_id', me)
        .eq('txn_type', 'credit')
        .order('created_at', { ascending: false })
        .limit(100),
    ])

    // One lookup for every advocate named, rather than one per consultation.
    const lawyerIds = [...new Set((consults.data ?? []).map(c => c.lawyer_id).filter(Boolean))]
    const names = new Map<string, string>()
    if (lawyerIds.length) {
      const { data } = await supabase
        .from('accounts').select('id, first_name, last_name').in('id', lawyerIds)
      for (const a of data ?? []) {
        names.set(a.id, [a.first_name, a.last_name].filter(Boolean).join(' ').trim() || 'Advocate')
      }
    }

    const orders: Order[] = [
      ...(apps.data ?? []).map(a => {
        const lead = Array.isArray(a.leads) ? a.leads[0] : a.leads
        return {
          id: a.id,
          orderType: 'Documentation' as const,
          serviceTitle: lead?.service_title ?? a.service_slug,
          date: a.created_at,
          amount: servicePriceInRupees(a.service_slug) ?? 0,
          status: applicationStatus(a.status),
        }
      }),
      ...(consults.data ?? []).map(c => ({
        id: c.id,
        orderType: 'Lawyer Consultation' as const,
        serviceTitle: `${String(c.type ?? 'chat').replace(/^./, s => s.toUpperCase())} consultation`,
        date: c.created_at,
        amount: Number(c.total_amount ?? 0),
        status: consultationStatus(c.status, c.payment_status),
        lawyerName: names.get(c.lawyer_id) ?? undefined,
        paymentMethod: paymentMethodLabel(c.payment_status),
      })),
      ...(topups.data ?? []).map(t => ({
        id: t.id,
        orderType: 'LX Coins' as const,
        serviceTitle: t.description ?? 'Wallet top-up',
        date: t.created_at,
        amount: Number(t.amount ?? 0),
        status: 'Completed' as const,
      })),
    ].sort(byNewest)

    res.json({ orders })
  } catch (err) {
    next(err)
  }
})

// ── Saved advocates ──────────────────────────────────────────────────────────
router.get('/saved-lawyers', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('saved_lawyers')
      .select('lawyer_id, saved_at')
      .eq('client_id', req.user!.id)
      .order('saved_at', { ascending: false })
    if (error) throw error

    const ids = (data ?? []).map(r => r.lawyer_id)
    if (!ids.length) return res.json({ lawyers: [] })

    // Only the directory columns — the same set GET /api/lawyers returns, and
    // never the KYC ones this table sits next to.
    const { data: profiles } = await supabase
      .from('lawyer_profiles')
      .select('account_id, first_name, last_name, profile_photo_url, primary_specialization, years_experience, avg_rating, total_reviews, city, languages, verification_status, is_online, last_seen_at, consultation_fee_chat, consultation_fee_voice, consultation_fee_video')
      .in('account_id', ids)

    const savedAt = new Map((data ?? []).map(r => [r.lawyer_id, r.saved_at]))
    const lawyers = (profiles ?? [])
      .map(p => ({
        slug: p.account_id,
        name: [p.first_name, p.last_name].filter(Boolean).join(' ').trim(),
        avatarUrl: p.profile_photo_url ? `/api/lawyers/${p.account_id}/photo` : null,
        primarySpec: p.primary_specialization ?? 'General Practice',
        experience: p.years_experience ?? 0,
        rating: Number(p.avg_rating) || 0,
        reviewCount: p.total_reviews || 0,
        location: p.city ?? 'India',
        languages: p.languages ?? ['English'],
        verified: p.verification_status === 'verified',
        fees: {
          chat: Number(p.consultation_fee_chat) || 25,
          voice: Number(p.consultation_fee_voice) || 30,
          video: Number(p.consultation_fee_video) || 40,
        },
        savedAt: savedAt.get(p.account_id) ?? null,
      }))
      .sort((a, b) => Date.parse(String(b.savedAt)) - Date.parse(String(a.savedAt)))

    res.json({ lawyers })
  } catch (err) {
    next(err)
  }
})

const lawyerIdSchema = z.object({ lawyerId: z.string().uuid() })

router.post('/saved-lawyers', validateBody(lawyerIdSchema), async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    // Upsert, so saving twice is not an error the UI has to interpret.
    const { error } = await supabase
      .from('saved_lawyers')
      .upsert({ client_id: req.user!.id, lawyer_id: req.body.lawyerId }, { onConflict: 'client_id,lawyer_id' })
    if (error) throw error
    res.status(201).json({ saved: true })
  } catch (err) {
    next(err)
  }
})

router.delete('/saved-lawyers/:lawyerId', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { error } = await supabase
      .from('saved_lawyers').delete()
      .eq('client_id', req.user!.id)
      .eq('lawyer_id', String(req.params.lawyerId))
    if (error) throw error
    res.json({ saved: false })
  } catch (err) {
    next(err)
  }
})

// ── Saved articles ───────────────────────────────────────────────────────────
router.get('/saved-articles', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('saved_articles')
      .select('kind, slug, saved_at')
      .eq('account_id', req.user!.id)
      .order('saved_at', { ascending: false })
      .limit(200)
    if (error) throw error

    const rows = data ?? []
    const knowledgeSlugs = rows.filter(r => r.kind === 'knowledge').map(r => r.slug)
    const shortSlugs = rows.filter(r => r.kind === 'short').map(r => r.slug)

    const [cards, shorts] = await Promise.all([
      knowledgeSlugs.length
        ? supabase.from('knowledge_cards')
            .select('slug, title, category, direct_answer, published_at')
            .in('slug', knowledgeSlugs).eq('is_published', true)
        : Promise.resolve({ data: [] as any[] }),
      shortSlugs.length
        ? supabase.from('shorts_cards')
            .select('slug, title, category, summary, published_at')
            .in('slug', shortSlugs).eq('is_published', true)
        : Promise.resolve({ data: [] as any[] }),
    ])

    const bySlug = new Map<string, any>()
    for (const c of cards.data ?? []) bySlug.set(`knowledge:${c.slug}`, {
      kind: 'knowledge', slug: c.slug, title: c.title, category: c.category,
      teaser: c.direct_answer ?? '', publishedAt: c.published_at,
    })
    for (const s of shorts.data ?? []) bySlug.set(`short:${s.slug}`, {
      kind: 'short', slug: s.slug, title: s.title, category: s.category,
      teaser: s.summary ?? '', publishedAt: s.published_at,
    })

    // A bookmark whose article was unpublished since is dropped rather than
    // rendered as a dead row the client cannot open.
    const articles = rows
      .map(r => {
        const a = bySlug.get(`${r.kind}:${r.slug}`)
        return a ? { ...a, savedAt: r.saved_at } : null
      })
      .filter(Boolean)

    res.json({ articles })
  } catch (err) {
    next(err)
  }
})

const savedArticleSchema = z.object({
  kind: z.enum(['knowledge', 'short']),
  slug: z.string().min(1).max(200),
})

router.post('/saved-articles', validateBody(savedArticleSchema), async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { error } = await supabase
      .from('saved_articles')
      .upsert({ account_id: req.user!.id, kind: req.body.kind, slug: req.body.slug },
              { onConflict: 'account_id,kind,slug' })
    if (error) throw error
    res.status(201).json({ saved: true })
  } catch (err) {
    next(err)
  }
})

router.delete('/saved-articles/:kind/:slug', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { error } = await supabase
      .from('saved_articles').delete()
      .eq('account_id', req.user!.id)
      .eq('kind', String(req.params.kind))
      .eq('slug', String(req.params.slug))
    if (error) throw error
    res.json({ saved: false })
  } catch (err) {
    next(err)
  }
})

// ── Support ──────────────────────────────────────────────────────────────────
router.get('/support', async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('support_tickets')
      .select('id, category, subject, description, status, created_at, support_ticket_messages(sender, body, created_at)')
      .eq('account_id', req.user!.id)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw error

    const tickets = (data ?? []).map(t => ({
      id: t.id,
      category: ticketCategoryLabel(t.category),
      subject: t.subject,
      description: t.description,
      date: t.created_at,
      status: ticketStatusLabel(t.status),
      messages: ((t.support_ticket_messages as any[]) ?? [])
        .slice()
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .map(m => ({
          // The client sees "Support", never which admin replied.
          sender: m.sender === 'support' ? 'Support' : 'User',
          text: m.body,
          time: m.created_at,
        })),
    }))

    res.json({ tickets })
  } catch (err) {
    next(err)
  }
})

const ticketSchema = z.object({
  category: z.string().min(1).max(40),
  subject: z.string().trim().min(3).max(140),
  description: z.string().trim().min(10).max(4000),
})

router.post('/support', validateBody(ticketSchema), async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const stored = toStoredCategory(req.body.category)
    if (!stored) return res.status(400).json({ error: 'Choose one of the listed categories.' })

    const { data, error } = await supabase
      .from('support_tickets')
      .insert({
        account_id: req.user!.id,
        category: stored,
        subject: req.body.subject,
        description: req.body.description,
      })
      .select('id, created_at')
      .single()
    if (error) throw error

    logger.info({ ticketId: data.id, category: stored }, '[support] ticket opened')
    res.status(201).json({ ticketId: data.id, createdAt: data.created_at })
  } catch (err) {
    next(err)
  }
})

const replySchema = z.object({ body: z.string().trim().min(1).max(4000) })

router.post('/support/:id/messages', validateBody(replySchema), async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { data: ticket } = await supabase
      .from('support_tickets')
      .select('id, account_id, status')
      .eq('id', String(req.params.id))
      .maybeSingle()

    // 404 rather than 403 on someone else's ticket — a 403 confirms it exists.
    if (!ticket || ticket.account_id !== req.user!.id) {
      return res.status(404).json({ error: 'Ticket not found' })
    }
    if (!ticketAcceptsReplies(ticket.status)) {
      return res.status(409).json({ error: 'This ticket is closed. Open a new one and we will pick it up.' })
    }

    const { data, error } = await supabase
      .from('support_ticket_messages')
      .insert({ ticket_id: ticket.id, sender: 'user', author_id: req.user!.id, body: req.body.body })
      .select('id, body, created_at')
      .single()
    if (error) throw error

    // A reply on a resolved ticket reopens it; the client clearly is not done.
    if (ticket.status === 'resolved') {
      await supabase.from('support_tickets').update({ status: 'open' }).eq('id', ticket.id)
    }

    res.status(201).json({ message: { sender: 'User', text: data.body, time: data.created_at } })
  } catch (err) {
    next(err)
  }
})

export default router
