/**
 * Q: Does a roster file lose its first person on import?
 *
 * It did. Row 1 was taken as the column header unconditionally, so a file that
 * started straight in with a person imported everyone except them, reported
 * success, and looked fine until somebody counted. This runs the real parser
 * from lib/roster-import.ts over both shapes of file.
 *
 * Read only, touches no database. Usage: node scripts/probe/roster-import.js
 */
const { pass, fail, info, verdict, loadTs } = require('./_lib')

const M = loadTs('lib/roster-import.ts')

/** Runs a grid through the same three calls the roster page makes. */
function importGrid(grid) {
  const { headers, rows, headerDetected } = M.splitHeaderAndRows(grid)
  const columnMap = headerDetected
    ? M.autoMapColumns(headers)
    : M.mapColumnsByContent(rows, headers.length)
  return { headers, rows, headerDetected, columnMap, people: M.toCsvRows(rows, columnMap) }
}

function main() {
  // 1. A file WITH a header row. The old behaviour, which has to keep working.
  const withHeader = [
    ['First Name', 'Last Name', 'Email', 'School'],
    ['Lucas', 'Grabowski', 'lucas@queensu.ca', "Queen's U"],
    ['Isla', "O'Sullivan", 'isla@dal.ca', 'Dalhousie'],
  ]
  const a = importGrid(withHeader)
  if (a.headerDetected) pass('header row recognised as a header')
  else fail('a file with named columns was read as headerless')
  if (a.people.length === 2) pass(`${a.people.length} people from 2 data rows`)
  else fail(`expected 2 people, got ${a.people.length}: ${JSON.stringify(a.people)}`)
  if (a.people[0] && a.people[0].email === 'lucas@queensu.ca') pass('first data row survives')
  else fail(`first data row wrong: ${JSON.stringify(a.people[0])}`)

  // 2. The bug. No header row: row 1 is a person and must not be eaten.
  const noHeader = [
    ['Lucas', 'Grabowski', 'lucas@queensu.ca'],
    ['Isla', "O'Sullivan", 'isla@dal.ca'],
    ['Roman', 'Lombardi', 'roman@mcgill.ca'],
  ]
  const b = importGrid(noHeader)
  if (!b.headerDetected) pass('headerless file recognised, row 1 kept as data')
  else fail('row 1 was consumed as a header: this is the reported bug')
  if (b.rows.length === 3) pass('all 3 rows kept')
  else fail(`expected 3 rows, got ${b.rows.length}`)
  const emailCol = Object.entries(b.columnMap).find(([, v]) => v === 'email')
  if (emailCol && emailCol[0] === '2') pass('email column identified by content (index 2)')
  else fail(`email column not found by content: ${JSON.stringify(b.columnMap)}`)
  // Names stay unmapped on purpose, so nobody imports until a human maps them.
  if (!M.hasRequiredColumns(b.columnMap)) pass('import stays blocked until the name columns are mapped')
  else fail('import allowed itself to run on guessed name columns')
  // ...and once mapped by hand, all three arrive.
  const mapped = { 0: 'first_name', 1: 'last_name', 2: 'email' }
  const people = M.toCsvRows(b.rows, mapped)
  if (people.length === 3 && people[0].first_name === 'Lucas') {
    pass('after mapping, all 3 people import including Lucas')
  } else {
    fail(`expected 3 people starting with Lucas, got ${JSON.stringify(people)}`)
  }

  // 3. A title row above the real header, which is what Excel exports often look
  //    like. It carries no email and no alias, so it is treated as a header and
  //    the real header becomes row 1 of the data. Not silently wrong: the admin
  //    sees "BAM Roster 2026" offered as a column name and remaps.
  const titled = [
    ['BAM Roster 2026-2027', '', ''],
    ['First Name', 'Last Name', 'Email'],
    ['Lucas', 'Grabowski', 'lucas@queensu.ca'],
  ]
  const c = importGrid(titled)
  info(`title-row file: headerDetected=${c.headerDetected}, headers=${JSON.stringify(c.headers)}`)
  if (c.people.length === 0) {
    pass('a stray title row maps nothing, so nothing imports by accident')
  } else {
    fail(`a title row produced ${c.people.length} people without a human mapping them`)
  }

  // 4. Ragged rows. Excel drops trailing empty cells, so row widths differ.
  const ragged = [
    ['First', 'Last', 'Email', 'School'],
    ['Lucas', 'Grabowski', 'lucas@queensu.ca'],
  ]
  const d = importGrid(ragged)
  if (d.rows[0] && d.rows[0].length === 4 && d.rows[0][3] === '') {
    pass('short rows padded to the header width')
  } else {
    fail(`ragged row not padded: ${JSON.stringify(d.rows[0])}`)
  }

  // 5. A full-name column, single field, no header.
  const fullNameNoHeader = [['Lucas Grabowski', 'lucas@queensu.ca']]
  const e = importGrid(fullNameNoHeader)
  if (!e.headerDetected && e.rows.length === 1) pass('single headerless row is kept')
  else fail(`single headerless row lost: headerDetected=${e.headerDetected}, rows=${e.rows.length}`)
  const split = M.toCsvRows(e.rows, { 0: 'full_name', 1: 'email' })
  if (split.length === 1 && split[0].first_name === 'Lucas' && split[0].last_name === 'Grabowski') {
    pass('full name splits into first and last')
  } else {
    fail(`full name not split: ${JSON.stringify(split)}`)
  }

  // 6. CSV text path, headerless, to confirm both file formats agree.
  const csv = M.parseCsvGrid('Lucas,Grabowski,lucas@queensu.ca\nIsla,O’Sullivan,isla@dal.ca')
  const f = importGrid(csv)
  if (!f.headerDetected && f.rows.length === 2) pass('CSV path agrees with the Excel path')
  else fail(`CSV path disagrees: headerDetected=${f.headerDetected}, rows=${f.rows.length}`)

  // 7. Empty file.
  const g = importGrid([[''], ['  ']])
  if (g.rows.length === 0) pass('an empty file yields no rows, so the upload reports an error')
  else fail(`empty file produced ${g.rows.length} rows`)

  verdict('roster import')
}

try { main() } catch (e) { fail(String(e && e.message ? e.message : e)); verdict('roster import') }
