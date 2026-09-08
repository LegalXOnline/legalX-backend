import { Router, Request, Response } from 'express'
import Razorpay from 'razorpay'
import crypto from 'crypto'
import { supabase, supabaseAuthValidator } from '../lib/supabase'
import { logger } from '../lib/logger'
import { validateBody, walletTopupOrderSchema, walletTopupVerifySchema } from '../lib/validation'

/**
 * The client's wallet.
 *
 * Until now a client could only consult on the free ₹100 grant, and once it
 * was gone there was nothing to do but wait — there was no way to put money in.
 *
 * Two balances are reported separately and deliberately: the promotional grant
 * is not money and can never be refunded or withdrawn, while a top-up is. One
 * combined figure would lose that distinction at exactly the moment somebody
 * asks for their money back.
 */

const router = Router()

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
})

/** True while the configured key is a test key. Surfaced so the UI can say so. */
const isTestMode = (process.env.RAZORPAY_KEY_ID ?? '').startsWith('rzp_test')

async function getAuthUser(req: Request) {
  const token = req.cookies?.lx_access_token || req.headers.authorization?.replace('Bearer ', '')
  if (!token) return null
  const { data, error } = await supabaseAuthValidator.auth.getUser(token)
  if (error || !data.user) return null
  return { id: data.user.id }
}

// ── GET /api/wallet ──────────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }

    const [{ data: account }, { data: wallet }] = await Promise.all([
      supabase.from('accounts').select('free_credit_paise').eq('id', user.id).maybeSingle(),
      supabase.from('wallets').select('id, balance').eq('account_id', user.id).maybeSingle(),
    ])

    let transactions: unknown[] = []
    if (wallet?.id) {
      const { data } = await supabase
        .from('wallet_transactions')
        .select('id, type, amount, balance_after, reference_type, note, created_at')
        .eq('wallet_id', wallet.id)
        .order('created_at', { ascending: false })
        .limit(50)
      transactions = data ?? []
    }

    const freeCreditPaise = Number(account?.free_credit_paise ?? 0)
    const walletPaise = Math.round(Number(wallet?.balance ?? 0) * 100)

    res.json({
      freeCreditPaise,
      walletPaise,
      spendablePaise: freeCreditPaise + walletPaise,
      transactions,
      testMode: isTestMode,
    })
  } catch (err) {
    logger.error({ err }, '[wallet] read failed')
    res.status(500).json({ error: 'Could not load your wallet' })
  }
})

// ── POST /api/wallet/topup/order ─────────────────────────────────────────────
/**
 * Opens a Razorpay order for a top-up.
 *
 * Nothing is credited here. The order only lets the browser open checkout; the
 * balance moves in /verify, after a signature this server computes itself. A
 * client that credited on "the browser said it paid" would be a wallet anybody
 * could fill for free.
 */
router.post('/topup/order', validateBody(walletTopupOrderSchema), async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }

    const { amountPaise } = req.body as { amountPaise: number }

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `wallet_${user.id.slice(0, 8)}_${Date.now()}`,
      notes: { accountId: user.id, purpose: 'wallet_topup' },
    })

    res.status(201).json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      testMode: isTestMode,
    })
  } catch (err) {
    logger.error({ err }, '[wallet] could not open a top-up order')
    res.status(502).json({ error: 'Could not reach the payment provider. Please try again.' })
  }
})

// ── POST /api/wallet/topup/verify ────────────────────────────────────────────
/**
 * Credits the wallet once the payment is proven.
 *
 * The signature is HMAC-SHA256 over "order_id|payment_id" with the key secret,
 * compared in constant time — the only thing that distinguishes a real payment
 * from a browser claiming one. The amount is read back from Razorpay rather
 * than taken from the request, because a client that could name its own
 * top-up amount could name any of them.
 */
router.post('/topup/verify', validateBody(walletTopupVerifySchema), async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }

    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body as {
      razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string
    }

    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex')

    const a = Buffer.from(expected)
    const b = Buffer.from(razorpaySignature)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      logger.warn({ razorpayOrderId }, '[wallet] signature mismatch on top-up')
      res.status(400).json({ error: 'That payment could not be verified.' })
      return
    }

    // Straight from the provider: the amount, and who the order was for.
    const payment = await razorpay.payments.fetch(razorpayPaymentId) as unknown as {
      status: string; amount: number; order_id: string
    }

    if (payment.order_id !== razorpayOrderId) {
      res.status(400).json({ error: 'That payment does not match the order.' }); return
    }
    if (payment.status !== 'captured' && payment.status !== 'authorized') {
      res.status(400).json({ error: 'That payment has not completed.' }); return
    }

    const order = await razorpay.orders.fetch(razorpayOrderId) as unknown as {
      notes?: { accountId?: string }
    }
    if (order.notes?.accountId && order.notes.accountId !== user.id) {
      // Someone else's order id, replayed. The wallet it would credit is not
      // the wallet that paid.
      logger.warn({ razorpayOrderId, user: user.id }, '[wallet] order belongs to another account')
      res.status(403).json({ error: 'That payment belongs to another account.' })
      return
    }

    // Razorpay's payment id is unique per payment, so a replayed verify finds
    // the ledger entry already there and credits nothing further.
    const { data: existing } = await supabase
      .from('wallet_transactions')
      .select('id')
      .eq('reference_type', 'topup')
      .eq('reference_id', razorpayPaymentId)
      .maybeSingle()

    if (existing) {
      const { data: wallet } = await supabase
        .from('wallets').select('balance').eq('account_id', user.id).maybeSingle()
      res.json({
        ok: true,
        alreadyCredited: true,
        walletPaise: Math.round(Number(wallet?.balance ?? 0) * 100),
      })
      return
    }

    const { data: balance, error } = await supabase.rpc('credit_wallet', {
      p_account_id: user.id,
      p_amount_paise: Number(payment.amount),
      p_reference: razorpayPaymentId,
      p_note: isTestMode ? 'Top-up (test mode)' : 'Wallet top-up',
    })

    if (error) {
      logger.error({ err: error.message, user: user.id }, '[wallet] credit failed after a verified payment')
      res.status(500).json({
        error: 'Your payment went through but the balance did not update. Contact support with this payment id: ' + razorpayPaymentId,
      })
      return
    }

    res.json({ ok: true, walletPaise: Math.round(Number(balance ?? 0) * 100) })
  } catch (err) {
    logger.error({ err }, '[wallet] verify failed')
    res.status(500).json({ error: 'Could not confirm that payment.' })
  }
})

export default router
