import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY!)
const ADMIN = process.env.ADMIN_EMAIL || 'legalxonline@gmail.com'
const FROM = 'LegalX <noreply@legalxonline.com>'

// ── Alert admin about a new lead ─────────────────────────────────────────────
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
      subject: `🔔 New Lead: ${lead.name} — ${lead.serviceTitle}`,
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

// ── Confirm to user that we received their request ───────────────────────────
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
              <a href="mailto:legalxonline@gmail.com" style="color:#f5a623">legalxonline@gmail.com</a>
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

// ── Payment success email ─────────────────────────────────────────────────────
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
    subject: `💰 Payment Received: ${opts.name} — ${opts.serviceTitle} (₹${amountRs})`,
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
