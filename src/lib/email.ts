import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY!)
const ADMIN = process.env.ADMIN_EMAIL || 'contact@legalxonline.com'
const FROM = 'LegalX <noreply@legalxonline.com>'

// ── Alert admin about a new lead
export async function sendLeadAlert(lead: {
  name: string
  phone: string
  email?: string
  serviceTitle: string
}) {
  try {
    await resend.emails.send({
      from: FROM,
      to: ADMIN,
      subject: `New Lead: ${lead.name} — ${lead.serviceTitle}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="margin:0 0 16px;color:#111">New Lead on LegalX</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#555;width:120px">Name</td>
                <td style="padding:8px 0;font-weight:600;color:#111">${lead.name}</td></tr>
            <tr><td style="padding:8px 0;color:#555">Phone</td>
                <td style="padding:8px 0;font-weight:600;color:#111">${lead.phone}</td></tr>
            ${lead.email ? `<tr><td style="padding:8px 0;color:#555">Email</td>
                <td style="padding:8px 0;color:#111">${lead.email}</td></tr>` : ''}
            <tr><td style="padding:8px 0;color:#555">Service</td>
                <td style="padding:8px 0;font-weight:600;color:#f5a623">${lead.serviceTitle}</td></tr>
          </table>
          <p style="margin:20px 0 0;color:#888;font-size:13px">
            Received at ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
          </p>
        </div>
      `,
    })
  } catch (err) {
    // Non-fatal — log but don't crash the request
    console.error('[email] lead alert failed:', err)
  }
}

// ── Confirm to user that we received their request
export async function sendUserConfirmation(to: string, name: string, serviceTitle: string) {
  if (!to) return
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `We received your ${serviceTitle} request — LegalX`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="margin:0 0 12px;color:#111">Hi ${name},</h2>
          <p style="color:#555;line-height:1.6">
            Thank you for reaching out. We have received your request for 
            <strong>${serviceTitle}</strong>.
          </p>
          <p style="color:#555;line-height:1.6">
            Our team will call you within <strong>24 hours</strong> to guide you through the next steps.
          </p>
          <div style="margin:24px 0;padding:16px;background:#fafafa;border-left:4px solid #f5a623">
            <p style="margin:0;color:#333;font-size:14px">
              If you have any urgent questions, email us at
              <a href="mailto:contact@legalxonline.com" style="color:#f5a623">contact@legalxonline.com</a>
            </p>
          </div>
          <p style="color:#888;font-size:12px;margin-top:32px">LegalX Online · Nandlalpur, Kahalgaon, Bhagalpur, Bihar – 813222</p>
        </div>
      `,
    })
  } catch (err) {
    console.error('[email] user confirmation failed:', err)
  }
}

// ── Payment success email
export async function sendPaymentSuccess(opts: {
  toEmail?: string
  name: string
  serviceTitle: string
  amount: number
  applicationId: string
}) {
  const amountRs = (opts.amount / 100).toLocaleString('en-IN')
  // Alert admin
  await resend.emails.send({
    from: FROM,
    to: ADMIN,
    subject: `Payment Received: ${opts.name} — ${opts.serviceTitle} (₹${amountRs})`,
    html: `<p>Payment of ₹${amountRs} received for <b>${opts.serviceTitle}</b> from ${opts.name}.<br>Application ID: ${opts.applicationId}</p>`,
  }).catch(console.error)

  // Confirm to user
  if (opts.toEmail) {
    await resend.emails.send({
      from: FROM,
      to: opts.toEmail,
      subject: `Payment confirmed — ${opts.serviceTitle} | LegalX`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="color:#111">Payment Confirmed ✓</h2>
          <p style="color:#555">Hi ${opts.name}, your payment of <strong>₹${amountRs}</strong> for
          <strong>${opts.serviceTitle}</strong> has been received.</p>
          <p style="color:#555">Your application reference: <code style="background:#f4f4f4;padding:2px 6px;border-radius:4px">${opts.applicationId.slice(0,8).toUpperCase()}</code></p>
          <p style="color:#555">We will begin processing your application and update you within 24 hours.</p>
        </div>
      `,
    }).catch(console.error)
  }
}

// ── Welcome new user
export async function sendWelcomeEmail(to: string, name: string, role: string) {
  if (!to) return
  const roleText = role === 'lawyer' ? 'Lawyer Account' : 'Client Account'
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `Welcome to LegalXOnline — Your ${roleText} is ready`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="margin:0 0 12px;color:#111">Welcome to LegalX, ${name}!</h2>
          <p style="color:#555;line-height:1.6">
            Your <strong>${roleText}</strong> has been successfully created.
          </p>
          <p style="color:#555;line-height:1.6">
            You can now log in to your dashboard to access India's most trusted legal tech platform.
          </p>
          <div style="margin-top:32px;padding-top:24px;border-top:1px solid #eee;color:#888;font-size:12px">
            LegalXOnline Team<br/>
            contact@legalxonline.com
          </div>
        </div>
      `,
    })
  } catch (err) {
    console.error('[email] welcome email failed:', err)
  }
}

// ── Notify admin + lawyer when a new lawyer registers (pending verification) ──
// Admin gets an alert to review and verify the lawyer.
// Lawyer gets a "we received your application" email.
export async function sendLawyerApplicationEmail(opts: {
  lawyerEmail: string
  lawyerFirstName: string
  lawyerLastName: string
}) {
  const name = `${opts.lawyerFirstName} ${opts.lawyerLastName}`.trim()

  // 1. Alert admin at domain email (contact@legalxonline.com)
  try {
    await resend.emails.send({
      from: FROM,
      to: ADMIN,
      subject: `New Lawyer Application: ${name} — Pending Verification`,
      html: `
        <div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px">
          <h2 style="margin:0 0 16px;color:#111;border-bottom:2px solid #C9A227;padding-bottom:12px">
            New Lawyer Application
          </h2>
          <table style="width:100%;border-collapse:collapse">
            <tr>
              <td style="padding:8px 0;color:#555;width:140px;font-size:14px">Name</td>
              <td style="padding:8px 0;font-weight:600;color:#111;font-size:14px">${name}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#555;font-size:14px">Email</td>
              <td style="padding:8px 0;color:#111;font-size:14px">
                <a href="mailto:${opts.lawyerEmail}" style="color:#C9A227">${opts.lawyerEmail}</a>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:#555;font-size:14px">Status</td>
              <td style="padding:8px 0;font-size:14px">
                <span style="background:#FFF3CD;color:#856404;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px">
                  PENDING VERIFICATION
                </span>
              </td>
            </tr>
          </table>
          <div style="margin-top:24px;padding:16px;background:#fafafa;border-left:4px solid #C9A227;border-radius:4px">
            <p style="margin:0;color:#333;font-size:14px">
              Please log in to the <strong>LegalX Admin Panel</strong> to review this application,
              verify bar council credentials, and approve or reject the lawyer's account.
            </p>
          </div>
          <p style="margin:20px 0 0;color:#888;font-size:12px">
            Received at ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
          </p>
        </div>
      `,
    })
  } catch (err) {
    console.error('[email] lawyer admin alert failed:', err)
  }

  // 2. Send "application received" email to the lawyer
  try {
    await resend.emails.send({
      from: FROM,
      to: opts.lawyerEmail,
      subject: `Your LegalX Lawyer Application Has Been Received`,
      html: `
        <div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px">
          <div style="text-align:center;margin-bottom:24px">
            <h1 style="font-size:28px;font-weight:800;color:#111;letter-spacing:-0.5px;margin:0">
              Legal<span style="color:#C9A227">X</span>
            </h1>
            <p style="color:#888;font-size:13px;margin:4px 0 0">legalxonline.com</p>
          </div>

          <h2 style="margin:0 0 12px;color:#111">Application Received, ${opts.lawyerFirstName}!</h2>

          <p style="color:#555;line-height:1.7;font-size:15px">
            Thank you for applying to join <strong>LegalX</strong> as a verified lawyer.
            We have received your application and our team is reviewing your credentials.
          </p>

          <div style="margin:24px 0;padding:20px;background:#F8F9FA;border-radius:8px;border:1px solid #E9ECEF">
            <h3 style="margin:0 0 12px;color:#333;font-size:14px;text-transform:uppercase;letter-spacing:0.5px">
              What Happens Next
            </h3>
            <ol style="margin:0;padding-left:20px;color:#555;font-size:14px;line-height:1.8">
              <li>Our team verifies your Bar Council registration</li>
              <li>We may reach out for additional documents if needed</li>
              <li>Once verified, your profile will be live on the platform</li>
              <li>You'll receive a confirmation email with login instructions</li>
            </ol>
          </div>

          <p style="color:#555;line-height:1.7;font-size:14px">
            This process typically takes <strong>1–2 business days</strong>.
            If you have any questions, reply to this email or contact us at
            <a href="mailto:contact@legalxonline.com" style="color:#C9A227;text-decoration:none">contact@legalxonline.com</a>.
          </p>

          <div style="margin-top:32px;padding-top:20px;border-top:1px solid #EEE;color:#999;font-size:12px;text-align:center">
            LegalXOnline · Nandlalpur, Kahalgaon, Bhagalpur, Bihar – 813222<br/>
            <a href="https://legalxonline.com" style="color:#C9A227;text-decoration:none">legalxonline.com</a>
          </div>
        </div>
      `,
    })
  } catch (err) {
    console.error('[email] lawyer confirmation email failed:', err)
  }
}

// ── Alert admin when documents are submitted but payment not yet made ─────────
// Fires immediately after POST /api/applications completes.
// A second "Payment Received" email fires after POST /api/payment/verify succeeds.
export async function sendDocumentsSubmittedAlert(opts: {
  name: string
  phone: string
  email?: string
  serviceTitle: string
  applicationId: string
}) {
  const shortId = opts.applicationId.slice(0, 8).toUpperCase()
  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })

  try {
    await resend.emails.send({
      from: FROM,
      to: ADMIN,
      subject: `📋 Documents Submitted (Awaiting Payment): ${opts.name} — ${opts.serviceTitle}`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="margin:0 0 6px;color:#111;font-size:20px">
            📋 Documents Submitted — Awaiting Payment
          </h2>
          <p style="margin:0 0 20px;color:#888;font-size:13px">
            Application Ref: <code style="background:#f4f4f4;padding:2px 6px;border-radius:4px;font-weight:600">${shortId}</code>
          </p>

          <div style="background:#FFF9E6;border:1px solid #F5D76E;border-radius:8px;padding:16px 20px;margin-bottom:20px">
            <p style="margin:0;color:#856404;font-size:14px;font-weight:600">
              ⚠️ Payment has NOT been received yet. Do not begin processing until payment is confirmed.
            </p>
          </div>

          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr style="border-bottom:1px solid #EEE">
              <td style="padding:10px 0;color:#666;width:130px">Client Name</td>
              <td style="padding:10px 0;font-weight:600;color:#111">${opts.name}</td>
            </tr>
            <tr style="border-bottom:1px solid #EEE">
              <td style="padding:10px 0;color:#666">Phone</td>
              <td style="padding:10px 0;color:#111"><a href="tel:${opts.phone}" style="color:#C9A227;text-decoration:none">${opts.phone}</a></td>
            </tr>
            ${opts.email ? `
            <tr style="border-bottom:1px solid #EEE">
              <td style="padding:10px 0;color:#666">Email</td>
              <td style="padding:10px 0;color:#111"><a href="mailto:${opts.email}" style="color:#C9A227;text-decoration:none">${opts.email}</a></td>
            </tr>` : ''}
            <tr style="border-bottom:1px solid #EEE">
              <td style="padding:10px 0;color:#666">Service</td>
              <td style="padding:10px 0;font-weight:600;color:#C9A227">${opts.serviceTitle}</td>
            </tr>
            <tr>
              <td style="padding:10px 0;color:#666">Status</td>
              <td style="padding:10px 0">
                <span style="background:#FFF3CD;color:#856404;padding:3px 10px;border-radius:20px;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.5px">
                  Awaiting Payment
                </span>
              </td>
            </tr>
          </table>

          <div style="margin-top:24px;padding:16px;background:#fafafa;border-radius:8px;border-left:4px solid #C9A227">
            <p style="margin:0;color:#333;font-size:13px;line-height:1.6">
              Documents have been uploaded and saved. You will receive a second email
              <strong>"Payment Received"</strong> once the client completes payment via Razorpay.
            </p>
          </div>

          <p style="margin:20px 0 0;color:#aaa;font-size:12px">Submitted at ${timestamp} IST</p>
        </div>
      `,
    })
  } catch (err) {
    console.error('[email] documents-submitted alert failed:', err)
  }
}

// ── Lawyer: onboarding welcome (sent at signup) ───────────────────────────────
export async function sendLawyerOnboardingWelcome(email: string, firstName: string) {
  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: 'Complete Your Lawyer Profile — LegalXOnline',
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="margin:0 0 8px;color:#111;font-size:22px">Welcome, ${firstName}</h2>
          <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 20px">
            Your LegalX lawyer account has been created. To go live and receive client consultations,
            you need to complete your professional profile and submit your Bar Council credentials for verification.
          </p>
          <div style="background:#F9F6EF;border-left:4px solid #C9A227;padding:16px 20px;border-radius:4px;margin-bottom:24px">
            <p style="margin:0;color:#7A6010;font-size:14px;font-weight:600">
              Your profile will not be visible to clients until verification is complete.
            </p>
          </div>
          <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 16px">
            Please keep the following documents ready before starting:
          </p>
          <ul style="color:#333;font-size:14px;line-height:2;padding-left:20px;margin:0 0 24px">
            <li>Bar Council Enrolment Certificate</li>
            <li>Bar Council ID Card (front and back)</li>
            <li>Government ID — PAN Card, Aadhaar Card, or Passport</li>
            <li>Professional photo (headshot)</li>
            <li>Bank account details for consultation payouts</li>
          </ul>
          <a href="https://legalxonline.com/onboarding/lawyer"
             style="display:inline-block;background:#C9A227;color:#fff;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px">
            Complete My Profile
          </a>
          <p style="color:#aaa;font-size:12px;margin-top:32px">
            If you did not create this account, please ignore this email or contact
            <a href="mailto:contact@legalxonline.com" style="color:#C9A227">contact@legalxonline.com</a>.
          </p>
        </div>
      `,
    })
  } catch (err) {
    console.error('[email] sendLawyerOnboardingWelcome failed:', err)
  }
}

// ── Ops alert: summarisation provider degraded ────────────────────────────────
// Throttled in-process so a burst of failures during one ingest run sends one
// email, not thirty. Resets when the backend restarts, which is acceptable —
// the alert is a nudge to check a key, not an incident pager.
let lastProviderAlert = 0
const PROVIDER_ALERT_INTERVAL_MS = 60 * 60 * 1000

export async function sendProviderFailureAlert(opts: {
  provider: string
  reason: string
  fallbackProvider: string | null
}): Promise<void> {
  if (Date.now() - lastProviderAlert < PROVIDER_ALERT_INTERVAL_MS) return
  lastProviderAlert = Date.now()

  try {
    await resend.emails.send({
      from: FROM,
      to: ADMIN,
      subject: `⚠️ LegalX: ${opts.provider} summarisation is failing`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="margin:0 0 8px;color:#111;font-size:20px">Summarisation provider failing</h2>
          <p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 20px">
            The Knowledge Center pipeline could not reach <strong>${opts.provider}</strong>.
            ${opts.fallbackProvider
              ? `It has fallen back to <strong>${opts.fallbackProvider}</strong>, so cards are still being produced — but on a smaller free tier.`
              : 'There is no fallback configured, so no new cards are being produced.'}
          </p>
          <div style="background:#FFF5F5;border-left:4px solid #EF4444;padding:16px 20px;border-radius:4px;margin-bottom:24px">
            <p style="margin:0 0 6px;color:#7F1D1D;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">Reason</p>
            <p style="margin:0;color:#991B1B;font-size:14px;line-height:1.6">${opts.reason}</p>
          </div>
          <p style="color:#555;font-size:14px;line-height:1.7">
            Most likely causes: the API key has expired or been revoked, billing is
            not enabled, or the daily free quota is exhausted.
          </p>
          <p style="color:#aaa;font-size:12px;margin-top:28px">
            Sent at ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.
            Further alerts are suppressed for one hour.
          </p>
        </div>
      `,
    })
  } catch (err) {
    console.error('[email] sendProviderFailureAlert failed:', err)
  }
}

// ── Password reset ────────────────────────────────────────────────────────────
// Sends a one-time code rather than a clickable link. Mail providers (Gmail,
// Outlook, corporate scanners) pre-fetch links to check them for malware, and
// because Supabase recovery links are single-use that pre-fetch consumes the
// token — the real user then lands on an "expired" page having clicked nothing.
// A code cannot be consumed by a scanner.
//
// Delivered through Resend, not Supabase's built-in mailer, which is capped at
// a handful of messages per hour and unusable in production.
export async function sendPasswordResetEmail(email: string, otp: string, firstName?: string) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,'
  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: `${otp} is your LegalX password reset code`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <div style="text-align:center;margin-bottom:28px">
            <h1 style="font-size:28px;font-weight:800;color:#111;letter-spacing:-0.5px;margin:0">
              Legal<span style="color:#C9A227">X</span>
            </h1>
            <p style="color:#888;font-size:13px;margin:4px 0 0">legalxonline.com</p>
          </div>

          <h2 style="margin:0 0 8px;color:#111;font-size:22px">Your password reset code</h2>
          <p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 24px">
            ${greeting} we received a request to reset the password for your LegalX
            account. Enter the code below to choose a new password.
          </p>

          <div style="background:#F9F6EF;border:1px solid #E8DCC0;border-radius:10px;padding:24px;text-align:center;margin:0 0 24px">
            <p style="margin:0 0 10px;color:#7A6010;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px">
              Reset Code
            </p>
            <p style="margin:0;color:#111;font-size:34px;font-weight:800;letter-spacing:9px;font-family:'Courier New',monospace">
              ${otp}
            </p>
          </div>

          <p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 24px">
            This code expires in <strong>1 hour</strong> and can only be used once.
            Never share it with anyone — LegalX staff will never ask you for it.
          </p>

          <div style="margin-top:32px;padding-top:20px;border-top:1px solid #EEE">
            <p style="color:#888;font-size:12px;line-height:1.6;margin:0">
              <strong>Didn't request this?</strong> You can safely ignore this email —
              your password will not change. If you're concerned, contact us at
              <a href="mailto:contact@legalxonline.com" style="color:#C9A227">contact@legalxonline.com</a>.
            </p>
            <p style="color:#aaa;font-size:11px;margin:16px 0 0;text-align:center">
              LegalXOnline · Nandlalpur, Kahalgaon, Bhagalpur, Bihar – 813222
            </p>
          </div>
        </div>
      `,
    })
  } catch (err) {
    console.error('[email] sendPasswordResetEmail failed:', err)
  }
}

// ── Lawyer: documents submitted — admin notification with signed URLs ──────────
export async function sendLawyerDocsSubmittedAdmin(opts: {
  name: string
  email: string
  barState: string
  barNumber: string
  enrolmentYear: string | number
  signedUrls: Record<string, string>
  lawyerId: string
}) {
  const docRows = Object.entries(opts.signedUrls)
    .map(([key, url]) => {
      const labels: Record<string, string> = {
        enrolment_cert: 'Enrolment Certificate',
        bar_id_front:   'Bar ID Card — Front',
        bar_id_back:    'Bar ID Card — Back',
        govt_id:        'Government ID',
        profile_photo:  'Profile Photo',
      }
      return `
        <tr style="border-bottom:1px solid #EEE">
          <td style="padding:10px 0;color:#666;width:200px;font-size:14px">${labels[key] ?? key}</td>
          <td style="padding:10px 0;font-size:14px">
            <a href="${url}" style="color:#C9A227;text-decoration:none;font-weight:600" target="_blank">
              View Document
            </a>
            <span style="color:#aaa;font-size:11px;margin-left:8px">(expires 24h)</span>
          </td>
        </tr>`
    }).join('')

  try {
    await resend.emails.send({
      from: FROM,
      to: ADMIN,
      subject: `Lawyer Verification Required: ${opts.name} — ${opts.barState}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
          <h2 style="margin:0 0 6px;color:#111;font-size:20px">New Lawyer Application — Action Required</h2>
          <p style="color:#888;font-size:13px;margin:0 0 24px">
            Lawyer ID: <code style="background:#f4f4f4;padding:2px 6px;border-radius:4px">${opts.lawyerId}</code>
          </p>

          <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px">
            <tr style="border-bottom:1px solid #EEE">
              <td style="padding:10px 0;color:#666;width:200px">Full Name</td>
              <td style="padding:10px 0;font-weight:600;color:#111">${opts.name}</td>
            </tr>
            <tr style="border-bottom:1px solid #EEE">
              <td style="padding:10px 0;color:#666">Email</td>
              <td style="padding:10px 0;color:#111">
                <a href="mailto:${opts.email}" style="color:#C9A227">${opts.email}</a>
              </td>
            </tr>
            <tr style="border-bottom:1px solid #EEE">
              <td style="padding:10px 0;color:#666">Bar Council</td>
              <td style="padding:10px 0;font-weight:600;color:#111">${opts.barState}</td>
            </tr>
            <tr style="border-bottom:1px solid #EEE">
              <td style="padding:10px 0;color:#666">Enrolment Number</td>
              <td style="padding:10px 0;font-weight:600;color:#111">${opts.barNumber}</td>
            </tr>
            <tr>
              <td style="padding:10px 0;color:#666">Year of Enrolment</td>
              <td style="padding:10px 0;color:#111">${opts.enrolmentYear}</td>
            </tr>
          </table>

          <h3 style="font-size:15px;color:#111;margin:0 0 12px">Submitted Documents</h3>
          <table style="width:100%;border-collapse:collapse">
            ${docRows || '<tr><td style="color:#888;font-size:14px;padding:10px 0">No documents attached</td></tr>'}
          </table>

          <div style="margin-top:28px;padding:16px 20px;background:#fafafa;border-radius:8px;border-left:4px solid #C9A227">
            <p style="margin:0;color:#333;font-size:13px;line-height:1.6">
              Verify the enrolment number against the official
              <a href="https://www.barcouncilofindia.org" style="color:#C9A227" target="_blank">
                Bar Council of India portal
              </a>, then approve or reject from the admin panel.
            </p>
          </div>

          <div style="margin-top:20px;display:flex;gap:12px">
            <a href="https://legalxonline.com/admin"
               style="display:inline-block;background:#111;color:#fff;font-weight:700;padding:11px 24px;border-radius:8px;text-decoration:none;font-size:13px">
              Go to Admin Panel
            </a>
          </div>

          <p style="color:#aaa;font-size:11px;margin-top:24px">
            Sent at ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
          </p>
        </div>
      `,
    })
  } catch (err) {
    console.error('[email] sendLawyerDocsSubmittedAdmin failed:', err)
  }
}

// ── Lawyer: confirmation that documents are received ─────────────────────────
export async function sendLawyerDocsReceivedConfirmation(email: string, firstName: string) {
  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: 'Documents Received — Under Review | LegalXOnline',
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="margin:0 0 8px;color:#111;font-size:22px">Documents Received, ${firstName}</h2>
          <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 20px">
            We have received your profile and credential documents. Our team will verify your
            Bar Council registration and get back to you within 2–3 business days.
          </p>
          <div style="background:#F0FDF4;border-left:4px solid #22C55E;padding:16px 20px;border-radius:4px;margin-bottom:24px">
            <p style="margin:0;color:#166534;font-size:14px">
              You will receive an email as soon as your profile is approved or if we need additional information.
            </p>
          </div>
          <p style="color:#555;font-size:14px;line-height:1.6">
            In the meantime, you can log in to check your verification status at any time.
          </p>
          <a href="https://legalxonline.com/lawyer-dashboard"
             style="display:inline-block;background:#C9A227;color:#fff;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px;margin-top:16px">
            View My Dashboard
          </a>
          <p style="color:#aaa;font-size:12px;margin-top:32px">
            Questions? Contact us at
            <a href="mailto:contact@legalxonline.com" style="color:#C9A227">contact@legalxonline.com</a>
          </p>
        </div>
      `,
    })
  } catch (err) {
    console.error('[email] sendLawyerDocsReceivedConfirmation failed:', err)
  }
}

// ── Lawyer: approved ──────────────────────────────────────────────────────────
export async function sendLawyerApproved(email: string, firstName: string) {
  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: 'Profile Approved — You Are Now Live on LegalXOnline',
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="margin:0 0 8px;color:#111;font-size:22px">Profile Approved, ${firstName}</h2>
          <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 20px">
            Your LegalX lawyer profile has been verified and is now live. Clients can find and book
            consultations with you from the LegalX platform.
          </p>
          <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 24px">
            Log in to your dashboard to set your availability and start accepting consultations.
          </p>
          <a href="https://legalxonline.com/lawyer-dashboard"
             style="display:inline-block;background:#C9A227;color:#fff;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px">
            Go to My Dashboard
          </a>
        </div>
      `,
    })
  } catch (err) {
    console.error('[email] sendLawyerApproved failed:', err)
  }
}

// ── Lawyer: rejected ──────────────────────────────────────────────────────────
export async function sendLawyerRejected(email: string, firstName: string, reason: string) {
  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: 'Update on Your LegalX Lawyer Application',
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="margin:0 0 8px;color:#111;font-size:22px">Application Update, ${firstName}</h2>
          <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 20px">
            After reviewing your submitted documents, we were unable to verify your credentials at this time.
          </p>
          <div style="background:#FFF5F5;border-left:4px solid #EF4444;padding:16px 20px;border-radius:4px;margin-bottom:24px">
            <p style="margin:0 0 6px;color:#7F1D1D;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">
              Reason
            </p>
            <p style="margin:0;color:#991B1B;font-size:14px;line-height:1.6">${reason}</p>
          </div>
          <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 20px">
            You may resubmit your application with corrected documents. Log in to update your profile.
          </p>
          <a href="https://legalxonline.com/onboarding/lawyer"
             style="display:inline-block;background:#111;color:#fff;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px">
            Resubmit Application
          </a>
          <p style="color:#aaa;font-size:12px;margin-top:32px">
            If you believe this is an error, contact us at
            <a href="mailto:contact@legalxonline.com" style="color:#C9A227">contact@legalxonline.com</a>
          </p>
        </div>
      `,
    })
  } catch (err) {
    console.error('[email] sendLawyerRejected failed:', err)
  }
}
