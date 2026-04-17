export type View =
  | "status"
  | "channels"
  | "firewall"
  | "terminal"
  | "logs"
  | "snapshots"
  | "diagnostics"
  | "faq";

export const VIEW_SLUGS: readonly View[] = [
  "status",
  "channels",
  "firewall",
  "terminal",
  "logs",
  "snapshots",
  "diagnostics",
  "faq",
] as const;

export function pathForView(v: View): string {
  return v === "status" ? "/" : `/${v}`;
}

export function viewForPath(pathname: string): View {
  const segment = pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  if (segment === "") return "status";
  return (VIEW_SLUGS as readonly string[]).includes(segment)
    ? (segment as View)
    : "status";
}
