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
