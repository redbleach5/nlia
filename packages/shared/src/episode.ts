/**
 * Episode — see docs/ARCHITECTURE.md § 5.1.
 *
 * M1: full DTO for API + Zustand store.
 */

export type EpisodeMode = "chat" | "agent" | "research";

export interface Episode {
  id: string;
  title: string | null;
  mode: EpisodeMode;
  isDefault: boolean;
  summary: string | null;
  createdAt: number; // unix seconds
  updatedAt: number;
  endedAt: number | null;
  lastMessageAt: number | null;
}

/** Episode list item with derived counts (for sidebar display). */
export interface EpisodeListItem extends Episode {
  messageCount: number;
}

export interface EnsureDefaultResponse {
  episodes: EpisodeListItem[];
  created: boolean;
  episodeId: string | null;
}
