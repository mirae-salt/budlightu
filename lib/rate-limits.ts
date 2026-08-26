/**
 * The IP-keyed limits, in one place, because they were in three and disagreed.
 *
 * WHAT HAPPENED
 *
 * On 2026-08-26 three BAMs were onboarded from one office connection inside 34
 * seconds and the fourth person got "Too many attempts from this network today."
 * The middleware limit had been raised to 100 a day that same morning, so the raise
 * looked done and the wall was still there.
 *
 * There were three definitions of one rule:
 *
 *   middleware.ts LIMITS                          100 / IP / day   let it through
 *   onboarding-ingest/index.ts, hardcoded 3         3 / IP / day   THIS is what fired
 *   policy table `onboarding_attempts_per_ip_per_day`           3  read by nobody
 *
 * The one that decides is the least visible of the three, and the policy row that
 * looks like the control is not wired to anything. Raising the number in the obvious
 * place changed nothing, which is the worst possible shape for a limit to have.
 *
 * WHY 100
 *
 * September 1: 58 students sign up around the same time, some of them on one campus
 * network, and a form people get wrong once before they get it right. Each retry
 * spends an attempt. The invite token is the real gate here, not the IP: onboarding
 * cannot be used at all without a valid `invite_token_hash` on a row still marked
 * pending, and completing onboarding flips that status, so a token works once. The IP
 * ceiling is the outer fence.
 *
 * BOTH FENCES STAY, ON THE SAME NUMBER
 *
 * They are not redundant. The middleware counter is an in-process Map, so on Vercel it
 * is per-instance and resets on a cold start. The onboarding counter is rows in
 * audit_log, so it is durable and exact. Keeping both means a burst is caught early
 * and the real count is still right; keeping them on one constant means raising the
 * limit raises the limit.
 *
 * Author: Mirae Lee <mirae.lee@ilovesalt.com>
 */

/**
 * Onboarding submissions allowed from one IP per day.
 *
 * NOTE: `policy.onboarding_attempts_per_ip_per_day` (seeded at 3 in migration 0006) is
 * NOT read by anything and does not control this. It predates the code and was never
 * wired. Do not change that row expecting an effect; change this constant. Removing the
 * row needs a migration and is worth doing, because a setting that looks like a control
 * and is not one is how the wrong number stayed live.
 */
export const ONBOARDING_MAX_PER_IP_PER_DAY = 100
