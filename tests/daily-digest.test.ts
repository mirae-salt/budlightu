/**
 * The once-a-day "what is waiting on you" email.
 *
 * It exists because two things were being dropped. /admin/questions offered "once a day"
 * with no job behind it, so choosing it meant no email ever arrived. And a banking
 * change request fired one notification at submit time and then never mentioned itself
 * again, so a missed moment meant it sat while invoices kept paying the old account.
 */
import { describe, it, expect } from 'vitest'
import {
  hasAnythingToSend,
  digestSubject,
  digestHtml,
  digestText,
  waitedFor,
  type DigestInput
} from '../lib/daily-digest'

const now = new Date('2026-09-20T13:00:00Z')
const APP = 'https://budlightu.com'

const q = (over: Partial<DigestInput['questions'][0]> = {}) => ({
  id: 'q1',
  question: 'When does the reimbursement land?',
  submitted_at: '2026-09-19T10:00:00Z',
  bamName: 'Sam Lee',
  bamEmail: 'sam@school.ca',
  ...over
})

const bank = (over: Partial<DigestInput['pendingBanking'][0]> = {}) => ({
  id: 'b1',
  bamName: 'Jo Park',
  requested_at: '2026-09-17T10:00:00Z',
  reason: 'Switched banks',
  ...over
})

const input = (over: Partial<DigestInput> = {}): DigestInput => ({
  questions: [],
  pendingBanking: [],
  appUrl: APP,
  ...over
})

describe('hasAnythingToSend', () => {
  it('is false when nothing is waiting', () => {
    // An empty daily email trains people to stop opening it, which costs more than it
    // saves.
    expect(hasAnythingToSend(input())).toBe(false)
  })

  it('is true for questions alone', () => {
    expect(hasAnythingToSend(input({ questions: [q()] }))).toBe(true)
  })

  it('is true for a pending banking change alone', () => {
    expect(hasAnythingToSend(input({ pendingBanking: [bank()] }))).toBe(true)
  })
})

describe('digestSubject', () => {
  it('puts the counts in the subject so it can be triaged unopened', () => {
    expect(digestSubject(input({ questions: [q()] })))
      .toBe('Bud Light U: 1 question waiting')
    expect(digestSubject(input({ questions: [q(), q({ id: 'q2' })] })))
      .toBe('Bud Light U: 2 questions waiting')
    expect(digestSubject(input({ pendingBanking: [bank()] })))
      .toBe('Bud Light U: 1 banking change to approve waiting')
  })

  it('mentions both when both are waiting', () => {
    const s = digestSubject(input({ questions: [q()], pendingBanking: [bank()] }))
    expect(s).toContain('1 question')
    expect(s).toContain('1 banking change')
  })
})

describe('waitedFor', () => {
  it('reads as an operator would say it', () => {
    expect(waitedFor('2026-09-20T09:00:00Z', now)).toBe('today')
    expect(waitedFor('2026-09-19T10:00:00Z', now)).toBe('1 day')
    expect(waitedFor('2026-09-17T10:00:00Z', now)).toBe('3 days')
  })

  it('does not go negative or throw on junk', () => {
    expect(waitedFor('2026-09-25T00:00:00Z', now)).toBe('today')
    expect(waitedFor('not a date', now)).toBe('today')
  })
})

describe('digest content', () => {
  it('says what an unapproved banking change actually costs', () => {
    // The reason a reminder matters: the money keeps going somewhere until she acts.
    const html = digestHtml(input({ pendingBanking: [bank()] }), now)
    expect(html).toContain('account already on file')
    expect(html).toContain('Jo Park')
    expect(html).toContain('3 days')
    expect(html).toContain(`${APP}/admin/banking-requests`)
  })

  it('links to the pages rather than only naming them', () => {
    const html = digestHtml(input({ questions: [q()] }), now)
    expect(html).toContain(`${APP}/admin/questions`)
  })

  it('says how to change the frequency, in the email itself', () => {
    // Otherwise turning it down means asking someone.
    const html = digestHtml(input({ questions: [q()] }), now)
    expect(html).toMatch(/change how often/i)
    expect(digestText(input({ questions: [q()] }), now)).toMatch(/change how often/i)
  })

  it('escapes what a student typed', () => {
    const nasty = '<script>alert(1)</script> & "quotes"'
    const html = digestHtml(input({ questions: [q({ question: nasty })] }), now)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
  })

  it('omits a section entirely when it is empty', () => {
    const onlyQuestions = digestHtml(input({ questions: [q()] }), now)
    expect(onlyQuestions).not.toMatch(/banking change/i)

    const onlyBanking = digestHtml(input({ pendingBanking: [bank()] }), now)
    expect(onlyBanking).not.toMatch(/support question/i)
  })

  it('the text version carries the same facts as the html', () => {
    const i = input({ questions: [q()], pendingBanking: [bank()] })
    const text = digestText(i, now)
    expect(text).toContain('Jo Park')
    expect(text).toContain('Sam Lee')
    expect(text).toContain(`${APP}/admin/banking-requests`)
    expect(text).toContain(`${APP}/admin/questions`)
  })
})
