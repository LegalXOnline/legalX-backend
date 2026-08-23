import { Router, Request, Response, NextFunction } from 'express'
import { supabase } from '../lib/supabase'

const router = Router()

// ── Shared mapper: DB row → public Lawyer shape ───────────────────────────────
function mapRow(d: any) {
  return {
    slug:            d.account_id,
    name:            `${d.first_name ?? ''} ${d.last_name ?? ''}`.trim(),
    initials:        `${d.first_name?.[0] ?? ''}${d.last_name?.[0] ?? ''}`,
    avatarBg:        '#1a3a5c',
    barNumber:       d.bar_council_number ?? '',
    verified:        d.verification_status === 'verified',
    online:          d.is_online ?? false,
    specializations: d.specializations ?? [],
    primarySpec:     d.primary_specialization ?? 'General Practice',
    experience:      d.years_experience ?? 0,
    location:        d.city ?? 'India',
    languages:       d.languages ?? ['English'],
    rating:          Number(d.avg_rating) || 0,
    reviewCount:     d.total_reviews || 0,
    casesHandled:    d.cases_handled || 0,
    bio:             d.bio ?? '',
    education:       d.education ?? [],
    expertise:       d.expertise ?? [],
    achievements:    d.achievements ?? [],
    fees: {
      chat:  Number(d.consultation_fee_chat)  || 20,
      voice: Number(d.consultation_fee_voice) || 30,
      video: Number(d.consultation_fee_video) || 40,
    },
    reviews: d.reviews ?? [],
  }
}

// ── Auth helper ───────────────────────────────────────────────────────────────
async function getAuthUser(req: Request) {
  const token =
    req.cookies?.lx_access_token ||
    req.headers.authorization?.replace("Bearer ", "")
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  return data.user
}

// ── PATCH /api/lawyers/me/status ─────────────────────────────────────────────
// MUST be before GET /:slug — otherwise slug wildcard intercepts "me"
// Lawyer toggles online/offline availability.
router.patch("/me/status", async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: "Not authenticated" }); return }
    if (user.user_metadata?.role !== "lawyer") {
      res.status(403).json({ error: "Only lawyers can update availability status" }); return
    }

    const { isOnline } = req.body
    if (typeof isOnline !== "boolean") {
      res.status(400).json({ error: "isOnline must be a boolean" }); return
    }

    const { error: updateError } = await supabase
      .from("lawyer_profiles")
      .update({ is_online: isOnline, last_seen_at: new Date().toISOString() })
      .eq("account_id", user.id)

    if (updateError) {
      res.status(500).json({ error: "Failed to update status" }); return
    }

    res.json({ isOnline, message: `Status set to ${isOnline ? "online" : "offline"}` })
  } catch {
    res.status(500).json({ error: "Internal server error" })
  }
})

// ── GET /api/lawyers ─────────────────────────────────────────────────────────
router.get("/", async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from("lawyer_profiles")
      .select("*")
      .eq("verification_status", "verified")
      .order("avg_rating", { ascending: false })

    if (error) {
      console.warn("[lawyers] DB query failed, returning empty list:", error.message)
      res.json({ lawyers: [] })
      return
    }
    res.json({ lawyers: (data ?? []).map(mapRow) })
  } catch (err) {
    console.error("[lawyers] Unexpected error:", err)
    res.json({ lawyers: [] })
  }
})

// ── GET /api/lawyers/:slug ───────────────────────────────────────────────────
// MUST be last — wildcard would otherwise match "/me/status"
router.get("/:slug", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { slug } = req.params
    // Prevent slug from matching internal paths
    if (slug === "me") { res.status(400).json({ error: "Invalid route" }); return }

    const { data, error } = await supabase
      .from("lawyer_profiles")
      .select("*")
      .eq("account_id", slug)
      .single()

    if (error || !data) {
      res.status(404).json({ error: "Lawyer not found" })
      return
    }

    res.json({ lawyer: mapRow(data) })
  } catch (err) {
    next(err)
  }
})

export default router
