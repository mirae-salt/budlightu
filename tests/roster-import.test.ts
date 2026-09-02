/**
 * Roster file parsing.
 *
 * Robin, 2026-09-02, importing the 57 real BAMs: *"I think it might have skipped
 * the first bam"*. Avery was gone. Row 1 was taken as the column header whether
 * or not the file had one, so a headerless file lost its first person, imported
 * the rest cleanly, and reported success.
 */
import { describe, it, expect } from 'vitest'
import {
  looksLikeHeaderRow,
  splitHeaderAndRows,
  autoMapColumns,
  mapColumnsByContent,
  toCsvRows,
  hasRequiredColumns,
  parseCsvGrid,
} from '../lib/roster-import'

describe('looksLikeHeaderRow', () => {
  it('treats a row containing an email as data', () => {
    expect(looksLikeHeaderRow(['Avery', 'Chen', 'avery@utoronto.ca'])).toBe(false)
  })

  it('treats a row of known column names as a header', () => {
    expect(looksLikeHeaderRow(['First Name', 'Last Name', 'Email'])).toBe(true)
  })

  it('an email beats a recognisable name, because a header carries no address', () => {
    // "Name" is an alias, but a real address in the same row settles it.
    expect(looksLikeHeaderRow(['Name', 'avery@utoronto.ca'])).toBe(false)
  })

  it('falls back to header when a row is recognisable neither way', () => {
    expect(looksLikeHeaderRow(['BAM Roster 2026-2027', '', ''])).toBe(true)
  })
})

describe('splitHeaderAndRows', () => {
  it('keeps every row when the file has no header', () => {
    const { rows, headerDetected } = splitHeaderAndRows([
      ['Avery', 'Chen', 'avery@utoronto.ca'],
      ['Lucas', 'Grabowski', 'lucas@queensu.ca'],
    ])
    expect(headerDetected).toBe(false)
    expect(rows).toHaveLength(2)
    expect(rows[0][0]).toBe('Avery')
  })

  it('drops the header row when the file has one', () => {
    const { headers, rows, headerDetected } = splitHeaderAndRows([
      ['First Name', 'Last Name', 'Email'],
      ['Avery', 'Chen', 'avery@utoronto.ca'],
    ])
    expect(headerDetected).toBe(true)
    expect(headers).toEqual(['First Name', 'Last Name', 'Email'])
    expect(rows).toHaveLength(1)
  })

  it('pads short rows to the widest row, since Excel drops trailing blanks', () => {
    const { rows } = splitHeaderAndRows([
      ['First', 'Last', 'Email', 'School'],
      ['Avery', 'Chen', 'avery@utoronto.ca'],
    ])
    expect(rows[0]).toEqual(['Avery', 'Chen', 'avery@utoronto.ca', ''])
  })

  it('ignores blank rows', () => {
    const { rows } = splitHeaderAndRows([
      ['First', 'Last', 'Email'],
      ['', '', ''],
      ['Avery', 'Chen', 'avery@utoronto.ca'],
    ])
    expect(rows).toHaveLength(1)
  })

  it('returns nothing for an empty file rather than inventing a row', () => {
    expect(splitHeaderAndRows([['', '  ']]).rows).toHaveLength(0)
    expect(splitHeaderAndRows([]).rows).toHaveLength(0)
  })

  it('a single headerless row is a person, not a header', () => {
    const { rows, headerDetected } = splitHeaderAndRows([['Avery', 'Chen', 'avery@utoronto.ca']])
    expect(headerDetected).toBe(false)
    expect(rows).toHaveLength(1)
  })
})

describe('mapColumnsByContent', () => {
  it('finds the email column from the data', () => {
    const rows = [['Avery', 'Chen', 'avery@utoronto.ca']]
    expect(mapColumnsByContent(rows, 3)).toEqual({ 0: null, 1: null, 2: 'email' })
  })

  it('leaves the name columns unmapped, so a human decides', () => {
    const map = mapColumnsByContent([['Avery', 'Chen', 'avery@utoronto.ca']], 3)
    // Guessing which text column is a first name would be inventing an answer.
    expect(hasRequiredColumns(map)).toBe(false)
  })
})

describe('autoMapColumns', () => {
  it('maps known aliases', () => {
    expect(autoMapColumns(['First Name', 'Last Name', 'Email'])).toEqual({
      0: 'first_name', 1: 'last_name', 2: 'email',
    })
  })

  it('does not map two columns to the same field', () => {
    const map = autoMapColumns(['Name', 'Full Name'])
    expect(map[0]).toBe('full_name')
    expect(map[1]).toBeNull()
  })
})

describe('toCsvRows', () => {
  it('keeps the first person of a headerless file once the columns are mapped', () => {
    const { rows } = splitHeaderAndRows([
      ['Avery', 'Chen', 'avery@utoronto.ca'],
      ['Lucas', 'Grabowski', 'lucas@queensu.ca'],
    ])
    const people = toCsvRows(rows, { 0: 'first_name', 1: 'last_name', 2: 'email' })
    expect(people).toHaveLength(2)
    expect(people[0].first_name).toBe('Avery')
  })

  it('splits a full name into first and last', () => {
    const people = toCsvRows([['Avery Chen', 'avery@utoronto.ca']], { 0: 'full_name', 1: 'email' })
    expect(people[0].first_name).toBe('Avery')
    expect(people[0].last_name).toBe('Chen')
  })

  it('keeps every part of a multi-word surname', () => {
    const people = toCsvRows([['Isla O Sullivan Reid', 'isla@dal.ca']], { 0: 'full_name', 1: 'email' })
    expect(people[0].last_name).toBe('O Sullivan Reid')
  })

  it('drops a row with no email, because it cannot become a BAM', () => {
    const people = toCsvRows([['Avery', 'Chen', '']], { 0: 'first_name', 1: 'last_name', 2: 'email' })
    expect(people).toHaveLength(0)
  })
})

describe('parseCsvGrid', () => {
  it('agrees with the Excel path on a headerless file', () => {
    const grid = parseCsvGrid('Avery,Chen,avery@utoronto.ca\nLucas,Grabowski,lucas@queensu.ca')
    const { rows, headerDetected } = splitHeaderAndRows(grid)
    expect(headerDetected).toBe(false)
    expect(rows).toHaveLength(2)
  })

  it('respects quoted commas', () => {
    const grid = parseCsvGrid('"Chen, Avery",avery@utoronto.ca')
    expect(grid[0]).toEqual(['Chen, Avery', 'avery@utoronto.ca'])
  })
})

describe('hasRequiredColumns', () => {
  it('needs a name and an email', () => {
    expect(hasRequiredColumns({ 0: 'first_name', 1: 'last_name', 2: 'email' })).toBe(true)
    expect(hasRequiredColumns({ 0: 'full_name', 1: 'email' })).toBe(true)
    expect(hasRequiredColumns({ 0: 'first_name', 1: 'email' })).toBe(false)
    expect(hasRequiredColumns({ 0: 'first_name', 1: 'last_name' })).toBe(false)
  })
})
