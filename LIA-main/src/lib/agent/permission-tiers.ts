/**
 * Permission tiers for agent tools (P4) — ask vs auto write/shell/network.
 * Orthogonal to WorkspaceMode (read/explore/edit).
 */

export type PermissionTier = 'read' | 'explore' | 'edit-ask' | 'edit-auto';

export type AgentApplyMode = 'ask' | 'auto';

export function resolvePermissionTier(
  workspaceMode: 'read' | 'explore' | 'edit',
  applyMode: AgentApplyMode,
): PermissionTier {
  if (workspaceMode === 'read') return 'read';
  if (workspaceMode === 'explore') return 'explore';
  return applyMode === 'auto' ? 'edit-auto' : 'edit-ask';
}

export type NetworkPolicy = {
  allowedMethods: readonly string[];
  allowedPorts: readonly number[];
  requirePermissionForPost: boolean;
};

export function networkPolicyForTier(tier: PermissionTier): NetworkPolicy {
  if (tier === 'read') {
    return {
      allowedMethods: ['GET', 'HEAD'],
      allowedPorts: [80, 443],
      requirePermissionForPost: true,
    };
  }
  if (tier === 'explore' || tier === 'edit-ask') {
    return {
      allowedMethods: ['GET', 'HEAD'],
      allowedPorts: [80, 443],
      requirePermissionForPost: true,
    };
  }
  // edit-auto: still GET/HEAD by default; POST needs explicit allow later
  return {
    allowedMethods: ['GET', 'HEAD'],
    allowedPorts: [80, 443, 8080, 3000],
    requirePermissionForPost: true,
  };
}

export function shellNeedsPermission(tier: PermissionTier): boolean {
  return tier === 'edit-ask';
}

export function writesAreGated(tier: PermissionTier): boolean {
  return tier === 'edit-ask';
}
