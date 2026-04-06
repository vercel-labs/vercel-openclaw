import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";

import "./globals.css";

export const metadata: Metadata = {
  title: "Vercel OpenClaw",
  description:
    "Single-instance OpenClaw deployment with auto-restore and a learning firewall.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="app-body">
        <ThemeProvider>
          {children}
          <Toaster theme="system" position="bottom-right" richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}
