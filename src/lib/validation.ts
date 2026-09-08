import { z } from 'zod'
import { Request, Response, NextFunction } from 'express'

export const leadCreateSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian phone number'),
  email: z.string().email().max(255).trim().optional().nullable(),
  serviceSlug: z.string().min(1).max(100),
  serviceTitle: z.string().min(1).max(200),
})

export const leadUpdateBodySchema = z.object({
  status: z.enum(['new', 'contacted', 'converted', 'dropped']),
})

export const leadIdParamSchema = z.object({
  id: z.string().uuid(),
})

export const applicationCreateSchema = z.object({
  leadId: z.string().uuid(),
  serviceSlug: z.string().min(1).max(100),
  formData: z.record(z.string(), z.unknown()),
})

export const applicationIdParamSchema = z.object({
  id: z.string().uuid(),
})

export const paymentCreateOrderSchema = z.object({
  applicationId: z.string().uuid(),
  leadId: z.string().uuid(),
  serviceSlug: z.string().min(1).max(100),
  amount: z.number().int().min(100),
})

export const paymentVerifySchema = z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
})

/**
 * The single password policy: 8+ chars, one uppercase, one number.
 *
 * Used by BOTH signup and reset. They diverged before — signup accepted any
 * 8 characters while reset demanded uppercase and a digit, so new accounts
 * could hold passwords the platform would refuse to let them set again.
 * Keep these pointed at the same schema.
 *
 * Note this only applies going forward: accounts created under the old rule
 * keep their existing password until they next reset it.
 */
const strongPasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/[0-9]/, 'Password must contain a number')

/**
 * Strict email validation — rejects bare strings like "123", "abc", or "no@domain".
 * Requires a proper user@domain.tld structure with a TLD of 2+ characters.
 * Zod's .email() covers the RFC basics; the regex tightens it against typo-domains.
 */
const strictEmailSchema = z
  .string()
  .email('Enter a valid email address')
  .max(255)
  .trim()
  .toLowerCase()
  .refine(
    (val) => /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(val),
    { message: 'Enter a valid email address (e.g. you@gmail.com)' }
  )

export const authSignupSchema = z.object({
  email: strictEmailSchema,
  password: strongPasswordSchema,
  firstName: z.string().min(1).max(50).trim(),
  lastName: z.string().min(1).max(50).trim(),
  role: z.enum(['client', 'lawyer']).default('client'),
})

/**
 * Step 1 of signup: request an OTP. Validates all fields up front so the user
 */
export const signupRequestOtpSchema = z.object({
  email: strictEmailSchema,
  password: strongPasswordSchema,
  firstName: z.string().min(1).max(50).trim(),
  lastName: z.string().min(1).max(50).trim(),
  role: z.enum(['client', 'lawyer']).default('client'),
})

/** Step 2 of signup: verify the OTP and create the account. */
export const signupVerifyOtpSchema = z.object({
  email: strictEmailSchema,
  otp: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your email'),
  password: strongPasswordSchema,
  firstName: z.string().min(1).max(50).trim(),
  lastName: z.string().min(1).max(50).trim(),
  role: z.enum(['client', 'lawyer']).default('client'),
})

// Login deliberately does NOT use the strong schema — existing users may hold
// weaker passwords, and rejecting them here would lock them out of the very
// flow that lets them upgrade.
export const authLoginSchema = z.object({
  email: z.string().email().max(255).trim().toLowerCase(),
  password: z.string().min(1).max(128),
})

export const authForgotPasswordSchema = z.object({
  email: z.string().email().max(255).trim().toLowerCase(),
  // Untrusted — checked against the origin allowlist before use.
  origin: z.string().max(255).optional(),
})

export const authResetPasswordSchema = z.object({
  email: z.string().email().max(255).trim().toLowerCase(),
  // Supabase currently issues 8-digit recovery codes, but MAILER_OTP_LENGTH is
  // configurable — accept the whole supported range so a dashboard change
  // cannot silently break resets.
  otp: z.string().trim().regex(/^\d{6,10}$/, 'Enter the code from your email'),
  password: strongPasswordSchema,
})

// ── Contact form ──────────────────────────────────────────────────────────────

export const contactFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100).trim(),
  email: strictEmailSchema,
  subject: z.string().min(1, 'Subject is required').max(200).trim(),
  message: z.string().min(10, 'Message must be at least 10 characters').max(2000).trim(),
})

/**
 * Lawyer's own profile edits. Every field optional — the settings form sends a
 * partial update, and a missing key must mean "leave it alone" rather than
 * "clear it". Nothing here can change verification status: editing a rate is
 * not re-applying for approval.
 */
export const lawyerSettingsUpdateSchema = z.object({
  firstName: z.string().min(1).max(50).trim().optional(),
  lastName: z.string().min(1).max(50).trim().optional(),
  bio: z.string().max(3000).trim().nullable().optional(),
  firmName: z.string().max(150).trim().nullable().optional(),
  profilePhotoUrl: z.string().max(1000).trim().nullable().optional(),
  languages: z.array(z.string().max(40)).max(12).optional(),
  courtsPracticed: z.array(z.string().max(80)).max(20).optional(),
  linkedinUrl: z.string().max(300).trim().nullable().optional(),
  websiteUrl: z.string().max(300).trim().nullable().optional(),
  draftingEnabled: z.boolean().optional(),
  verificationEnabled: z.boolean().optional(),
  consultationTypes: z.array(z.enum(['chat', 'voice', 'video'])).max(3).optional(),
  // Floor of 25/min is platform policy; the ceiling stops a typo turning a
  // 30-rupee call into a 30,000-rupee one.
  feeChat: z.coerce.number().min(25).max(5000).optional(),
  feeVoice: z.coerce.number().min(25).max(5000).optional(),
  feeVideo: z.coerce.number().min(25).max(5000).optional(),
  upiId: z.string().max(100).trim().nullable().optional(),
  gstNumber: z.string().max(20).trim().nullable().optional(),
  panNumber: z.string().max(15).trim().nullable().optional(),
  // The settings form has always sent these. Without them in the schema they
  // were stripped by validateBody and dropped in silence — the fields would
  // reappear empty on the next load with no error to explain it.
  bankAccountName: z.string().max(120).trim().nullable().optional(),
  bankIfsc: z.string().max(15).trim().nullable().optional(),
})

export const lawyerIdParamSchema = z.object({
  id: z.string().uuid(),
})

/**
 * What the admin needs from the lawyer. Required and reasonably long: the
 * message is sent to them verbatim, and "send more documents" helps nobody.
 */
export const adminRequestInfoSchema = z.object({
  message: z.string().min(10, 'Say what is needed — this is emailed to the lawyer').max(1000).trim(),
})

export const adminLawyerRejectBodySchema = z.object({
  reason: z.string().max(500).optional(),
})

// ── Admin portal ──────────────────────────────────────────────────────────────

/** Shared list pagination. Capped so one request cannot pull the whole table. */
export const adminListQuerySchema = z.object({
  status: z.string().max(50).optional(),
  search: z.string().max(120).trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export const adminAuditQuerySchema = z.object({
  entity_type: z.string().max(50).optional(),
  from: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  to: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

export const adminSuspendBodySchema = z.object({
  reason: z.string().min(3, 'A reason is required').max(500).trim(),
})

export const adminReinstateBodySchema = z.object({
  reason: z.string().max(500).trim().optional(),
})

export const adminFlagBodySchema = z.object({
  type: z.enum(['complaint', 'warning', 'suspension', 'reinstatement']),
  reason: z.string().min(3, 'A reason is required').max(500).trim(),
})

export const adminBulkLawyerSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, 'Select at least one lawyer').max(100),
  action: z.enum(['approve', 'reject']),
  reason: z.string().max(500).trim().optional(),
})

export const adminWalletAdjustSchema = z.object({
  // Rupees, two decimals. Positive only — direction comes from `type`, so a
  // negative amount on a credit can't silently invert the operation.
  amount: z.coerce.number().positive('Amount must be greater than zero').max(1_000_000),
  type: z.enum(['credit', 'debit']),
  reason: z.string().min(3, 'A reason is required').max(500).trim(),
})

export const accountIdParamSchema = z.object({
  id: z.string().uuid(),
})

// ── Account deletion (admin portal) ───────────────────────────────────────────

/** One list covering every account, whatever its role. */
export const adminAccountListQuerySchema = z.object({
  role: z.enum(['all', 'client', 'lawyer', 'admin']).default('all'),
  search: z.string().max(120).trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

/**
 * Deleting an account is irreversible and unwinds rows across a dozen tables,
 * so it takes more than a click: the admin retypes the account's email address
 * and states a reason, both of which are stored on the tombstone.
 */
export const adminAccountDeleteSchema = z.object({
  confirmEmail: z.string().max(255).trim().toLowerCase(),
  reason: z.string().min(5).max(500).trim(),
})

export const adminDisputeUpdateSchema = z.object({
  status: z.enum(['open', 'investigating', 'resolved', 'escalated']),
  resolutionNote: z.string().max(2000).trim().optional(),
})

export const adminPayoutGenerateSchema = z.object({
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
})

export const adminPayoutHoldSchema = z.object({
  reason: z.string().min(3, 'A reason is required').max(500).trim(),
})

export const adminPayoutStatusSchema = z.object({
  status: z.enum(['pending', 'processing', 'paid', 'cancelled']),
  bankRef: z.string().max(120).trim().optional(),
})

export const adminArticleSchema = z.object({
  title: z.string().min(3).max(200).trim(),
  slug: z.string().min(3).max(200).trim().regex(/^[a-z0-9-]+$/, 'Slug must be lowercase letters, numbers and hyphens'),
  content: z.string().max(100_000),
  status: z.enum(['draft', 'published']).default('draft'),
})

export const adminArticleUpdateSchema = adminArticleSchema.partial()

export const uuidParamSchema = z.object({
  id: z.string().uuid(),
})

// ── Legal shorts ──────────────────────────────────────────────────────────────

export const shortsIngestSchema = z.object({
  // Public link to the source. Stored as the citation and, being UNIQUE,
  // doubles as the duplicate guard.
  sourceUrl: z.string().url().max(1000),
  // Optional: when omitted the backend fetches the URL. Required for PDFs and
  // captcha-gated portals, where an operator pastes the text instead.
  rawText: z.string().max(400_000).optional(),
  sourceName: z.string().max(120).trim().optional(),
})

export const shortsAutoIngestSchema = z.object({
  feeds: z.array(z.string().max(50)).max(10).optional(),
  // How many suggestions to propose. Deliberately more than will be published —
  // the editor keeps the best few. Capped because each one costs an LLM call
  // and the Groq free tier is 8,000 tokens/minute.
  limit: z.coerce.number().int().min(1).max(20).default(8),
})

export const shortsBulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, 'Select at least one').max(50),
  action: z.enum(['approve', 'reject']),
  reason: z.string().max(500).trim().optional(),
})

/**
 * Know Your Rights review queue.
 *
 * The batch cap is higher than the shorts equivalent: this is a one-off
 * backlog of 182 imported explainers rather than a daily trickle, and an
 * editor working through a category wants to clear it in a few passes.
 */
export const knowledgeBulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, 'Select at least one').max(200),
  action: z.enum(['approve', 'reject']),
  reason: z.string().max(500).trim().optional(),
})

export const knowledgeListQuerySchema = z.object({
  status: z.enum(['pending', 'published', 'rejected', 'all']).default('pending'),
  category: z.string().max(60).trim().optional(),
  search: z.string().max(120).trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
})

export const shortsUpdateSchema = z.object({
  title: z.string().min(3).max(255).trim().optional(),
  summary: z.string().min(10).max(5000).trim().optional(),
  takeaway: z.string().max(2000).trim().optional(),
  category: z.string().max(100).trim().optional(),
  court: z.string().max(150).trim().optional(),
  judgmentDate: z.string().date().optional(),
  tags: z.array(z.string().max(40)).max(8).optional(),
  isPublished: z.boolean().optional(),
})

export function validateBody<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.flatten().fieldErrors,
      })
    }
    req.body = result.data
    next()
  }
}

export function validateParams<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params)
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.flatten().fieldErrors,
      })
    }
    req.params = result.data as Record<string, string>
    next()
  }
}

declare global {
  namespace Express {
    interface Request {
      /** Parsed + coerced query params, populated by validateQuery(). */
      validatedQuery?: unknown
    }
  }
}

export function validateQuery<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query)
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.flatten().fieldErrors,
      })
    }
    // Express 5 exposes req.query through a getter with no setter — assigning
    // to it throws at runtime. The coerced result is attached separately so
    // handlers get real numbers/defaults instead of raw strings.
    req.validatedQuery = result.data
    next()
  }
}