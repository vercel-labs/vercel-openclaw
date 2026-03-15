"use client";

import type { ChannelConnectability } from "@/shared/channel-connectability";

export function ConnectabilityNotice({
  connectability,
}: {
  connectability: ChannelConnectability;
}) {
  if (connectability.issues.length === 0) {
    return null;
  }

  return (
    <div className="stack" style={{ marginBottom: 12 }}>
      {connectability.issues.map((issue) => (
        <p
          key={`${connectability.channel}:${issue.id}`}
          className={issue.status === "fail" ? "error-banner" : "muted-copy"}
        >
          {issue.message}
          {issue.env.length > 0 ? ` (${issue.env.join(", ")})` : ""}
        </p>
      ))}
    </div>
  );
}
