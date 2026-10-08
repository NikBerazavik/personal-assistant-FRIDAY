/**
 * Bearer-token check shared by the cron endpoints. Fails closed: if
 * CRON_SECRET is not configured, nothing is allowed through.
 */
export function authorized(req) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && req.headers.authorization === `Bearer ${secret}`;
}
