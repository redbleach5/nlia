import 'server-only';

// Tools registry — chat mode (web_search, fetch_page, KB tools, save_artifact).

export { buildChatTools, createWebSearchTool, createFetchPageTool, createSaveArtifactTool } from './shared-chat-tools';
export type { SaveArtifactResult } from './shared-chat-tools';

import { buildChatTools } from './shared-chat-tools';

export const tools = buildChatTools();
