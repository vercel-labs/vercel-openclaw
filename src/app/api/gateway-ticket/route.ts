import { requireMutationAuth } from "@/server/auth/route-auth";
import { redeemGatewayTicket } from "@/server/proxy/tickets";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  let ticketId: string;
  try {
    const body: unknown = await request.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("ticket" in body) ||
      typeof (body as { ticket: unknown }).ticket !== "string"
    ) {
      return Response.json({ error: "missing ticket" }, { status: 400 });
    }
    ticketId = (body as { ticket: string }).ticket;
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const token = await redeemGatewayTicket(ticketId);
  if (token === null) {
    const response = Response.json({ error: "ticket expired or already used" }, { status: 410 });
    if (auth.setCookieHeader) {
      response.headers.append("Set-Cookie", auth.setCookieHeader);
    }
    return response;
  }

  const response = Response.json({ token });
  response.headers.set("Cache-Control", "no-store, private");
  if (auth.setCookieHeader) {
    response.headers.append("Set-Cookie", auth.setCookieHeader);
  }
  return response;
}
