/**
 * One-time client ack: agent may run shell / install packages in the workspace.
 * Not a per-command gate — that lives in run_command for install/ci.
 */

export const SHELL_RISK_ACK_KEY = 'lia.agentShellRiskAck';

export function hasAgentShellRiskAck(): boolean {
  try {
    if (typeof window === 'undefined') return true;
    return window.localStorage?.getItem(SHELL_RISK_ACK_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAgentShellRiskAck(): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage?.setItem(SHELL_RISK_ACK_KEY, '1');
  } catch { /* ignore quota / private mode */ }
}
