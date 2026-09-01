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

export const authSignupSchema = z.object({
  email: z.string().email().max(255).trim().toLowerCase(),
  password: z.string().min(8).max(128),
  firstName: z.string().min(1).max(50).trim(),
  lastName: z.string().min(1).max(50).trim(),
  role: z.enum(['client', 'lawyer']).default('client'),
})

export const authLoginSchema = z.object({
  email: z.string().email().max(255).trim().toLowerCase(),
  password: z.string().min(1).max(128),
})

/** Mirrors the client-side rule shown on /reset-password: 8+ chars, 1 uppercase, 1 number. */
const strongPasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/[0-9]/, 'Password must contain a number')

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