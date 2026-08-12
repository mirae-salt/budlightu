/**
 * How often each admin hears about support questions.
 *
 * PER ADMIN. It started as one shared setting, which meant Mirae choosing "once a day"
 * silently changed Robin's and Nathan's too: one person turning off another person's
 * alerts about a student waiting for an answer. Caught 2026-08-12 while it was live.
 *
 * The other load-bearing case is the failure direction. This fails LOUD where maintenance
 * mode fails quiet: an unreadable setting still sends, because an extra email is cheap and
 * a student's question sitting unanswered is not.
 */
import { describe, it, expect } from 'vitest'
import {
  parseQuestionNotify,
  validateQuestionNotify,
  modeFor,
  hasOwnSetting,
  withModeFor,
  recipientsForArrival,
  recipientsForDigest,
  QUESTION_NOTIFY_DEFAULT,
  QUESTION_NOTIFY_OPTIONS
} from '../lib/question-notify'

const ADMINS = ['robin.graham@ilovesalt.com', 'nb@ilovesalt.com', 'mirae.lee@ilovesalt.com']

describe('one admin changing their setting leaves the others alone', () => {
  it('withModeFor touches only that email', () => {
    // The actual bug: a global value meant one radio button changed everyone.
    const before = { default: 'each' as const, byEmail: { 'robin.graham@ilovesalt.com': 'daily' as const } }
    const after = withModeFor(before, 'mirae.lee@ilovesalt.com', 'off')

    expect(modeFor(after, 'mirae.lee@ilovesalt.com')).toBe('off')
    expect(modeFor(after, 'robin.graham@ilovesalt.com')).toBe('daily')
    expect(modeFor(after, 'nb@ilovesalt.com')).toBe('each')
  })

  it('does not mutate the object it was given', () => {
    const before = { default: 'each' as const, byEmail: { 'a@x.com': 'daily' as const } }
    withModeFor(before, 'b@x.com', 'off')
    expect(before.byEmail).toEqual({ 'a@x.com': 'daily' })
  })

  it('is case-insensitive about the email, so one person cannot get two entries', () => {
    const s = withModeFor(QUESTION_NOTIFY_DEFAULT, 'Robin.Graham@ILoveSalt.com', 'off')
    expect(modeFor(s, 'robin.graham@ilovesalt.com')).toBe('off')
    expect(Object.keys(s.byEmail)).toHaveLength(1)
  })
})

describe('modeFor', () => {
  it('falls back to the default when the admin has no entry', () => {
    expect(modeFor({ default: 'daily', byEmail: {} }, 'anyone@x.com')).toBe('daily')
  })

  it('treats unreadable settings as each', () => {
    expect(modeFor(null, 'anyone@x.com')).toBe('each')
  })

  it('hasOwnSetting distinguishes a choice from an inherited default', () => {
    const s = { default: 'each' as const, byEmail: { 'a@x.com': 'each' as const } }
    expect(hasOwnSetting(s, 'a@x.com')).toBe(true)
    expect(hasOwnSetting(s, 'b@x.com')).toBe(false)
  })
})

describe('recipients', () => {
  const settings = {
    default: 'each' as const,
    byEmail: {
      'robin.graham@ilovesalt.com': 'daily' as const,
      'nb@ilovesalt.com': 'off' as const
    }
  }

  it('arrival mail goes only to those on each', () => {
    expect(recipientsForArrival(settings, ADMINS)).toEqual(['mirae.lee@ilovesalt.com'])
  })

  it('the digest goes only to those on daily', () => {
    expect(recipientsForDigest(settings, ADMINS)).toEqual(['robin.graham@ilovesalt.com'])
  })

  it('nobody is on both lists, so a question is never double-sent or dropped', () => {
    for (const mode of ['each', 'daily', 'off'] as const) {
      const s = { default: mode, byEmail: {} }
      const a = recipientsForArrival(s, ADMINS)
      const d = recipientsForDigest(s, ADMINS)
      expect(a.filter(x => d.includes(x))).toEqual([])
    }
  })

  it('unreadable settings mail EVERY admin rather than nobody', () => {
    // Fail loud. The opposite of maintenance mode, on purpose.
    expect(recipientsForArrival(null, ADMINS)).toEqual(ADMINS)
    expect(recipientsForDigest(null, ADMINS)).toEqual([])
  })
})

describe('parseQuestionNotify', () => {
  it('reads the per-admin shape and lowercases the keys', () => {
    const s = parseQuestionNotify({ default: 'off', byEmail: { 'A@x.com': 'daily' } })
    expect(s.default).toBe('off')
    expect(s.byEmail).toEqual({ 'a@x.com': 'daily' })
  })

  it('reads the OLD single-mode shape as the default', () => {
    // The row written before this was per-admin. Reading it as 'each' instead would have
    // silently turned everyone's emails back on.
    const s = parseQuestionNotify({ mode: 'daily' })
    expect(s.default).toBe('daily')
    expect(s.byEmail).toEqual({})
  })

  it('drops a junk entry instead of failing the whole row', () => {
    const s = parseQuestionNotify({ default: 'each', byEmail: { 'a@x.com': 'hourly', 'b@x.com': 'off' } })
    expect(s.byEmail).toEqual({ 'b@x.com': 'off' })
  })

  it('falls back to each, never off, on anything unrecognised', () => {
    for (const junk of [null, undefined, 'each', [{ mode: 'off' }], { default: 'weekly' }]) {
      expect(parseQuestionNotify(junk).default).toBe('each')
    }
  })
})

describe('validateQuestionNotify', () => {
  it('accepts the three modes', () => {
    for (const mode of ['each', 'daily', 'off'] as const) {
      const r = validateQuestionNotify({ mode })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.mode).toBe(mode)
    }
  })

  it('refuses anything else rather than defaulting', () => {
    for (const junk of [{}, { mode: 'weekly' }, { mode: null }, null, 'off']) {
      expect(validateQuestionNotify(junk).ok).toBe(false)
    }
  })
})

describe('the options offered match the modes handled', () => {
  it('every option validates, and each says what it costs', () => {
    expect(QUESTION_NOTIFY_OPTIONS.map(o => o.mode).sort()).toEqual(['daily', 'each', 'off'])
    for (const o of QUESTION_NOTIFY_OPTIONS) {
      expect(validateQuestionNotify({ mode: o.mode }).ok).toBe(true)
      // "No emails" without "nothing will prompt you to look" is a setting someone turns
      // on and then forgets.
      expect(o.detail.length).toBeGreaterThan(0)
    }
  })
})
