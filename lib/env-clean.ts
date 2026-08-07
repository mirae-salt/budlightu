/**
 * DEPRECATED shim. Do not add call sites; import from `lib/sanitize` instead.
 *
 * This module used to carry a SECOND, independently written copy of the
 * invisible-character stripper (P1-18, audit 2026-08-07). Two copies of that
 * logic is exactly how one of them drifts and a BOM slips through the other, so
 * the implementation now lives in `lib/sanitize.ts` and this file only re-exports.
 *
 * Naming note: the old `envAddress(name, fallback)` / `envAddressList(name, fallback)`
 * here collided with `sanitize.envAddress(name, env)` / `envAddressList(name, env)`,
 * which have different return contracts (null-on-invalid vs fallback-on-empty).
 * They are now `envAddressOr` / `envAddressListOr` so the two cannot be confused.
 */
export {
  stripInvisible,
  cleanEnvValue,
  cleanAddress,
  isEmailAddress,
  addressProblem,
  envAddressOr,
  envAddressListOr,
  envToken,
  tokenProblem,
  PO_NUMBER_RE,
  sanitizePoNumber
} from './sanitize'
