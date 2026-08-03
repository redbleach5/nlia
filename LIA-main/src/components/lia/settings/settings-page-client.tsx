'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import { SettingsPanel } from '@/components/lia/settings/settings-panel';
import type { SettingsSection } from '@/components/lia/settings/settings-sections';
import { LIA_APP_EVENTS, onLiaAppEvent } from '@/lib/lia-app-events';

type SettingsPageClientProps = {
  section: SettingsSection;
};

export function SettingsPageClient({ section }: SettingsPageClientProps) {
  const router = useRouter();

  const goSection = useCallback((next: SettingsSection) => {
    router.replace(`/settings/${next}`, { scroll: false });
  }, [router]);

  // Legacy event (banner / hotkeys that still dispatch)
  useEffect(() => {
    return onLiaAppEvent(LIA_APP_EVENTS.openSettings, () => {
      router.push('/settings/model');
    });
  }, [router]);

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="lia-header border-b border-border shrink-0">
        <Link
          href="/"
          className="lia-icon-btn"
          title="К чату"
          aria-label="Вернуться к чату"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
        </Link>
        <div className="min-w-0 flex flex-col justify-center leading-none gap-0.5">
          <h1 className="text-[0.9375rem] font-display font-semibold tracking-tight text-foreground">
            Настройки
          </h1>
          <span className="text-[0.625rem] text-text-dim font-display tracking-wide hidden sm:block">
            модель · вид · база · о Лии
          </span>
        </div>
        <div className="flex-1" />
        <Link
          href="/"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-surface-2"
        >
          К чату
        </Link>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-6 sm:py-8">
          <SettingsPanel section={section} onSectionChange={goSection} />
        </div>
      </main>
    </div>
  );
}
