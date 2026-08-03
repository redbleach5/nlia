'use client';

// Home is a client workspace shell. Keep the page itself a Client Component
// so Next does not wrap it in a Streaming/Loading Suspense boundary that
// historically mismatched with streamed <meta charset> in the document head.

import dynamic from 'next/dynamic';

const HomeShell = dynamic(
  () => import('@/components/lia/home-shell').then(m => ({ default: m.HomeShell })),
  {
    ssr: false,
    loading: () => (
      <div className="h-screen flex flex-col items-center justify-center gap-3 bg-background">
        <div className="w-8 h-8 rounded-md bg-accent flex items-center justify-center">
          <span className="text-sm font-bold text-accent-foreground animate-pulse">Л</span>
        </div>
        <div className="text-sm text-text-dim">Загрузка…</div>
      </div>
    ),
  },
);

export default function HomePage() {
  return <HomeShell />;
}
