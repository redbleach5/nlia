import { notFound } from 'next/navigation';
import { SettingsPageClient } from '@/components/lia/settings/settings-page-client';
import {
  isSettingsSection,
  resolveSettingsSection,
  SETTINGS_SECTIONS,
} from '@/components/lia/settings/settings-sections';

type PageProps = {
  params: Promise<{ section: string }>;
};

export function generateStaticParams() {
  return SETTINGS_SECTIONS.map((section) => ({ section }));
}

export default async function SettingsSectionPage({ params }: PageProps) {
  const { section: raw } = await params;
  if (!isSettingsSection(raw)) notFound();
  return <SettingsPageClient section={resolveSettingsSection(raw)} />;
}
