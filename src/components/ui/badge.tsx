type BadgeProps = {
  children: React.ReactNode;
  className?: string;
};

export function StatusBadge({ status }: { status: string }) {
  const display =
    status === "asleep"
      ? { className: "stopped", label: "Asleep" }
      : { className: status, label: status };
  return (
    <span className={`status-badge ${display.className}`}>{display.label}</span>
  );
}

export function Badge({ children, className = "" }: BadgeProps) {
  return <span className={`event-badge ${className}`}>{children}</span>;
}

export function ChannelPill({
  children,
  variant = "idle",
}: BadgeProps & { variant?: "good" | "bad" | "idle" }) {
  return <span className={`channel-pill ${variant}`}>{children}</span>;
}

export function ExitCodeBadge({ exitCode }: { exitCode: number }) {
  const ok = exitCode === 0;
  return (
    <span className={`ssh-exit-badge ${ok ? "ssh-exit-ok" : "ssh-exit-err"}`}>
      exit {exitCode}
    </span>
  );
}
