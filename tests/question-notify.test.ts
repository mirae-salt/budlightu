/**
 * How often Robin hears about support questions is HER setting.
 *
 * The support route emailed on every question, which is right at three a month and wrong
 * during onboarding week with 58 BAMs. The number nobody can predict is exactly the one
 * the recipient should control without asking for a code change.
 *
 * The load-bearing case here is the failure direction. This fails LOUD where maintenance
 * mode fails quiet: an unreadable setting still sends the email, because an extra email
 * is cheap and a student's question sitting unanswered is not.
 */
import { describe, it, expect } from 'vitest'
import {
  parseQuestionNotify,
  validateQuestionNotify,
  shouldEmailOnArrival,
  shouldSendDigest,
  QUESTION_NOTIFY_DEFAULT,
  QUESTION_NOTIFY_OPTIONS
} from '../lib/question-notify'

describe('shouldEmailOnArrival', () => {
  it('sends when the setting cannot be read', () => {
    // The opposite of how maintenance mode fails, on purpose.
    expect(shouldEmailOnArrival(null)).toBe(true)
  })

  it('sends on every question when set to each', () => {
    expect(shouldEmailOnArrival({ mode: 'each' })).toBe(true)
  })

  it('does NOT send on arrival when set to daily', () => {
    expect(shouldEmailOnArrival({ mode: 'daily' })).toBe(false)
  })

  it('does not send when set to off', () => {
    expect(shouldEmailOnArrival({ mode: 'off' })).toBe(false)
  })
})

describe('shouldSendDigest', () => {
  it('only for daily', () => {
    expect(shouldSendDigest({ mode: 'daily' })).toBe(true)
    expect(shouldSendDigest({ mode: 'each' })).toBe(false)
    expect(shouldSendDigest({ mode: 'off' })).toBe(false)
    expect(shouldSendDigest(null)).toBe(false)
  })

  it('daily is the only mode that both defers arrival mail AND digests', () => {
    // If these two ever disagree, a question is either double-sent or silently dropped.
    for (const o of QUESTION_NOTIFY_OPTIONS) {
      const arrival = shouldEmailOnArrival({ mode: o.mode })
      const digest = shouldSendDigest({ mode: o.mode })
      expect(arrival && digest).toBe(false)
    }
  })
})

describe('parseQuestionNotify', () => {
  it('reads the three real modes', () => {
    expect(parseQuestionNotify({ mode: 'each' }).mode).toBe('each')
    expect(parseQuestionNotify({ mode: 'daily' }).mode).toBe('daily')
    expect(parseQuestionNotify({ mode: 'off' }).mode).toBe('off')
  })

  it('falls back to each, not off, on anything unrecognised', () => {
    // A malformed row must not quietly stop questions from reaching anyone.
    for (const junk of [null, undefined, 'each', { mode: 'hourly' }, { mode: true }, [{ mode: 'off' }], {}]) {
      expect(parseQuestionNotify(junk)).toEqual(QUESTION_NOTIFY_DEFAULT)
    }
    expect(QUESTION_NOTIFY_DEFAULT.mode).toBe('each')
  })
})

describe('validateQuestionNotify', () => {
  it('accepts the three modes', () => {
    for (const mode of ['each', 'daily', 'off'] as const) {
      const r = validateQuestionNotify({ mode })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value.mode).toBe(mode)
    }
  })

  it('refuses anything else rather than defaulting', () => {
    // On the write path an unknown value is the admin's mistake, so say so. The read
    // path falls back instead, because a stored bad value must not break the page.
    for (const junk of [{}, { mode: 'weekly' }, { mode: null }, null, 'off']) {
      expect(validateQuestionNotify(junk).ok).toBe(false)
    }
  })
})

describe('the options offered match the modes handled', () => {
  it('every option is a mode the logic knows', () => {
    expect(QUESTION_NOTIFY_OPTIONS.map(o => o.mode).sort()).toEqual(['daily', 'each', 'off'])
    for (const o of QUESTION_NOTIFY_OPTIONS) {
      expect(validateQuestionNotify({ mode: o.mode }).ok).toBe(true)
      expect(o.label.length).toBeGreaterThan(0)
      // Each option says what it costs. "No emails" without "nothing will prompt you to
      // look" is a setting someone turns on and then forgets.
      expect(o.detail.length).toBeGreaterThan(0)
    }
  })
})
