/**
 * Shared eTLD+1 domain grouping utilities.
 *
 * This module has ZERO node: imports so it works in both server (Node.js)
 * and client (browser) bundles.
 */

/**
 * Known multi-label public suffixes where the registrable domain is
 * one label to the left of the suffix. This is a curated subset — not the
 * full PSL — covering the most common cases seen in sandbox egress traffic.
 */
export const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk",
  "co.jp", "or.jp", "ne.jp", "ac.jp",
  "com.au", "net.au", "org.au", "edu.au",
  "co.nz", "net.nz", "org.nz",
  "co.za", "org.za", "web.za",
  "com.br", "org.br", "net.br",
  "com.cn", "net.cn", "org.cn",
  "co.in", "net.in", "org.in",
  "co.kr", "or.kr",
  "com.mx", "org.mx",
  "com.tw", "org.tw",
  "co.il",
  "com.sg",
  "com.hk",
  "com.ar",
  "co.id",
  // Cloud hosting suffixes that act like public suffixes
  "amazonaws.com", "s3.amazonaws.com",
  "cloudfront.net",
  "azurewebsites.net", "blob.core.windows.net",
  "herokuapp.com",
  "appspot.com",
  "firebaseapp.com",
  "cloudfunctions.net",
  "run.app",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "r2.dev",
  "fly.dev",
  "render.com",
  "onrender.com",
  "railway.app",
  "deno.dev",
]);

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Extract the registrable domain (eTLD+1) from a fully-qualified hostname.
 * Returns the hostname itself for single-label names and IP addresses.
 *
 * Examples:
 *   api.openai.com       → openai.com
 *   cdn.openai.com       → openai.com
 *   foo.co.uk            → foo.co.uk
 *   bar.baz.co.uk        → baz.co.uk
 *   us-east-1.ec2.amazonaws.com → ec2.amazonaws.com
 *   openai.com           → openai.com
 */
export function getRegistrableDomain(hostname: string): string {
  // Quick IP check (v4 literal or v6 with colon)
  if (IPV4_RE.test(hostname) || hostname.includes(":")) {
    return hostname;
  }

  const labels = hostname.split(".");
  if (labels.length <= 2) return hostname;

  // Check multi-label suffixes from longest to shortest
  // Max take=4 covers suffixes like blob.core.windows.net (4 labels)
  for (let take = Math.min(labels.length - 1, 4); take >= 2; take--) {
    const suffix = labels.slice(-take).join(".");
    if (MULTI_LABEL_SUFFIXES.has(suffix)) {
      // registrable = one label left of the suffix
      return labels.slice(-(take + 1)).join(".");
    }
  }

  // Default: last two labels
  return labels.slice(-2).join(".");
}
