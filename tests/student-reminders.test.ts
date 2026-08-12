/**
 * Reminders to students, before the deadline, while they can still act.
 *
 * The two properties worth locking down are the failure direction and who gets left out.
 * This fails CLOSED: a malformed or unreadable switch sends nothing. That is the opposite of
 * how question notifications fail, and the reason is the audience. An extra email to three
 * colleagues costs nothing; an unwanted email to 58 students cannot be walked back.
 *
 * The wording is tested too. It goes to students who are owed money, not students who are in
 * trouble, and the difference lives entirely in the sentences.
 */
import { describe, it, expect } from 'vitest'
import {
  parseReminderSettings,
  validateReminderSettings,
  planReminder,
  reminderEmail,
  REMINDER_DEFAULT,
  DEFAULT_REMINDER_DAYS,
  type ReminderCandidate,
  type ReminderSettings
} from '../lib/student-reminders'

const LIVE: ReminderSettings = { mode: 'live', days: [10, 14] }

function bam(over: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    bamId: 'b1',
    firstName: 'Alex',
    email: 'alex@school.edu',
    receiptCount: 0,
    cap: 150,
    isTest: false,
    status: 'active',
    wantsReminders: true,
    ...over
  }
}

describe('the switch fails closed', () => {
  it('defaults to off, so a deploy alone never starts emailing students', () => {
    expect(REMINDER_DEFAULT.mode).toBe('off')
  })

  it('reads anything unrecognised as off, never as live', () => {
    for (const junk of [null, undefined, 'live', ['live'], {}, { mode: 'LIVE' }, { mode: 'on' }, 42]) {
      expect(parseReminderSettings(junk).mode).toBe('off')
    }
  })

  it('off means nothing is sent even on a reminder day to someone well short', () => {
    const plan = planReminder({
      candidate: bam(),
      settings: { mode: 'off', days: [10] },
      day: 10,
      alreadySent: false
    })
    expect(plan.send).toBe(false)
  })
})

describe('which days', () => {
  it('defaults to the 10th and the 14th', () => {
    expect(DEFAULT_REMINDER_DAYS).toEqual([10, 14])
  })

  it('sends only on a configured day', () => {
    for (const day of [1, 9, 11, 13, 15, 16, 20]) {
      expect(planReminder({ candidate: bam(), settings: LIVE, day, alreadySent: false }).send).toBe(false)
    }
    for (const day of [10, 14]) {
      expect(planReminder({ candidate: bam(), settings: LIVE, day, alreadySent: false }).send).toBe(true)
    }
  })

  it('refuses a day after the 15th, because that is a notice about a closed month', () => {
    const r = validateReminderSettings({ mode: 'live', days: [10, 20] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('20')
  })

  it('refuses an empty list rather than silently sending on no days', () => {
    // Silently accepting [] would leave the switch reading "live" while nothing ever sends.
    const r = validateReminderSettings({ mode: 'live', days: [] })
    expect(r.ok).toBe(false)
  })

  it('drops out-of-range days when reading a stored row, keeping the valid ones', () => {
    expect(parseReminderSettings({ mode: 'live', days: [10, 31, 0, 14] }).days).toEqual([10, 14])
  })

  it('falls back to the default when a stored list has nothing usable left', () => {
    expect(parseReminderSettings({ mode: 'live', days: [40, 50] }).days).toEqual(DEFAULT_REMINDER_DAYS)
  })
})

describe('who gets one: people who have submitted nothing', () => {
  it('sends to somebody at zero receipts', () => {
    expect(planReminder({ candidate: bam({ receiptCount: 0 }), settings: LIVE, day: 10, alreadySent: false }).send).toBe(true)
  })

  it('does NOT send to somebody who uploaded one receipt, whatever it was worth', () => {
    // Mirae's rule, 2026-08-12: the trigger is zero submissions, not spend below $150. Someone
    // who uploaded $12 has understood the process and decided; emailing them second-guesses how
    // much beer they should buy.
    const plan = planReminder({ candidate: bam({ receiptCount: 1 }), settings: LIVE, day: 10, alreadySent: false })
    expect(plan.send).toBe(false)
    if (!plan.send) expect(plan.reason).toMatch(/already submitted/)
  })

  it('does not send to somebody with several receipts', () => {
    expect(planReminder({ candidate: bam({ receiptCount: 4 }), settings: LIVE, day: 10, alreadySent: false }).send).toBe(false)
  })
})

describe('who does not get one', () => {
  it('nobody already reminded this period', () => {
    expect(planReminder({ candidate: bam(), settings: LIVE, day: 10, alreadySent: true }).send).toBe(false)
  })

  it('nobody whose roster row is not active', () => {
    for (const status of ['archived', 'pending', 'invited']) {
      expect(planReminder({ candidate: bam({ status }), settings: LIVE, day: 10, alreadySent: false }).send).toBe(false)
    }
  })

  it('nobody without an email address, rather than sending to "null"', () => {
    const plan = planReminder({ candidate: bam({ email: null }), settings: LIVE, day: 10, alreadySent: false })
    expect(plan.send).toBe(false)
    if (!plan.send) expect(plan.reason).toMatch(/no email/)
  })

  it('nobody who turned reminders off for themselves', () => {
    // Students control this on their account page. A courtesy nobody can decline is just mail.
    const plan = planReminder({ candidate: bam({ wantsReminders: false }), settings: LIVE, day: 10, alreadySent: false })
    expect(plan.send).toBe(false)
    if (!plan.send) expect(plan.reason).toMatch(/turned reminders off/)
  })

  it('does include TEST accounts, so Robin can receive one herself', () => {
    expect(planReminder({ candidate: bam({ isTest: true }), settings: LIVE, day: 10, alreadySent: false }).send).toBe(true)
  })
})

describe('what it tells them', () => {
  it('counts days to the 15th, not to the end of the month', () => {
    const p10 = planReminder({ candidate: bam(), settings: LIVE, day: 10, alreadySent: false })
    const p14 = planReminder({ candidate: bam(), settings: LIVE, day: 14, alreadySent: false })
    if (!p10.send || !p14.send) throw new Error('expected sends')
    expect(p10.daysLeft).toBe(5)
    expect(p14.daysLeft).toBe(1)
  })

  it('carries the cap through, which is what the email quotes', () => {
    const p = planReminder({ candidate: bam({ cap: 218.75 }), settings: LIVE, day: 10, alreadySent: false })
    if (!p.send) throw new Error('expected a send')
    expect(p.cap).toBe(218.75)
  })
})

describe('the email itself', () => {
  const mail = reminderEmail({
    firstName: 'Alex',
    cap: 150,
    daysLeft: 5,
    monthLabel: 'September 2026',
    portalUrl: 'https://budlightu.com'
  })

  it('says the cap and the month in both html and text', () => {
    for (const body of [mail.html, mail.text]) {
      expect(body).toContain('150.00')
      expect(body).toContain('September 2026')
    }
  })

  it('says we have received nothing, since that is the only reason it was sent', () => {
    expect(mail.text).toMatch(/have not received any/i)
  })

  it('never quotes a spend figure, because everyone who gets this is at zero', () => {
    // Quoting "$0.00 so far" reads as an accusation and invites the reply "yes, I know".
    expect(mail.text).not.toMatch(/\$0\.00|so far/i)
  })

  it('tells them how to turn it off', () => {
    expect(mail.text).toContain('/portal/account')
    expect(mail.html).toContain('/portal/account')
  })

  it('links to upload and to support', () => {
    expect(mail.html).toContain('https://budlightu.com/portal/upload')
    expect(mail.html).toContain('https://budlightu.com/portal/support')
  })

  it('says the money does not carry over, because that is why the date matters', () => {
    expect(mail.text).toMatch(/does not carry/i)
  })

  it('tells them it is fine to have nothing to submit', () => {
    // Without this line a reminder to somebody who genuinely has no receipts reads as a
    // demand, and the honest reply is on the Support page.
    expect(mail.text).toMatch(/that is fine/i)
  })

  it('does not scold, beg or exclaim', () => {
    for (const body of [mail.html, mail.text]) {
      expect(body).not.toContain('!')
      expect(body).not.toMatch(/don't forget|do not forget|last chance|hurry|urgent|failure to/i)
    }
  })

  it('uses no em dashes', () => {
    for (const body of [mail.html, mail.text]) expect(body).not.toContain('—')
  })

  it('escapes the name, which comes from the roster', () => {
    const evil = reminderEmail({
      firstName: '<script>alert(1)</script>',
      cap: 150, daysLeft: 5,
      monthLabel: 'September 2026', portalUrl: 'https://budlightu.com'
    })
    expect(evil.html).not.toContain('<script>')
    expect(evil.html).toContain('&lt;script&gt;')
  })

  it('changes the wording on the last day rather than saying "1 days"', () => {
    const last = reminderEmail({
      firstName: 'Alex', cap: 150, daysLeft: 0,
      monthLabel: 'September 2026', portalUrl: 'https://budlightu.com'
    })
    expect(last.subject).toMatch(/last day/i)
    expect(last.text).not.toMatch(/0 days|1 days/)

    const tomorrow = reminderEmail({
      firstName: 'Alex', cap: 150, daysLeft: 1,
      monthLabel: 'September 2026', portalUrl: 'https://budlightu.com'
    })
    expect(tomorrow.text).not.toMatch(/1 days/)
  })
})

describe('validateReminderSettings', () => {
  it('accepts the three modes', () => {
    for (const mode of ['off', 'draft', 'live'] as const) {
      expect(validateReminderSettings({ mode, days: [10] }).ok).toBe(true)
    }
  })

  it('refuses anything else rather than defaulting to one', () => {
    for (const junk of [{}, { mode: 'on' }, { mode: null }, null, 'live']) {
      expect(validateReminderSettings(junk).ok).toBe(false)
    }
  })
})
