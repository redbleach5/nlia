'use client';

// ClientBootstrap — клиентская обёртка для mount-effect хуков.
//
// page.tsx — Server Component. Ему нельзя вызывать useEpisodes/useHealth,
// но эти хуки нужны для инициализации на клиенте (ensure-default episode,
// periodic Ollama health check, agent SSE subscription). Этот компонент рендерится внутри page.tsx
// и вызывает хуки при монтировании.
//
// Возвращает null — не добавляет ничего в DOM.

import { useEpisodes } from '@/hooks/use-episodes';
import { useHealth } from '@/hooks/use-health';
import { useAgentStream } from '@/hooks/use-agent-stream';

export function ClientBootstrap() {
  useEpisodes();
  useHealth();
  useAgentStream();
  return null;
}
