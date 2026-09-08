import { Router, Request, Response, NextFunction } from 'express'
import { supabase, supabaseAuthValidator } from '../lib/supabase'
import {
  sendLawyerDocsSubmittedAdmin,
  sendLawyerDocsReceivedConfirmation,
} from '../lib/email'
import { validateBody, lawyerSettingsUpdateSchema } from '../lib/validation'

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

/**
 * Avatar tile colours.
 *
 * Every lawyer was served the same '#1a3a5c', so a grid of cards was a column
 * of identical blue squares — and that blue belongs to no part of the site's
 * palette. These are deep, desaturated tones that sit on the dark card without
 * competing with the gold, and the index is derived from the account id so a
 * given lawyer keeps the same colour on every render.
 */
const AVATAR_TONES = [
  '#2B3440', // slate
  '#3A2E24', // bronze
  '#23343A', // deep teal
  '#312A3B', // plum
  '#2C3628', // olive
  '#3A2B2B', // oxblood
]

function avatarTone(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return AVATAR_TONES[hash % AVATAR_TONES.length]
}

// ── Shared mapper: DB row → public Lawyer card shape ─────────────────────────
function mapRow(d: any) {
  return {
    slug:            d.account_id,
    name:            `${d.first_name ?? ''} ${d.last_name ?? ''}`.trim(),
    initials:        `${d.first_name?.[0] ?? ''}${d.last_name?.[0] ?? ''}`,
    avatarBg:        avatarTone(String(d.account_id ?? d.first_name ?? '')),
    // The endpoint, not the storage path: the bucket is private, so the path
    // itself renders nothing.
    avatarUrl:       d.profile_photo_url ? `/api/lawyers/${d.account_id}/photo` : null,
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
      // Matches the ₹25/min floor the settings form enforces, so a lawyer who
      // never set a rate is not advertised below the platform minimum.
      chat:  Number(d.consultation_fee_chat)  || 25,
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

// ── GET /api/lawyers/me/stats ────────────────────────────────────────────────
/**
 * Real figures for the portal's headline cards.
 *
 * They were showing lawyer_profiles.cases_handled — a static profile field
 * nothing increments — and two literal em dashes. So a lawyer who had just
 * finished three consultations was told they had handled none, which reads as
 * the platform losing their work rather than as a stale placeholder.
 *
 * Everything here is counted from consultations at request time. Nothing is
 * cached and nothing is denormalised onto the profile, because a counter that
 * has to be kept in step is a counter that eventually is not.
 *
 * MUST be registered before GET /:slug.
 */
router.get('/me/stats', async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) return res.status(401).json({ error: 'Not authenticated' })
    if (user.role !== 'lawyer') return res.status(403).json({ error: 'Not a lawyer account' })

    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

    // Only completed ones count. A call nobody answered is not work done, and
    // billing already treats it that way.
    const [monthRes, allRes, reviewRes] = await Promise.all([
      supabase
        .from('consultations')
        .select('duration_seconds, total_amount')
        .eq('lawyer_id', user.id)
        .eq('status', 'completed')
        .gte('created_at', monthStart),
      supabase
        .from('consultations')
        .select('id', { count: 'exact', head: true })
        .eq('lawyer_id', user.id)
        .eq('status', 'completed'),
      supabase
        .from('reviews')
        .select('rating')
        .eq('account_id', user.id),
    ])

    const month = monthRes.data ?? []
    const seconds = month.reduce((sum, c) => sum + Number(c.duration_seconds ?? 0), 0)
    const earned = month.reduce((sum, c) => sum + Number(c.total_amount ?? 0), 0)

    const ratings = (reviewRes.data ?? []).map(r => Number(r.rating)).filter(n => Number.isFinite(n))
    const avgRating = ratings.length
      ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
      : null

    return res.json({
      consultationsThisMonth: month.length,
      totalHandled: allRes.count ?? 0,
      minutesThisMonth: Math.round(seconds / 60),
      earnedThisMonth: earned,
      avgRating,
      reviewCount: ratings.length,
    })
  } catch (err) {
    console.error('[lawyers/me/stats]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/lawyers/settings ────────────────────────────────────────────────
/**
 * What the lawyer can edit about themselves.
 *
 * The settings page has been calling this and PATCH /settings since it was
 * written, and neither existed: the GET 404'd into a catch that returned null,
 * so the form rendered empty, and Save 404'd silently. This is that endpoint.
 *
 * Everything here is read straight from lawyer_profiles and accounts — the same
 * rows the public directory and the admin portal read — so a change made here
 * shows up in both without anything needing to be copied across.
 *
 * MUST be registered before GET /:slug, or "settings" is read as a slug.
 */
router.get('/settings', async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) return res.status(401).json({ error: 'Not authenticated' })
    if (user.role !== 'lawyer') return res.status(403).json({ error: 'Not a lawyer account' })

    const { data, error } = await supabase
      .from('lawyer_profiles').select('*').eq('account_id', user.id).maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Complete onboarding first' })

    const { data: bank } = await supabase
      .from('lawyer_bank_details')
      .select('account_holder_name, ifsc_code, bank_name')
      .eq('account_id', user.id)
      .maybeSingle()

    return res.json({
      firstName:            data.first_name ?? '',
      lastName:             data.last_name ?? '',
      bio:                  data.bio ?? null,
      firmName:             data.firm_name ?? null,
      profilePhotoUrl:      data.profile_photo_url ?? null,
      languages:            data.languages ?? [],
      courtsPracticed:      data.courts_practiced ?? [],
      linkedinUrl:          data.linkedin_url ?? null,
      websiteUrl:           data.website_url ?? null,
      draftingEnabled:      (data.document_services ?? []).includes('drafting'),
      verificationEnabled:  (data.document_services ?? []).includes('verification'),
      consultationEnabled:  (data.consultation_types ?? []).length > 0,
      consultationTypes:    data.consultation_types ?? [],
      // Three rates, because the client pays a different price per channel and
      // the booking widget has always shown them separately.
      // 25, not 20: the settings form enforces a ₹25/min floor, so a fallback
      // of 20 produced a value the form immediately rejected — disabling Save
      // for any lawyer who had never set a rate, with nothing on screen to
      // explain why the button did nothing.
      feeChat:              Number(data.consultation_fee_chat)  || 25,
      feeVoice:             Number(data.consultation_fee_voice) || 30,
      feeVideo:             Number(data.consultation_fee_video) || 40,
      bankAccountName:      bank?.account_holder_name ?? null,
      bankIfsc:             bank?.ifsc_code ?? null,
      bankName:             bank?.bank_name ?? null,
      upiId:                data.upi_id ?? null,
      gstNumber:            data.gst_number ?? null,
      panNumber:            data.pan_number ?? null,
    })
  } catch (err) {
    console.error('[lawyers/settings GET]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PATCH /api/lawyers/settings ──────────────────────────────────────────────
/**
 * Only the fields present in the body are written, so the form can send a
 * partial update without blanking everything it did not include.
 *
 * verification_status is deliberately untouched: a lawyer editing their own
 * rate or photo is not re-applying, and must not be able to move themselves
 * through the approval queue.
 */
router.patch('/settings', validateBody(lawyerSettingsUpdateSchema), async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) return res.status(401).json({ error: 'Not authenticated' })
    if (user.role !== 'lawyer') return res.status(403).json({ error: 'Not a lawyer account' })

    const b = req.body as Record<string, unknown>
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }

    const map: [string, string][] = [
      ['firstName', 'first_name'], ['lastName', 'last_name'],
      ['bio', 'bio'], ['firmName', 'firm_name'],
      ['profilePhotoUrl', 'profile_photo_url'],
      ['languages', 'languages'], ['courtsPracticed', 'courts_practiced'],
      ['linkedinUrl', 'linkedin_url'], ['websiteUrl', 'website_url'],
      ['consultationTypes', 'consultation_types'],
      ['feeChat', 'consultation_fee_chat'],
      ['feeVoice', 'consultation_fee_voice'],
      ['feeVideo', 'consultation_fee_video'],
      ['upiId', 'upi_id'], ['gstNumber', 'gst_number'], ['panNumber', 'pan_number'],
    ]
    for (const [from, to] of map) {
      if (b[from] !== undefined) update[to] = b[from]
    }

    if (b.draftingEnabled !== undefined || b.verificationEnabled !== undefined) {
      const services: string[] = []
      if (b.draftingEnabled) services.push('drafting')
      if (b.verificationEnabled) services.push('verification')
      update.document_services = services
    }

    const { error } = await supabase
      .from('lawyer_profiles').update(update).eq('account_id', user.id)
    if (error) throw error

    // Bank details live in their own table, keyed by account. Upserted rather
    // than updated so a lawyer entering payout details for the first time
    // creates the row instead of writing to nothing.
    const bankTouched =
      b.bankAccountName !== undefined ||
      b.bankAccountNumber !== undefined ||
      b.bankIfsc !== undefined

    if (bankTouched) {
      const { data: existing } = await supabase
        .from('lawyer_bank_details').select('account_id').eq('account_id', user.id).maybeSingle()

      const bankRow: Record<string, unknown> = { account_id: user.id }
      if (b.bankAccountName !== undefined) bankRow.account_holder_name = b.bankAccountName
      if (b.bankIfsc !== undefined) bankRow.ifsc_code = b.bankIfsc
      // The account number is deliberately not written here. The column is
      // account_number_enc — encrypted — and there is no encryption helper in
      // this codebase, so writing the plaintext the form collects would put a
      // bank account number in the clear under a name that says otherwise.
      // It is captured during onboarding; changing it stays a support request
      // until that encryption exists.

      const { error: bankErr } = existing
        ? await supabase.from('lawyer_bank_details').update(bankRow).eq('account_id', user.id)
        : await supabase.from('lawyer_bank_details').insert(bankRow)

      if (bankErr) {
        console.error('[lawyers/settings PATCH] bank details', bankErr)
        return res.status(500).json({ error: 'Profile saved, but payout details could not be updated.' })
      }
    }

    // The display name lives in two places — the profile row the directory
    // reads and the account row the portal greets them by. Leaving one behind
    // renames them on the public site but not in their own header.
    if (b.firstName !== undefined || b.lastName !== undefined) {
      const nameUpdate: Record<string, unknown> = {}
      if (b.firstName !== undefined) nameUpdate.first_name = b.firstName
      if (b.lastName !== undefined) nameUpdate.last_name = b.lastName
      await supabase.from('accounts').update(nameUpdate).eq('id', user.id)
    }

    return res.json({ ok: true })
  } catch (err) {
    console.error('[lawyers/settings PATCH]', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/lawyers/:slug/photo ─────────────────────────────────────────────
/**
 * Redirects to a freshly signed URL for the lawyer's profile photo.
 *
 * profile_photo_url holds a storage path, not a link: uploads go to the private
 * legalx-lawyer-docs bucket, which a browser cannot read. Handing that path to
 * an <img> is why an uploaded photo never appeared and the page kept showing
 * initials.
 *
 * Signed on demand rather than stored, because a signed URL expires and a
 * profile photo has to keep working. Public by design — this is the picture the
 * directory shows — so no auth, but it only ever resolves the photo column and
 * nothing else in the bucket.
 */
router.get('/:slug/photo', async (req: Request, res: Response) => {
  try {
    const { data } = await supabase
      .from('lawyer_profiles')
      .select('profile_photo_url')
      .eq('account_id', String(req.params.slug))
      .maybeSingle()

    const path = data?.profile_photo_url
    if (!path) return res.status(404).json({ error: 'No photo' })

    // Already a full URL (an older record, or an external avatar) — pass it on.
    if (/^https?:\/\//i.test(path)) return res.redirect(302, path)

    const { data: signed, error } = await supabase.storage
      .from('legalx-lawyer-docs')
      .createSignedUrl(path, 3600)

    if (error || !signed?.signedUrl) {
      console.error('[lawyers/photo] sign failed', error)
      return res.status(404).json({ error: 'No photo' })
    }

    // Shorter than the signature's own life, so a cached redirect can never
    // outlive the URL it points at.
    res.set('Cache-Control', 'public, max-age=1800')
    return res.redirect(302, signed.signedUrl)
  } catch (err) {
    console.error('[lawyers/photo]', err)
    return res.status(404).json({ error: 'No photo' })
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
