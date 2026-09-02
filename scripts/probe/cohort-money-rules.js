/**
 * Q: Does every cohort's money configuration match the rules Robin actually confirmed?
 *
 * The cohorts screen prints these values straight from the database, so "carries
 * over" on that screen is not a wording problem, it is the setting. On 2026-09-02
 * `Class of 2027` (57 real BAMs, onboarding since 9/1) was found holding
 * rollover_mode='accumulate' and first_cohort_all_review=true: both left over from
 * the 2026-07-15 model that Robin replaced on 2026-08-04.
 *
 * The confirmed rules:
 *   rollover_mode            forfeit   flat $150/month, no carryover (Robin, 2026-08-04)
 *   first_cohort_all_review  false     auto-approve is the default (Mirae, since 2026-08-10)
 *   reimbursement_max        150
 *   salary_default           218.75    academic year; summer BAMs are 250
 *
 * Read only. Usage: node scripts/probe/cohort-money-rules.js
 * To correct a row:  node scripts/probe/fix-cohort-money-rules.js --apply
 */
const { serviceClient, pass, fail, info, verdict } = require('./_lib')

const EXPECTED = {
  rollover_mode: 'forfeit',
  first_cohort_all_review: false,
  reimbursement_max: 150,
}

async function main() {
  const db = serviceClient()

  const { data: cohorts, error } = await db.from('cohorts')
    .select('id, name, salary_default, reimbursement_max, rollover_mode, first_cohort_all_review, start_date, end_date')
    .order('start_date')
  if (error) { fail(`cohorts unreadable: ${error.message}`); return verdict('cohort money rules') }
  if (!cohorts.length) { info('no cohorts'); return verdict('cohort money rules') }

  for (const c of cohorts) {
    const { count: bamCount } = await db.from('bams')
      .select('id', { count: 'exact', head: true }).eq('cohort_id', c.id)

    info(`${c.name} (${bamCount} BAMs, ${c.start_date} to ${c.end_date})`)

    for (const [col, want] of Object.entries(EXPECTED)) {
      const got = c[col]
      const same = col === 'reimbursement_max' ? Number(got) === want : got === want
      if (same) {
        pass(`  ${col} = ${JSON.stringify(got)}`)
      } else {
        // Say what it costs, not just that it differs. A wrong flag here is money.
        const consequence = col === 'rollover_mode'
          ? 'unspent allowance would roll into next month, raising the cap above $150'
          : col === 'first_cohort_all_review'
            ? 'every receipt is forced to admin review, so nothing auto-approves'
            : 'the monthly cap is not $150'
        fail(`  ${col} = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}: ${consequence}`)
      }
    }

    // Salary is per cohort by design (218.75 academic, 250 summer), so this is
    // reported rather than judged.
    info(`  salary_default = ${c.salary_default}`)

    // How much money has already been computed under whatever these values are.
    // A wrong flag on a cohort with no ledger rows has not paid anyone yet.
    const { data: bamIds } = await db.from('bams').select('id').eq('cohort_id', c.id)
    const ids = (bamIds ?? []).map(b => b.id)
    if (ids.length) {
      const { data: led, error: lErr } = await db.from('reimbursement_ledger')
        .select('period, paid_cad, entitlement_cad').in('bam_id', ids)
      if (lErr) fail(`  ledger unreadable: ${lErr.message}`)
      else if (!led.length) info('  0 ledger rows, so nothing has been paid under these settings yet')
      else {
        const overCap = led.filter(l => Number(l.entitlement_cad) > Number(EXPECTED.reimbursement_max))
        info(`  ${led.length} ledger rows`)
        if (overCap.length === 0) pass(`  no ledger row carries an entitlement above $${EXPECTED.reimbursement_max}`)
        else for (const l of overCap) fail(`  ${l.period} entitlement is $${l.entitlement_cad}, above the $150 cap: carryover reached the money`)
      }
    }
  }

  // The column default decides what the NEXT cohort gets, and it disagreed with
  // lib/policy.ts for weeks without anyone noticing. The REST API cannot read a
  // column default, so this one is checked by creating a cohort, not from here.
  info('column defaults are not visible through the REST API: migration 0032 sets first_cohort_all_review to default false')

  verdict('cohort money rules')
}
main().catch(e => { fail(String(e && e.message ? e.message : e)); verdict('cohort money rules') })
