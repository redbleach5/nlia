/**
 * Compatibility re-export — prefer ui-confirm.ts for new code.
 */
export {
  beginUiConfirm as beginGitConfirm,
  beginUiConfirm,
  getPendingUiAction as getPendingGitAction,
  getPendingUiAction,
  isUiWaiting as isGitWaiting,
  isUiWaiting,
  resolveUiConfirm as resolveGitConfirm,
  resolveUiConfirm,
  cancelUiConfirm as cancelGitConfirm,
  cancelUiConfirm,
  type PendingUiAction as PendingGitAction,
  type PendingUiAction,
  type UiActionKind as GitActionKind,
  type UiActionKind,
  type UiConfirmDecision as GitConfirmDecision,
  type UiConfirmDecision,
} from "./ui-confirm.js";
