/**
 * The audit log screen shows sentences, not table names and action codes.
 * The stored values are untouched; every pair that exists in the database on 2026-10-06 is covered here.
 */
import { describe, it, expect } from 'vitest'
import { entityLabel, actionLabel, roleLabel, humanizeCode } from '../lib/audit-wording'

describe('audit wording', () => {
  it('turns the names that leaked onto the screen into words', () => {
    expect(entityLabel('invoice_sends')).toBe('Invoice email')
    expect(entityLabel('reimbursement_ledger')).toBe('Reimbursement')
    expect(entityLabel('portal_questions')).toBe('Question')
    expect(entityLabel('onboarding_ratelimit_ip')).toBe('Sign-up attempts')
    expect(roleLabel('super_admin')).toBe('Super admin')
    expect(roleLabel('program_admin')).toBe('Program admin')
    expect(actionLabel('receipts', 'override_total')).toBe('Amount set by an admin')
    expect(actionLabel('portal_questions', 'question_answered')).toBe('Question answered')
  })

  it('reads the same action differently on different records', () => {
    expect(actionLabel('invoices', 'update')).toBe('Invoice changed')
    expect(actionLabel('bams', 'update')).toBe('Student record changed')
    expect(actionLabel('policy', 'update')).toBe('Setting changed')
  })

  it('never shows an underscore or a bare code for a known pair', () => {
    const known: Array<[string, string]> = [
      ['bams', 'roster_edit'], ['bams', 'invite_sent'], ['invoices', 'batch_approve'], ['invoices', 'invoice_lines_edit'],
      ['invoice_sends', 'insert'], ['receipts', 'revert_decision'], ['policy', 'maintenance_on'],
      ['banking_change_requests', 'approve_confirm_mismatch'], ['admin_team', 'add_admin'], ['ap_cancellations', 'insert']
    ]
    for (const [e, a] of known) expect(actionLabel(e, a)).not.toMatch(/_/)
  })

  it('humanises a code it has never seen instead of hiding it', () => {
    expect(actionLabel('widgets', 'frobnicated_twice')).toBe('Frobnicated twice')
    expect(entityLabel('new_table')).toBe('New table')
    expect(humanizeCode('x')).toBe('X')
  })
})
