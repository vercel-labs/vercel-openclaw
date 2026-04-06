"use client";

import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

const icons = {
  light: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" />
    </svg>
  ),
  dark: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13.5 8.5a5.5 5.5 0 1 1-7-7 4.5 4.5 0 0 0 7 7z" />
    </svg>
  ),
  system: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="3" width="12" height="9" rx="1" />
      <path d="M6 15h4M8 12v3" />
    </svg>
  ),
};

const cycle = ["system", "light", "dark"] as const;
const labels: Record<string, string> = {
  system: "System theme",
  light: "Light theme",
  dark: "Dark theme",
};

const emptySubscribe = () => () => {};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

  if (!mounted) {
    return (
      <button
        className="button ghost theme-toggle"
        aria-label="Toggle theme"
        disabled
      />
    );
  }

  const current = theme ?? "system";
  const next = cycle[(cycle.indexOf(current as (typeof cycle)[number]) + 1) % cycle.length];

  return (
    <button
      className="button ghost theme-toggle"
      onClick={() => setTheme(next)}
      aria-label={labels[current]}
      title={labels[current]}
    >
      {icons[current as keyof typeof icons] ?? icons.system}
    </button>
  );
}
