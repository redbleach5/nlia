import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Настройки — Лия',
  description: 'Модель, образ, база знаний и профиль.',
};

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
