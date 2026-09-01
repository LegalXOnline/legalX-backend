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

export const authSignupSchema = z.object({
  email: z.string().email().max(255).trim().toLowerCase(),
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

export const lawyerIdParamSchema = z.object({
  id: z.string().uuid(),
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
  // The official court URL this text came from. Stored as the public citation
  // link and, being UNIQUE, doubles as the duplicate guard.
  sourceUrl: z.string().url().max(1000),
  // Pasted judgment text. Required — the official portals are captcha-gated, so
  // an operator supplies the text rather than a scraper fetching it.
  rawText: z.string().min(200, 'Paste at least 200 characters of the judgment').max(400_000),
  court: z.string().max(150).trim().optional(),
  judgmentDate: z.string().date().optional(),
})

export const shortsAutoIngestSchema = z.object({
  feed: z.string().min(1).max(50),
  // Capped: each document costs an Indian Kanoon call plus an LLM call, and
  // the Groq free tier is 8,000 tokens/minute.
  limit: z.coerce.number().int().min(1).max(10).default(3),
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