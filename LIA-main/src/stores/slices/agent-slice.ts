// ============================================================================
// Agent slice — список задач + активная задача (real-time SSE данные).
// ============================================================================

import type { StateCreator } from 'zustand';
import type {
  AgentTask,
  AgentTaskStatus,
  AgentStepLive,
  AgentPlanLive,
  ProjectDesignLive,
  RuntimeLogLive,
  RuntimeStatusLive,
} from './types';
import type { EpisodesSlice } from './episodes-slice';
import type { MessagesSlice } from './messages-slice';
import type { HealthSlice } from './health-slice';

export type AgentSlice = {
  agentTasks: AgentTask[];

  activeTaskId: string | null;
  activeTaskStatus: AgentTaskStatus | null;
  activeTaskPlan: AgentPlanLive | null;
  activeTaskSteps: AgentStepLive[];
  activeTaskQuestion: string | null;
  activeTaskResult: string | null;
  activeTaskError: string | null;
  activeTaskArtifacts: Array<{ filename: string; url: string; step: number }>;
  activeTaskFileChanges: Array<{
    changeId: string;
    path: string;
    tool: 'edit_file' | 'write_file';
    diff?: string;
    canUndo: boolean;
    step: number;
    ts: number;
    undone?: boolean;
  }>;
  activeTaskDesign: ProjectDesignLive | null;
  activeTaskRuntimeLogs: RuntimeLogLive[];
  activeTaskRuntime: RuntimeStatusLive | null;
  /** Coding backend for the active turn. */
  activeTaskExecutor: 'claude_code' | 'react' | null;

  setAgentTasks: (t: AgentTask[]) => void;
  addAgentTask: (t: AgentTask) => void;
  updateAgentTaskInList: (id: string, patch: Partial<AgentTask>) => void;

  setActiveTask: (id: string | null) => void;
  setActiveTaskStatus: (status: AgentTaskStatus | null) => void;
  setActiveTaskPlan: (plan: AgentPlanLive | null) => void;
  addActiveTaskStep: (step: AgentStepLive) => void;
  updateActiveTaskStep: (step: number, patch: Partial<Omit<AgentStepLive, 'step' | 'ts'>>) => void;
  setActiveTaskQuestion: (q: string | null) => void;
  setActiveTaskResult: (r: string | null) => void;
  setActiveTaskError: (e: string | null) => void;
  addActiveTaskArtifact: (a: { filename: string; url: string; step: number }) => void;
  addActiveTaskFileChange: (c: {
    changeId: string;
    path: string;
    tool: 'edit_file' | 'write_file';
    diff?: string;
    canUndo: boolean;
    step: number;
    ts: number;
  }) => void;
  markActiveTaskFileChangeUndone: (changeId: string) => void;
  markActiveTaskFileChangesUndone: (changeIds: string[]) => void;
  markAllActiveTaskFileChangesUndone: () => void;
  setActiveTaskDesign: (d: ProjectDesignLive | null) => void;
  addActiveTaskRuntimeLog: (line: RuntimeLogLive) => void;
  setActiveTaskRuntime: (r: RuntimeStatusLive | null) => void;
  clearActiveTaskRuntimeLogs: () => void;
  setActiveTaskExecutor: (e: 'claude_code' | 'react' | null) => void;

  resetActiveTask: () => void;
};

const INITIAL_ACTIVE_TASK: Pick<AgentSlice,
  | 'activeTaskId' | 'activeTaskStatus' | 'activeTaskPlan'
  | 'activeTaskSteps' | 'activeTaskQuestion' | 'activeTaskResult'
  | 'activeTaskError' | 'activeTaskArtifacts'
  | 'activeTaskFileChanges'
  | 'activeTaskDesign' | 'activeTaskRuntimeLogs' | 'activeTaskRuntime'
  | 'activeTaskExecutor'
> = {
  activeTaskId: null,
  activeTaskStatus: null,
  activeTaskPlan: null,
  activeTaskSteps: [],
  activeTaskQuestion: null,
  activeTaskResult: null,
  activeTaskError: null,
  activeTaskArtifacts: [],
  activeTaskFileChanges: [],
  activeTaskDesign: null,
  activeTaskRuntimeLogs: [],
  activeTaskRuntime: null,
  activeTaskExecutor: null,
};

export const createAgentSlice: StateCreator<
  EpisodesSlice & MessagesSlice & AgentSlice & HealthSlice,
  [],
  [],
  AgentSlice
> = (set) => ({
  agentTasks: [],
  ...INITIAL_ACTIVE_TASK,

  setAgentTasks: (t) => set({ agentTasks: t }),
  addAgentTask: (t) => set((s) => ({ agentTasks: [t, ...s.agentTasks] })),
  updateAgentTaskInList: (id, patch) => set((s) => ({
    agentTasks: s.agentTasks.map(t => t.id === id ? { ...t, ...patch } : t),
  })),

  setActiveTask: (id) => set({ ...INITIAL_ACTIVE_TASK, activeTaskId: id }),
  setActiveTaskStatus: (status) => set({ activeTaskStatus: status }),
  setActiveTaskPlan: (plan) => set({ activeTaskPlan: plan }),
  addActiveTaskStep: (step) => set((s) => ({
    activeTaskSteps: s.activeTaskSteps.some(st => st.step === step.step)
      ? s.activeTaskSteps
      : [...s.activeTaskSteps, step],
  })),
  updateActiveTaskStep: (stepNum, patch) => set((s) => ({
    activeTaskSteps: s.activeTaskSteps.map(st =>
      st.step === stepNum ? { ...st, ...patch } : st
    ),
  })),
  setActiveTaskQuestion: (q) => set({ activeTaskQuestion: q }),
  setActiveTaskResult: (r) => set({ activeTaskResult: r }),
  setActiveTaskError: (e) => set({ activeTaskError: e }),
  addActiveTaskArtifact: (a) => set((s) => ({
    activeTaskArtifacts: [...s.activeTaskArtifacts, a],
  })),
  addActiveTaskFileChange: (c) => set((s) => ({
    activeTaskFileChanges: s.activeTaskFileChanges.some(x => x.changeId === c.changeId)
      ? s.activeTaskFileChanges
      : [...s.activeTaskFileChanges, c].slice(-20),
  })),
  markActiveTaskFileChangeUndone: (changeId) => set((s) => ({
    activeTaskFileChanges: s.activeTaskFileChanges.map(c =>
      c.changeId === changeId ? { ...c, undone: true, canUndo: false } : c
    ),
  })),
  markActiveTaskFileChangesUndone: (changeIds) => set((s) => {
    if (changeIds.length === 0) return s;
    const setIds = new Set(changeIds);
    return {
      activeTaskFileChanges: s.activeTaskFileChanges.map(c =>
        setIds.has(c.changeId) ? { ...c, undone: true, canUndo: false } : c
      ),
    };
  }),
  markAllActiveTaskFileChangesUndone: () => set((s) => ({
    activeTaskFileChanges: s.activeTaskFileChanges.map(c =>
      c.canUndo && !c.undone ? { ...c, undone: true, canUndo: false } : c
    ),
  })),
  setActiveTaskDesign: (d) => set({ activeTaskDesign: d }),
  addActiveTaskRuntimeLog: (line) => set((s) => ({
    activeTaskRuntimeLogs: [...s.activeTaskRuntimeLogs, line].slice(-300),
  })),
  setActiveTaskRuntime: (r) => set({ activeTaskRuntime: r }),
  clearActiveTaskRuntimeLogs: () => set({ activeTaskRuntimeLogs: [] }),
  setActiveTaskExecutor: (e) => set({ activeTaskExecutor: e }),

  resetActiveTask: () => set({ ...INITIAL_ACTIVE_TASK }),
});
