import { Router, Request, Response, NextFunction } from 'express'
import { supabase } from '../lib/supabase'

const router = Router()

// ── Shared mapper: DB row → public Lawyer shape ───────────────────────────────
function mapRow(d: any) {
  return {
    slug: d.account_id,
    name: `${d.first_name ?? ''} ${d.last_name ?? ''}`.trim(),
    initials: `${d.first_name?.[0] ?? ''}${d.last_name?.[0] ?? ''}`,
    avatarBg: '#1a3a5c',
    barNumber: d.bar_council_number ?? '',
    verified: d.verification_status === 'verified',
    online: d.is_online ?? false,
    specializations: d.specializations ?? [],
    primarySpec: d.primary_specialization ?? 'General Practice',
    experience: d.years_experience ?? 0,
    location: d.city ?? 'India',
    languages: d.languages ?? ['English'],
    rating: Number(d.avg_rating) || 0,
    reviewCount: d.total_reviews || 0,
    casesHandled: d.cases_handled || 0,
    bio: d.bio ?? '',
    education: d.education ?? [],
    expertise: d.expertise ?? [],
    achievements: d.achievements ?? [],
    fees: {
      chat: Number(d.consultation_fee_chat) || 20,
      voice: Number(d.consultation_fee_voice) || 30,
      video: Number(d.consultation_fee_video) || 40,
    },
    reviews: d.reviews ?? [],
  }
}

// ── GET /api/lawyers ─────────────────────────────────────────────────────────
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('lawyer_profiles')
      .select('*')
      .eq('verification_status', 'verified')
      .order('avg_rating', { ascending: false })

    if (error) throw error
    res.json({ lawyers: (data ?? []).map(mapRow) })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/lawyers/:slug ───────────────────────────────────────────────────
router.get('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { slug } = req.params
    const { data, error } = await supabase
      .from('lawyer_profiles')
      .select('*')
      .eq('account_id', slug)
      .single()

    if (error || !data) {
      res.status(404).json({ error: 'Lawyer not found' })
      return
    }

    res.json({ lawyer: mapRow(data) })
  } catch (err) {
    next(err)
  }
})

export default router
