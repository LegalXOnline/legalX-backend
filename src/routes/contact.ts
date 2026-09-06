import { Router, Request, Response, NextFunction } from 'express'
import { rateLimit } from 'express-rate-limit'
import { isProduction } from '../lib/env'
import { sendContactFormEmail, sendContactFormConfirmation } from '../lib/email'
import { validateBody, contactFormSchema } from '../lib/validation'

const router = Router()

// Tight rate limit — 5 submissions per hour per IP
const contactLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: isProduction },
  message: { error: 'Too many contact submissions. Please wait an hour and try again.' },
})

// ── POST /api/contact ─────────────────────────────────────────────────────────
// Public endpoint for the "Get in Touch" / "Inquiry Form" contact forms.
// Sends an email notification to admin and a confirmation to the sender.
router.post('/', contactLimit, validateBody(contactFormSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, subject, message } = req.body

    // Fire-and-forget emails — don't block the response on delivery
    sendContactFormEmail({ name, email, subject, message }).catch(console.error)
    sendContactFormConfirmation(email, name).catch(console.error)

    res.status(200).json({ message: 'Your message has been sent. We will get back to you within 24 hours.' })
  } catch (err) {
    next(err)
  }
})

export default router
