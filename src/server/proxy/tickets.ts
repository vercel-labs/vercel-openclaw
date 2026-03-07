import { randomBytes } from "node:crypto";

import { getStore } from "@/server/store/store";

const TICKET_PREFIX = "openclaw-single:ticket:";
const TICKET_TTL_SECONDS = 60;

/**
 * Issue a short-lived, single-use ticket that can be redeemed for the
 * gateway token.  The ticket is stored in the backing store with a 60-second
 * TTL so it never survives beyond one page load.
 */
export async function issueGatewayTicket(gatewayToken: string): Promise<string> {
  const ticketId = randomBytes(24).toString("base64url");
  const store = getStore();
  await store.setValue(TICKET_PREFIX + ticketId, gatewayToken, TICKET_TTL_SECONDS);
  return ticketId;
}

/**
 * Redeem a ticket.  Returns the gateway token if the ticket is valid,
 * or `null` if it has already been used or expired.  Tickets are deleted
 * on first read to enforce single-use semantics.
 */
export async function redeemGatewayTicket(ticketId: string): Promise<string | null> {
  if (!ticketId || ticketId.length > 64) {
    return null;
  }

  const store = getStore();
  const key = TICKET_PREFIX + ticketId;
  const token = await store.getValue<string>(key);
  if (token === null) {
    return null;
  }

  // Delete immediately — single use.
  await store.deleteValue(key);
  return token;
}
