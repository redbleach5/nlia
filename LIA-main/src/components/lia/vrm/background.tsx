'use client';

// ============================================================================
// BackgroundLayer — CSS-фон под Canvas (solid / gradient / radial / transparent).
// ============================================================================

import type { AvatarConfig } from '@/lib/avatar-config';

type BackgroundConfig = AvatarConfig['background'];

export function BackgroundLayer({
  background,
  /** @deprecated use `background` */
  config,
  edgeToEdge = false,
}: {
  background?: BackgroundConfig;
  config?: Pick<AvatarConfig, 'background'>;
  edgeToEdge?: boolean;
}) {
  const { style, color, edgeColor } = background ?? config?.background ?? {
    style: 'radial' as const,
    color: '#f5f1e8',
    edgeColor: '#fafafa',
  };
  if (style === 'transparent') return null;

  let bg: React.CSSProperties;
  if (style === 'solid') {
    bg = { background: color };
  } else if (style === 'gradient') {
    bg = { background: `linear-gradient(135deg, ${color} 0%, ${edgeColor} 100%)` };
  } else {
    bg = { background: `radial-gradient(circle at 50% 40%, ${color} 0%, ${edgeColor} 100%)` };
  }

  return (
    <div
      className={`absolute inset-0 pointer-events-none ${edgeToEdge ? '' : 'rounded-2xl'}`}
      style={bg}
    />
  );
}
