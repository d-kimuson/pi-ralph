import { describe, expect, test } from 'vitest';

import {
  advanceActiveRalphLoop,
  clearActiveRalphLoop,
  createActiveRalphLoop,
  updateActiveRalphLoop,
} from './activeLoop.service.ts';
import { createRalphLoopState } from './ralphLoop.service.ts';

describe('activeLoop.service', () => {
  const params = {
    staticChecks: ['pnpm gatecheck check'],
    completion: 'commit' as const,
    mergeCondition: 'none' as const,
    review: true,
    acceptanceCriteria: 'all requirements are met',
  };

  test('creates an active loop only once', () => {
    const first = createActiveRalphLoop(undefined, params);
    const second = createActiveRalphLoop(first.activeLoop, params);

    expect(first).toEqual({
      kind: 'configured',
      activeLoop: {
        params,
        state: createRalphLoopState(),
      },
    });
    expect(second).toEqual({
      kind: 'blocked',
      reason: 'already-configured',
      activeLoop: first.activeLoop,
    });
  });

  test('runs checks on the first agent_end after configuration', () => {
    const configured = createActiveRalphLoop(undefined, params);

    if (configured.kind !== 'configured') {
      throw new Error('expected configured');
    }

    expect(advanceActiveRalphLoop(configured.activeLoop)).toEqual(configured.activeLoop);
  });

  test('keeps the active loop after a continue result and clears it after completion or bypass', () => {
    const configured = createActiveRalphLoop(undefined, params);

    if (configured.kind !== 'configured') {
      throw new Error('expected configured');
    }

    const activeLoop = advanceActiveRalphLoop(configured.activeLoop);

    const afterContinue = updateActiveRalphLoop(activeLoop, {
      state: {
        review: {
          status: 'passed',
          message: 'review passed',
        },
        acceptanceCriteria: {
          status: 'pending',
        },
      },
      result: {
        kind: 'continue',
        reason: 'static-check-failed',
        completion: 'commit',
        mergeCondition: 'none',
        staticChecks: [],
        agentChecks: [],
        completionChecks: [],
      },
    });

    const afterCompleted = updateActiveRalphLoop(activeLoop, {
      state: createRalphLoopState(),
      result: {
        kind: 'completed',
        completion: 'commit',
        mergeCondition: 'none',
        staticChecks: [],
        agentChecks: [],
        completionChecks: [],
      },
    });

    expect(afterContinue).toEqual({
      params,
      state: {
        review: {
          status: 'passed',
          message: 'review passed',
        },
        acceptanceCriteria: {
          status: 'pending',
        },
      },
    });
    expect(afterCompleted).toBeUndefined();
    expect(clearActiveRalphLoop(activeLoop)).toBeUndefined();
  });
});
