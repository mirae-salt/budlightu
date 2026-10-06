/**
 * Plain wording for the audit log screen.
 *
 * The log stores the table name and the action code as the code wrote them
 * (`invoice_sends | update`, `receipts | override_total`). A program manager reading it saw
 * those words. The stored values are the record and stay exactly as they are; this only
 * decides what the screen says, and the screen keeps the raw value in a tooltip and in the
 * CSV so an entry can still be traced back to the code.
 *
 * An entry this does not know is humanised (`question_answered` becomes "Question answered")
 * rather than hidden, so a new action shows up readable before anyone edits this file.
 */

const ENTITY: Record<string, string> = {
  bams: 'Student',
  invoices: 'Invoice',
  invoice_sends: 'Invoice email',
  reimbursement_ledger: 'Reimbursement',
  receipts: 'Receipt',
  policy: 'Setting',
  portal_questions: 'Question',
  banking_change_requests: 'Banking change',
  admin_team: 'Admin team',
  ap_cancellations: 'AP cancellation',
  onboarding_ratelimit_ip: 'Sign-up attempts'
}

const ACTION: Record<string, string> = {
  'bams.update': 'Student record changed',
  'bams.email_verified': 'Email verified',
  'bams.invite_sent': 'Invite sent',
  'bams.roster_add': 'Added to the roster',
  'bams.roster_edit': 'Roster details edited',
  'bams.bulk_invite': 'Bulk invite sent',
  'bams.attestations_recorded': 'Confirmations recorded by the student',
  'bams.activated_without_confirmations': 'Set active before the student gave their confirmations',
  'bams.create_missing_invoice': 'Missing invoice created',
  'bams.roster_seed_invoice': 'Invoice created from the roster',
  'invoices.update': 'Invoice changed',
  'invoices.insert': 'Invoice created',
  'invoices.delete': 'Invoice deleted',
  'invoices.batch_approve': 'Invoices approved and sent to AP',
  'invoices.invoice_lines_edit': 'Invoice lines or date edited',
  'invoices.roster_sync': 'Invoice refreshed from the roster',
  'reimbursement_ledger.update': 'Reimbursement recalculated',
  'reimbursement_ledger.insert': 'Reimbursement recorded',
  'reimbursement_ledger.delete': 'Reimbursement removed',
  'invoice_sends.insert': 'Invoice email queued',
  'invoice_sends.update': 'Invoice email status updated',
  'invoice_sends.delete': 'Invoice email record removed',
  'receipts.override_total': 'Amount set by an admin',
  'receipts.revert_decision': 'Decision reopened',
  'receipts.correct_bud_light_lines': 'Bud Light lines corrected',
  'receipts.review_reason_refreshed': 'Review reason reworded',
  'receipts.recleared_deposit_flag_fix': 'Deposit flag cleared (automatic fix)',
  'receipts.amount_recomputed_deposit_fix': 'Amount recalculated for the deposit (automatic fix)',
  'receipts.reclassified_as_auto': 'Counted as automatic',
  'policy.update': 'Setting changed',
  'policy.insert': 'Setting added',
  'policy.delete': 'Setting removed',
  'policy.question_notify_changed': 'Question email alerts changed',
  'policy.student_reminders_changed': 'Student reminders changed',
  'policy.ap_addresses_changed': 'AP email addresses changed',
  'policy.maintenance_on': 'Maintenance notice turned on',
  'policy.maintenance_off': 'Maintenance notice turned off',
  'portal_questions.question_answered': 'Question answered',
  'portal_questions.question_reopened': 'Question reopened',
  'banking_change_requests.submitted': 'Banking change requested by the student',
  'banking_change_requests.submitted_by_admin': 'Banking change entered by an admin',
  'banking_change_requests.applied': 'Banking change applied',
  'banking_change_requests.rejected': 'Banking change rejected',
  'banking_change_requests.approve_confirm_mismatch': 'Banking change not applied: the numbers did not match',
  'admin_team.add_admin': 'Admin added',
  'admin_team.remove_admin': 'Admin removed',
  'ap_cancellations.insert': 'AP cancellation recorded',
  'ap_cancellations.delete': 'AP cancellation removed',
  'onboarding_ratelimit_ip.attempt': 'Sign-up attempt counted'
}

const ROLE: Record<string, string> = {
  super_admin: 'Super admin',
  program_admin: 'Program admin',
  system: 'System',
  bam: 'Student'
}

/** `question_answered` -> "Question answered". Last resort for a code nobody has labelled. */
export function humanizeCode(code: string): string {
  const words = String(code).replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function entityLabel(entity: string): string {
  return ENTITY[entity] ?? humanizeCode(entity)
}

export function actionLabel(entity: string, action: string): string {
  return ACTION[`${entity}.${action}`] ?? humanizeCode(action)
}

export function roleLabel(role: string): string {
  return ROLE[role] ?? humanizeCode(role)
}
