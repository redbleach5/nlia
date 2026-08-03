// ============================================================================
// Create Runtime — shared types (client + server safe).
// ============================================================================

export const PROJECT_KINDS = ['web', 'game', 'cli', 'script', 'api'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const PREVIEW_TYPES = ['iframe', 'terminal', 'none'] as const;
export type PreviewType = (typeof PREVIEW_TYPES)[number];

export type ProjectScripts = {
  install?: string;
  dev?: string;
  build?: string;
  start?: string;
};

export type ProjectPreview = {
  type: PreviewType;
  /** Localhost port for iframe preview (required when type=iframe). */
  port?: number;
  url?: string;
};

export type ProjectTreeEntry = {
  path: string;
  role: string;
};

/** Design Gate proposal / lia.project.json shape. */
export type ProjectDesign = {
  name: string;
  kind: ProjectKind;
  /** Canonical scaffold id — locked presets ignore free-form stacks. */
  preset?: string;
  stack: string[];
  tree: ProjectTreeEntry[];
  scripts: ProjectScripts;
  preview: ProjectPreview;
  entry?: string;
  acceptance: string;
  createdBy: 'lia';
};

export type RuntimeStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'healthy'
  | 'unhealthy'
  | 'stopped'
  | 'error';

export type RuntimeLogLine = {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  ts: number;
};

export type RuntimeSessionSnapshot = {
  taskId: string;
  status: RuntimeStatus;
  scriptKey?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  port?: number | null;
  previewUrl?: string | null;
  pid?: number | null;
  restartCount: number;
  lastError?: string | null;
  startedAt?: number | null;
};
