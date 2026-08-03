'use client';

import Link from 'next/link';
import { Settings as SettingsIcon } from 'lucide-react';

/** Header gear — opens full settings page. */
export function SettingsLink({ className }: { className?: string }) {
  return (
    <Link
      href="/settings/model"
      className={className ?? 'lia-icon-btn'}
      title="Настройки"
      aria-label="Открыть настройки"
    >
      <SettingsIcon className="w-3.5 h-3.5" />
    </Link>
  );
}
