/**
 * Turning an uploaded roster file into rows we can create BAMs from.
 *
 * Pure functions on purpose. This is the step where a person can silently stop
 * existing, so it has to be runnable outside a browser and outside a login:
 * see scripts/probe/roster-import.js, which exercises every case below.
 */

export type CsvRow = {
  first_name: string
  last_name: string
  email: string
  school?: string
  full_name?: string
}

export type ColumnMap = Record<number, keyof CsvRow | null>

export const COLUMN_ALIASES: Record<string, keyof CsvRow> = {
  'first_name': 'first_name', 'first name': 'first_name', 'firstname': 'first_name', 'first': 'first_name', 'prénom': 'first_name',
  'last_name': 'last_name', 'last name': 'last_name', 'lastname': 'last_name', 'last': 'last_name', 'surname': 'last_name', 'nom': 'last_name',
  'email': 'email', 'email address': 'email', 'e-mail': 'email', 'mail': 'email',
  'full_name': 'full_name', 'full name': 'full_name', 'fullname': 'full_name', 'name': 'full_name',
  'school': 'school', 'school_id': 'school', 'university': 'school', 'campus': 'school',
}

export function splitCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue }
    if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue }
    current += ch
  }
  result.push(current.trim())
  return result
}

export function parseCsvGrid(text: string): string[][] {
  return text.split(/\r?\n/).filter(l => l.trim()).map(splitCsvLine)
}

/**
 * Does row 1 name the columns, or is it a person?
 *
 * Excel and CSV files arrive both ways. Row 1 used to be taken as the header
 * unconditionally, so a headerless file lost its first BAM: that row became the
 * column names, every remaining row imported cleanly, and the import reported
 * success. Nothing looked wrong until somebody counted the roster.
 *
 * An email address is the tell. No column is called "lucas@queensu.ca", and a
 * row carrying no email is dropped by toCsvRows anyway.
 */
export function looksLikeHeaderRow(row: string[]): boolean {
  if (row.some(c => String(c ?? '').includes('@'))) return false
  if (row.some(c => COLUMN_ALIASES[String(c ?? '').toLowerCase().trim()])) return true
  // Recognisable neither way. Keep the old assumption: a mystery first row is
  // more often a title than a person, and the preview states what was decided.
  return true
}

/**
 * Splits a raw grid into headers and body, deciding for itself whether the file
 * brought a header row. Shared by the Excel and CSV paths so the two cannot
 * drift apart again.
 */
export function splitHeaderAndRows(grid: string[][]): {
  headers: string[]
  rows: string[][]
  headerDetected: boolean
} {
  const nonEmpty = grid.filter(r => r.some(c => c != null && String(c).trim()))
  if (nonEmpty.length === 0) return { headers: [], rows: [], headerDetected: false }

  const headerDetected = looksLikeHeaderRow(nonEmpty[0])
  const width = Math.max(...nonEmpty.map(r => r.length))
  const headers = headerDetected
    ? Array.from({ length: width }, (_, i) => String(nonEmpty[0][i] ?? ''))
    : Array.from({ length: width }, (_, i) => `Column ${i + 1}`)
  const body = headerDetected ? nonEmpty.slice(1) : nonEmpty
  const rows = body.map(r => Array.from({ length: width }, (_, i) => String(r[i] ?? '').trim()))
  return { headers, rows, headerDetected }
}

/** Maps a file's own column names onto our fields. First alias wins, so a file
 *  carrying both "name" and "full name" does not map two columns to one field. */
export function autoMapColumns(headers: string[]): ColumnMap {
  const mapping: ColumnMap = {}
  const used = new Set<keyof CsvRow>()
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].toLowerCase().trim()
    const mapped = COLUMN_ALIASES[h]
    if (mapped && !used.has(mapped)) {
      mapping[i] = mapped
      used.add(mapped)
    } else {
      mapping[i] = null
    }
  }
  return mapping
}

/**
 * Maps by content, for a file whose column names are ours rather than its own.
 * Only the email column can be identified from data, which is enough to save the
 * one mapping nobody can get wrong. The rest stay unmapped on purpose: guessing
 * which text column holds a first name would be inventing an answer, and the
 * preview screen already asks a human.
 */
export function mapColumnsByContent(rows: string[][], width: number): ColumnMap {
  const mapping: ColumnMap = {}
  for (let i = 0; i < width; i++) mapping[i] = null
  for (let i = 0; i < width; i++) {
    if (rows.some(r => String(r[i] ?? '').includes('@'))) { mapping[i] = 'email'; break }
  }
  return mapping
}

/** Applies the mapping. A row without both a first name and an email cannot
 *  become a BAM, so it is dropped here rather than failing at the API. */
export function toCsvRows(rows: string[][], columnMap: ColumnMap): CsvRow[] {
  return rows.map(row => {
    const out: Record<string, string> = {}
    for (let i = 0; i < row.length; i++) {
      const field = columnMap[i]
      if (field) out[field] = row[i]
    }
    if (out.full_name && !out.first_name) {
      const parts = out.full_name.trim().split(/\s+/)
      out.first_name = parts[0] || ''
      out.last_name = parts.slice(1).join(' ') || ''
    }
    return out as unknown as CsvRow
  }).filter(r => r.first_name && r.email)
}

/** The import button stays disabled until a name and an email are mapped. */
export function hasRequiredColumns(columnMap: ColumnMap): boolean {
  const cols = Object.values(columnMap)
  const hasName = (cols.includes('first_name') && cols.includes('last_name')) || cols.includes('full_name')
  return hasName && cols.includes('email')
}
