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

export const lawyerIdParamSchema = z.object({
  id: z.string().uuid(),
})

export const adminLawyerRejectBodySchema = z.object({
  reason: z.string().max(500).optional(),
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

export function validateQuery<T extends z.ZodType>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query)
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.flatten().fieldErrors,
      })
    }
    req.query = result.data as Record<string, string>
    next()
  }
}