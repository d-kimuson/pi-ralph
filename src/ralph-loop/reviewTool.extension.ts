import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import type { RalphLoopReviewDecision } from './ralphLoop.service.ts';

const reviewToolParameters = Type.Object({
  result: Type.Union([Type.Literal('accept'), Type.Literal('reject')]),
  message: Type.Optional(Type.String({ description: 'Why the check passed.' })),
  reason: Type.Optional(Type.String({ description: 'Why the check failed.' })),
});

export const reviewTool = defineTool<typeof reviewToolParameters, RalphLoopReviewDecision>({
  name: 'review',
  label: 'Review',
  description: 'Record the final review decision for the current check.',
  promptSnippet: 'Call review exactly once to accept or reject the current check.',
  promptGuidelines: [
    'You must call review exactly once before finishing.',
    'Use result=accept with a concise message when the check passes.',
    'Use result=reject with a concrete reason when the check fails.',
  ],
  executionMode: 'sequential',
  parameters: reviewToolParameters,

  execute(_toolCallId, params) {
    if (params.result === 'accept') {
      if (params.message === undefined || params.reason !== undefined) {
        throw new Error('review accept requires message and forbids reason');
      }

      return Promise.resolve({
        content: [
          {
            type: 'text',
            text: `Accepted: ${params.message}`,
          },
        ],
        details: {
          result: 'accept',
          message: params.message,
        },
        terminate: true,
      });
    }

    if (params.reason === undefined || params.message !== undefined) {
      throw new Error('review reject requires reason and forbids message');
    }

    return Promise.resolve({
      content: [
        {
          type: 'text',
          text: `Rejected: ${params.reason}`,
        },
      ],
      details: {
        result: 'reject',
        reason: params.reason,
      },
      terminate: true,
    });
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(reviewTool);
}
