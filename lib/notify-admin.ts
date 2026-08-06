import { serviceClient } from '../supabase/functions/_shared/supabase-admin'

type NotifType = 'receipt_review' | 'ocr_failed' | 'shortfall' | 'invoice_draft' | 'support_question' | 'receipt_uploaded'

interface AdminNotification {
  type: NotifType
  title: string
  body?: string
  bam_id?: string
  cohort_id?: string
  period?: string
  link?: string
}

export async function notifyAdmin(n: AdminNotification) {
  try {
    const db = serviceClient()
    await db.from('admin_notifications').insert({
      type: n.type,
      title: n.title,
      body: n.body ?? null,
      bam_id: n.bam_id ?? null,
      cohort_id: n.cohort_id ?? null,
      period: n.period ?? null,
      link: n.link ?? null,
    })
  } catch (e) {
    console.error('[notifyAdmin] failed:', e)
  }
}
