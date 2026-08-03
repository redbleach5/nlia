'use client';

// ============================================================================
// Global error boundary — показывается если весь page.tsx крашится.
// ============================================================================

import { AlertCircle, RotateCcw } from 'lucide-react';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[GlobalError]', error);
  }, [error]);

  return (
    <div className="h-screen flex flex-col items-center justify-center gap-4 p-6 bg-background text-foreground">
      <AlertCircle className="w-12 h-12 text-destructive" />
      <div className="text-lg font-medium font-display">Что-то пошло не так</div>
      <div className="text-sm text-muted-foreground text-center max-w-md leading-relaxed">
        Лия споткнулась. Можно попробовать ещё раз — обычно этого достаточно.
        {error.digest && (
          <div className="mt-2 text-[10px] text-text-dim">Код для поддержки: {error.digest}</div>
        )}
      </div>
      <button
        type="button"
        onClick={reset}
        className="flex items-center gap-2 px-4 py-2 rounded-md bg-accent hover:bg-accent/90 text-accent-foreground text-sm transition-colors"
      >
        <RotateCcw className="w-4 h-4" />
        Попробовать снова
      </button>
    </div>
  );
}
