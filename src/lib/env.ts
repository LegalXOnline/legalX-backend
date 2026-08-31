/**
 * isProduction — true when running on Render (or any env where NODE_ENV=production).
 *
 * Render sets the env var RENDER=true automatically on all deployed services.
 * This means even if NODE_ENV is misconfigured, cookies/CORS still behave correctly.
 *
 * DO NOT use process.env.NODE_ENV directly for security-sensitive config.
 * Use this helper instead.
 */
export const isProduction: boolean =
  process.env.RENDER === 'true' ||
  process.env.NODE_ENV === 'production' ||
  process.env.IS_PRODUCTION === 'true'

export const isDevelopment = !isProduction
