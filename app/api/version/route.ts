/**
 * GET /api/version — which commit is actually running here.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-13 a fix was pushed, and then "it still fails" was reported. Working out whether
 * the deployed app even had the fix took several probes and ended in an inference rather than
 * an answer: a route that returned 401 instead of 404 proved one commit was live, and nothing
 * could distinguish the four commits after it. That is a silly thing to guess about, and it is
 * the difference between "the fix is wrong" and "the fix is not there yet".
 *
 * Vercel injects VERCEL_GIT_COMMIT_SHA at build time. Comparing it to `git rev-parse HEAD`
 * answers "is my change live" in one request. scripts/probe/deployed-version.js does exactly
 * that.
 *
 * PUBLIC, and deliberately boring. A commit SHA, a branch name and an environment name. No
 * secrets, no env values, no dependency versions, nothing about the database. The repository is
 * private, so the SHA identifies a build without revealing its contents; this is the same
 * information a `/health` endpoint carries almost everywhere.
 *
 * Returns "unknown" rather than throwing when the variables are absent, which is the case for
 * a local `next dev`: the honest answer there is that this is not a Vercel build.
 */
import { NextResponse } from 'next/server'

/** Never cached. A cached version endpoint is worse than none: it reports the previous deploy. */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? null

  return NextResponse.json(
    {
      ok: true,
      commit: sha,
      commitShort: sha ? sha.slice(0, 7) : null,
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      // 'production' | 'preview' | 'development', or null when not on Vercel at all.
      env: process.env.VERCEL_ENV ?? null,
      /** True on a local `next dev`, where there is no Vercel build to identify. */
      local: !sha
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } }
  )
}
