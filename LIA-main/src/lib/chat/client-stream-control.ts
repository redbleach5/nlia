// Module-level abort for the in-flight chat fetch.
// Episodes select() aborts here so a reply for chat A cannot keep writing
// into the UI after the user switched to B.

let activeAbort: AbortController | null = null;
let activeEpisodeId: string | null = null;

export function beginChatStream(episodeId: string, ac: AbortController): void {
  activeAbort = ac;
  activeEpisodeId = episodeId;
}

export function endChatStream(ac: AbortController): void {
  if (activeAbort === ac) {
    activeAbort = null;
    activeEpisodeId = null;
  }
}

export function abortActiveChatStream(): void {
  activeAbort?.abort();
}

export function getActiveChatStreamEpisodeId(): string | null {
  return activeEpisodeId;
}
