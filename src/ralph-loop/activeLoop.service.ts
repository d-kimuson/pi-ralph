import type { RalphLoopOutcome, RalphLoopParams, RalphLoopState } from './ralphLoop.service.ts';

export type ActiveRalphLoop = {
  readonly params: RalphLoopParams;
  readonly state: RalphLoopState;
};

export type CreateActiveRalphLoopResult =
  | {
      readonly kind: 'configured';
      readonly activeLoop: ActiveRalphLoop;
    }
  | {
      readonly kind: 'blocked';
      readonly reason: 'already-configured';
      readonly activeLoop: ActiveRalphLoop;
    };

export const createActiveRalphLoop = (
  activeLoop: ActiveRalphLoop | undefined,
  params: RalphLoopParams,
): CreateActiveRalphLoopResult => {
  if (activeLoop !== undefined) {
    return {
      kind: 'blocked',
      reason: 'already-configured',
      activeLoop,
    };
  }

  return {
    kind: 'configured',
    activeLoop: {
      params,
      state: {
        review: {
          status: 'pending',
        },
        acceptanceCriteria: {
          status: 'pending',
        },
      },
    },
  };
};

export const updateActiveRalphLoop = (
  activeLoop: ActiveRalphLoop,
  outcome: RalphLoopOutcome,
): ActiveRalphLoop | undefined => {
  if (outcome.result.kind === 'completed') {
    return undefined;
  }

  return {
    ...activeLoop,
    state: outcome.state,
  };
};

export const advanceActiveRalphLoop = (activeLoop: ActiveRalphLoop): ActiveRalphLoop => activeLoop;

export const clearActiveRalphLoop = (_activeLoop: ActiveRalphLoop): undefined => undefined;
