import { Router, Request, Response, NextFunction } from 'express'
import { supabase, supabaseAuthValidator } from '../lib/supabase'
import {
  sendLawyerDocsSubmittedAdmin,
  sendLawyerDocsReceivedConfirmation,
} from '../lib/email'

const router = Router()

// ── Auth helper ───────────────────────────────────────────────────────────────
// Returns user with role from public.accounts (source of truth), not user_metadata.
async function getAuthUser(req: Request): Promise<{ id: string; email: string | undefined; role: string } | null> {
  const token =
    req.cookies?.lx_access_token ||
    req.headers.authorization?.replace('Bearer ', '')
  if (!token) return null

  const { data, error } = await supabaseAuthValidator.auth.getUser(token)
  if (error || !data.user) return null

  // Get role from accounts table — not user_metadata
  const { data: account } = await supabase
    .from('accounts')
    .select('role')
    .eq('id', data.user.id)
    .single()

  return {
    id: data.user.id,
    email: data.user.email,
    role: account?.role ?? (data.user.role ?? 'client'),
  }
}

// ── Shared mapper: DB row → public Lawyer card shape ─────────────────────────
function mapRow(d: any) {
  return {
    slug:            d.account_id,
    name:            `${d.first_name ?? ''} ${d.last_name ?? ''}`.trim(),
    initials:        `${d.first_name?.[0] ?? ''}${d.last_name?.[0] ?? ''}`,
    avatarBg:        '#1a3a5c',
    avatarUrl:       d.profile_photo_url ?? null,
    barNumber:       d.bar_council_number ?? '',
    barState:        d.bar_council_state ?? '',
    verified:        d.verification_status === 'verified',
    online:          d.is_online ?? false,
    specializations: d.specializations ?? [],
    primarySpec:     d.primary_specialization ?? 'General Practice',
    experience:      d.years_experience ?? 0,
    location:        d.city ?? 'India',
    languages:       d.languages ?? ['English'],
    courts:          d.courts_practiced ?? [],
    rating:          Number(d.avg_rating) || 0,
    reviewCount:     d.total_reviews || 0,
    casesHandled:    d.cases_handled || 0,
    bio:             d.bio ?? '',
    firmName:        d.firm_name ?? null,
    linkedin:        d.linkedin_url ?? null,
    website:         d.website_url ?? null,
    education:       d.education ?? [],
    expertise:       d.expertise ?? [],
    achievements:    d.achievements ?? [],
    consultationTypes: d.consultation_types ?? ['chat', 'voice', 'video'],
    fees: {
      chat:  Number(d.consultation_fee_chat)  || 20,
      voice: Number(d.consultation_fee_voice) || 30,
      video: Number(d.consultation_fee_video) || 40,
    },
    documentServices: d.document_services ?? [],
    availabilitySlots: d.availability_slots ?? {},
    reviews: d.reviews ?? [],
  }
}

// ── GET /api/lawyers/me ───────────────────────────────────────────────────────
// Returns the logged-in lawyer's full profile including onboarding + verification status.
// Used by frontend to: (1) gate onboarding redirect, (2) show dashboard status banner.
router.get('/me', async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) return res.status(401).json({ error: 'Not authenticated' })
    if (user.role !== 'lawyer') {
      return res.status(403).json({ error: 'Not a lawyer account' })
    }

    const { data, error } = await supabase
      .from('lawyer_profiles')
      .select('*')
      .eq('account_id', user.id)
      .single()

    if (error || !data) {
      // Profile row may not exist yet (signup just completed)
      return res.json({
        onboarding_complete: false,
        verification_status: 'pending_signup',
        is_online: false,
        profile: null,
      })
    }

    return res.json({
      onboarding_complete:  data.onboarding_complete ?? false,
      verification_status:  data.verification_status ?? 'pending_signup',
      rejection_reason:     data.rejection_reason ?? null,
      // Exposed at the top level on purpose: mapRow() renames this to `online`
      // for the public directory, so the portal could never read it back and
      // the availability switch reset to Offline on every page load.
      is_online:            data.is_online ?? false,
      profile: mapRow(data),
    })
  } catch (err) {
    console.error('[lawyers/me] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PATCH /api/lawyers/me/status ─────────────────────────────────────────────
// Lawyer toggles online / offline availability. MUST be before GET /:slug.
router.patch('/me/status', async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) return res.status(401).json({ error: 'Not authenticated' })
    if (user.role !== 'lawyer') {
      return res.status(403).json({ error: 'Only lawyers can update availability status' })
    }

    // Accept either spelling. The portal used to send `is_online` while this
    // route only read `isOnline`, so every toggle 400'd and the UI rolled the
    // switch straight back to offline. Tolerating both means an older cached
    // bundle keeps working after deploy.
    const raw = req.body?.isOnline ?? req.body?.is_online
    if (typeof raw !== 'boolean') {
      return res.status(400).json({ error: 'isOnline must be a boolean' })
    }
    const isOnline = raw

    // Upsert so the row always exists even if onboarding is incomplete
    const { error: updateError } = await supabase
      .from('lawyer_profiles')
      .update({ is_online: isOnline, last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('account_id', user.id)

    if (updateError) {
      console.error('[lawyers/me/status] DB error:', updateError.message)
      return res.status(500).json({ error: 'Failed to update availability status' })
    }

    return res.json({ isOnline, message: `Status set to ${isOnline ? 'online' : 'offline'}` })
  } catch (err) {
    console.error('[lawyers/me/status] Unexpected error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/lawyers/onboarding ─────────────────────────────────────────────
// Saves all 4 pages of onboarding data. Fires two emails:
//   1. Admin: document links for review
//   2. Lawyer: confirmation that documents are under review
router.post('/onboarding', async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) return res.status(401).json({ error: 'Not authenticated' })
    if (user.role !== 'lawyer') {
      return res.status(403).json({ error: 'Only lawyers can submit onboarding' })
    }

    const {
      // Page 1 — Credentials
      firstName, lastName, phone,
      barCouncilState, barCouncilNumber, enrolmentYear,
      profilePhotoPath, enrolmentCertPath, barIdFrontPath, barIdBackPath,
      govtIdType, govtIdPath,
      // Page 2 — Profile
      bio, firmName, linkedinUrl, websiteUrl,
      languages, courtsPracticed, specializations, primarySpecialization, yearsExperience,
      // Page 3 — Services & Pricing
      consultationTypes, feeChat, feeVoice, feeVideo,
      documentServices, availabilitySlots,
      // Page 4 — Payout & Trust
      bankAccountNumber, bankIfsc, bankName, upiId, panNumber, gstNumber,
      notableAchievements, certifications,
    } = req.body

    // Build signed URLs for admin email — non-fatal if storage fails
    const signedUrls: Record<string, string> = {}
    try {
      const docPaths: Record<string, string | undefined> = {
        enrolment_cert: enrolmentCertPath,
        bar_id_front:   barIdFrontPath,
        bar_id_back:    barIdBackPath,
        govt_id:        govtIdPath,
        ...(profilePhotoPath ? { profile_photo: profilePhotoPath } : {}),
      }
      for (const [key, path] of Object.entries(docPaths)) {
        if (!path) continue
        const { data } = await supabase.storage
          .from('legalx-lawyer-docs')
          .createSignedUrl(path, 86400)
        if (data?.signedUrl) signedUrls[key] = data.signedUrl
      }
    } catch (storageErr) {
      // Non-fatal — onboarding still saves; admin gets doc paths in email
      console.error('[lawyers/onboarding] signedUrl error (non-fatal):', storageErr)
    }

    // ── Step 1: Upsert lawyer_profiles (no bank cols — those go to lawyer_bank_details) ──
    console.log('[lawyers/onboarding] Starting upsert for user:', user.id, '| env:', process.env.NODE_ENV, '| RENDER:', process.env.RENDER)
    const { error: upsertError } = await supabase
      .from('lawyer_profiles')
      .upsert({
        account_id:          user.id,
        // email & phone may not exist in older schema — spread conditionally
        ...(user.email   ? { email: user.email } : {}),
        ...(firstName    ? { first_name: firstName } : {}),
        ...(lastName     ? { last_name: lastName }   : {}),
        ...(phone        ? { phone }                 : {}),
        // Page 1 — Credentials
        bar_council_state:   barCouncilState,
        bar_council_number:  barCouncilNumber,
        enrolment_year:      enrolmentYear ? Number(enrolmentYear) : null,
        profile_photo_url:   profilePhotoPath ?? null,
        // Note: enrolment_cert_url / bar_id_*_url / govt_id_url columns are added
        // via migration. If not yet applied, they are skipped gracefully here and
        // stored in signedUrls for admin review via email only.
        ...(enrolmentCertPath ? { enrolment_cert_url: enrolmentCertPath } : {}),
        ...(barIdFrontPath    ? { bar_id_front_url:   barIdFrontPath }    : {}),
        ...(barIdBackPath     ? { bar_id_back_url:    barIdBackPath }     : {}),
        ...(govtIdPath        ? { govt_id_url:        govtIdPath }        : {}),
        govt_id_type:        govtIdType ?? null,
        // Page 2 — Profile
        bio:                 bio ?? null,
        firm_name:           firmName ?? null,
        linkedin_url:        linkedinUrl ?? null,
        website_url:         websiteUrl ?? null,
        courts_practiced:    Array.isArray(courtsPracticed) ? courtsPracticed : [],
        years_experience:    yearsExperience ? Number(yearsExperience) : 0,
        // languages/specializations/primary_specialization may be missing in older schema
        ...(languages      ? { languages }                                                            : {}),
        ...(specializations ? { specializations }                                                    : {}),
        ...(specializations ? { primary_specialization: primarySpecialization ?? specializations?.[0] ?? 'General Practice' } : {}),
        // Page 3 — Services
        consultation_types:     Array.isArray(consultationTypes) ? consultationTypes : ['chat', 'voice', 'video'],
        consultation_fee_chat:  feeChat  ? Number(feeChat)  : 20,
        consultation_fee_voice: feeVoice ? Number(feeVoice) : 30,
        consultation_fee_video: feeVideo ? Number(feeVideo) : 40,
        document_services:   Array.isArray(documentServices) ? documentServices : [],
        availability_slots:  (availabilitySlots && typeof availabilitySlots === 'object') ? availabilitySlots : {},
        // Page 4 — Payout (upi_id, pan, gst live on lawyer_profiles; bank rows go to lawyer_bank_details)
        upi_id:              upiId ?? null,
        pan_number:          panNumber ?? null,
        gst_number:          gstNumber ?? null,
        notable_achievements: notableAchievements ?? null,
        certifications:      certifications ?? null,
        // Status
        onboarding_complete: true,
        verification_status: 'pending_verification',
        updated_at:          new Date().toISOString(),
      }, { onConflict: 'account_id' })

    if (upsertError) {
      console.error('[lawyers/onboarding] DB upsert error FULL:', JSON.stringify(upsertError))
      return res.status(500).json({ error: 'Failed to save onboarding data. Please try again.' })
    }

    // ── Step 2: Upsert bank details into lawyer_bank_details ──
    // Real schema: lawyer_id, account_holder_name, ifsc_code, bank_name
    if (bankIfsc?.trim() || bankName?.trim() || bankAccountNumber?.trim()) {
      try {
        const { error: bankError } = await supabase
          .from('lawyer_bank_details')
          .upsert({
            lawyer_id:           user.id,
            account_holder_name: bankName?.trim() || `${firstName ?? ''} ${lastName ?? ''}`.trim() || 'Unknown',
            ifsc_code:           bankIfsc?.trim().toUpperCase() ?? null,
            bank_name:           bankName?.trim() ?? null,
            updated_at:          new Date().toISOString(),
          }, { onConflict: 'lawyer_id' })

        if (bankError) {
          console.error('[lawyers/onboarding] Bank details upsert error (non-fatal):', bankError.message)
        }
      } catch (bankErr) {
        console.error('[lawyers/onboarding] Bank step threw (non-fatal):', bankErr)
      }
    }

    // Fire emails — non-blocking
    const fullName = `${firstName} ${lastName}`.trim()
    sendLawyerDocsSubmittedAdmin({
      name:           fullName,
      email:          user.email!,
      barState:       barCouncilState,
      barNumber:      barCouncilNumber,
      enrolmentYear:  enrolmentYear,
      signedUrls,
      lawyerId:       user.id,
    }).catch(console.error)

    sendLawyerDocsReceivedConfirmation(user.email!, firstName).catch(console.error)

    return res.json({ ok: true, message: 'Onboarding complete. Documents submitted for review.' })
  } catch (err) {
    console.error('[lawyers/onboarding] Unexpected error FULL:', err instanceof Error ? err.stack : JSON.stringify(err))
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/lawyers ─────────────────────────────────────────────────────────
router.get('/', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('lawyer_profiles')
      .select('*')
      .eq('verification_status', 'verified')
      .order('avg_rating', { ascending: false })

    if (error) {
      console.warn('[lawyers] DB query failed, returning empty list:', error.message)
      return res.json({ lawyers: [] })
    }
    return res.json({ lawyers: (data ?? []).map(mapRow) })
  } catch (err) {
    console.error('[lawyers] Unexpected error:', err)
    return res.json({ lawyers: [] })
  }
})

// ── GET /api/lawyers/:slug ───────────────────────────────────────────────────
// MUST be last — wildcard would otherwise intercept /me and /me/status
router.get('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { slug } = req.params
    if (slug === 'me') return res.status(400).json({ error: 'Use /api/lawyers/me' })

    const { data, error } = await supabase
      .from('lawyer_profiles')
      .select('*')
      .eq('account_id', slug)
      .single()

    if (error || !data) return res.status(404).json({ error: 'Lawyer not found' })
    return res.json({ lawyer: mapRow(data) })
  } catch (err) {
    next(err)
  }
})

export default router
