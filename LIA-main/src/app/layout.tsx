import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Plus_Jakarta_Sans, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { logServerStartup } from "@/lib/server-startup";
import { ThemeProvider, themeNoFlashScript } from '@/components/lia/theme-provider';

// Запускаем startup-лог один раз за процесс (globalThis flag защищает от
// повторного вызова при HMR и множественных server-render).
// layout.tsx — server component, код выполняется только на сервере.
void logServerStartup().catch(() => null);

// ============================================================================
// Шрифты — Companion Workspace
//   --font-sans    → Inter (UI density)
//   --font-display → Plus Jakarta Sans (брендинг)
//   --font-mono    → JetBrains Mono (код)
// ============================================================================
const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-display",
  subsets: ["latin", "cyrillic-ext"],
  weight: ["500", "600", "700"],
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Лия — компаньон",
  description: "Тёплый собеседник и помощник с собственным характером.",
  icons: {
    icon: "/logo.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#f8f5f0",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Do NOT add a manual <head> — App Router owns metadata/streaming head.
  // A custom <head> can hoist <meta charset> into the wrong place and produce
  // the Suspense vs meta charset hydration mismatch.
  return (
    <html lang="ru" data-theme="classic" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${jakarta.variable} ${jetbrains.variable} antialiased bg-background text-foreground font-sans`}
        suppressHydrationWarning
      >
        <Script id="lia-theme-init" strategy="beforeInteractive">
          {themeNoFlashScript}
        </Script>
        <ThemeProvider>
          {children}
          <Toaster
            position="bottom-right"
            toastOptions={{
              style: {
                background: "var(--surface-2)",
                color: "var(--foreground)",
                border: "1px solid var(--border)",
                borderRadius: "0.5rem",
                fontSize: "0.8125rem",
              },
            }}
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
