import { requireJsonRouteAuth, authJsonOk } from "@/server/auth/route-auth";
import { getFirewallState } from "@/server/firewall/state";
import { jsonError } from "@/shared/http";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  let body: { domain?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return jsonError(new Error("Invalid JSON body."));
  }

  if (typeof body.domain !== "string" || body.domain.trim().length === 0) {
    return jsonError(new Error("Missing or empty 'domain' field."));
  }

  const domain = body.domain.trim().toLowerCase();
  const firewall = await getFirewallState();

  let allowed: boolean;
  let reason: string;

  switch (firewall.mode) {
    case "disabled":
      allowed = true;
      reason = "Firewall is disabled — all traffic is allowed.";
      break;
    case "learning":
      allowed = true;
      reason = "Firewall is in learning mode — all traffic is allowed.";
      break;
    case "enforcing": {
      const inAllowlist = firewall.allowlist.includes(domain);
      allowed = inAllowlist;
      reason = inAllowlist
        ? `Domain "${domain}" is in the allowlist.`
        : `Domain "${domain}" is not in the allowlist — traffic would be blocked.`;
      break;
    }
  }

  return authJsonOk({ allowed, reason, domain, mode: firewall.mode }, auth);
}
