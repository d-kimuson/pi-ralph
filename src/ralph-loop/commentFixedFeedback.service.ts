import type { RalphLoopMergeConditionDetails } from './ralphLoop.service.ts';

const truncateBody = (body: string): string => {
  const normalized = body.trim().replaceAll('\n', ' ');

  if (normalized.length <= 200) {
    return normalized;
  }

  return `${normalized.slice(0, 197)}...`;
};

export const buildCommentFixedFollowUp = (
  details: Pick<RalphLoopMergeConditionDetails, 'headSha' | 'pendingComments'>,
): string =>
  [
    'Pending PR comments to address before merge:',
    ...details.pendingComments.flatMap((comment, index) => [
      `${index + 1}. [${comment.kind}] @${comment.authorLogin}`,
      `   ${comment.url}`,
      `   ${truncateBody(comment.body)}`,
      '   Reply command:',
      `   ${comment.replyCommand}`,
    ]),
    `When you reply, mention commit ${details.headSha} and summarize the fix in the reply body.`,
    'After all pending comments are addressed, continue working normally and then stop; ralph-loop will retry automatically and merge once no pending comments remain.',
  ].join('\n');
