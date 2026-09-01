import { supabase } from './supabase'
import { logger } from './logger'

export type NotificationType =
  | 'consultation'
  | 'payment'
  | 'document'
  | 'verification'
  | 'wallet'
  | 'dispute'
  | 'info'

export interface NotificationInput {
  accountId: string
  title: string
  message: string
  type?: NotificationType
  /** In-app path the bell should link to, e.g. `/lawyer-dashboard/consultations`. */
  link?: string | null
}

/**
 * Writes an in-app notification.
 *
 * Deliberately best-effort: notifications are a side-effect of an action that
 * has already committed (a payment captured, a lawyer approved). Throwing here
 * would roll back nothing and would turn a successful operation into an error
 * response, so failures are logged loudly instead.
 */
export async function createNotification(input: NotificationInput): Promise<void> {
  if (!input.accountId) return

  const { error } = await supabase.from('notifications').insert({
    account_id: input.accountId,
    title: input.title,
    message: input.message,
    type: input.type ?? 'info',
    link: input.link ?? null,
  })

  if (error) {
    logger.error({ err: error.message, input }, 'NOTIFICATION WRITE FAILED')
  }
}

/** Fan-out helper for the same message to several accounts. */
export async function createNotifications(inputs: NotificationInput[]): Promise<void> {
  const rows = inputs
    .filter(i => i.accountId)
    .map(i => ({
      account_id: i.accountId,
      title: i.title,
      message: i.message,
      type: i.type ?? 'info',
      link: i.link ?? null,
    }))
  if (!rows.length) return

  const { error } = await supabase.from('notifications').insert(rows)
  if (error) {
    logger.error({ err: error.message, count: rows.length }, 'BULK NOTIFICATION WRITE FAILED')
  }
}
