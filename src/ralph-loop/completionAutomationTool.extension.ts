import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import type { RalphLoopDecision } from './ralphLoop.service.ts';

const completionAutomationToolParameters = Type.Object({
  result: Type.Union([Type.Literal('accept'), Type.Literal('reject')]),
  message: Type.Optional(Type.String({ description: 'Why the automation succeeded.' })),
  reason: Type.Optional(Type.String({ description: 'Why the automation failed.' })),
});

export const completionAutomationTool = defineTool<
  typeof completionAutomationToolParameters,
  RalphLoopDecision
>({
  name: 'completion-automation',
  label: 'Completion Automation',
  description: 'Record the final result of the current completion automation step.',
  promptSnippet:
    'Call completion-automation exactly once to accept or reject the current completion automation step.',
  promptGuidelines: [
    'You must call completion-automation exactly once before finishing.',
    'Use result=accept with a concise message when the automation succeeds.',
    'Use result=reject with a concrete reason when the automation fails.',
  ],
  executionMode: 'sequential',
  parameters: completionAutomationToolParameters,

  execute(_toolCallId, params) {
    if (params.result === 'accept') {
      if (params.message === undefined || params.reason !== undefined) {
        throw new Error('completion-automation accept requires message and forbids reason');
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
      throw new Error('completion-automation reject requires reason and forbids message');
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
  pi.registerTool(completionAutomationTool);
}
