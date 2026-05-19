import { describe, expect, test } from 'vitest';

import { buildCommentFixedFollowUp } from './commentFixedFeedback.service.ts';

describe('buildCommentFixedFollowUp', () => {
  test('lists pending comments and reply commands with the commit hash guidance', () => {
    const content = buildCommentFixedFollowUp({
      headSha: 'abcdef1234567890',
      pendingComments: [
        {
          kind: 'review-thread',
          authorLogin: 'reviewer-a',
          url: 'https://github.com/owner/repo/pull/12#discussion_r10',
          body: 'Nit: rename this helper.',
          replyCommand:
            "gh api repos/owner/repo/pulls/12/comments/10/replies -X POST -f body=$'Fixed in commit abcdef1234567890.\\n\\n<describe-the-fix>'",
        },
      ],
    });

    expect(content).toContain('Pending PR comments to address before merge:');
    expect(content).toContain('@reviewer-a');
    expect(content).toContain('Nit: rename this helper.');
    expect(content).toContain('gh api repos/owner/repo/pulls/12/comments/10/replies');
    expect(content).toContain('When you reply, mention commit abcdef1234567890');
  });
});
