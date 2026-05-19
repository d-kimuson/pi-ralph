import { describe, expect, test } from 'vitest';

import { buildCommentFixedCheckResult, findPendingCommentFixes } from './commentFixed.service.ts';

describe('findPendingCommentFixes', () => {
  test('treats the latest external review-thread comment as pending until the author replies', () => {
    const details = findPendingCommentFixes({
      repoSlug: 'owner/repo',
      pullNumber: 12,
      pullRequestAuthorLogin: 'author',
      headSha: 'abcdef1234567890',
      issueComments: [
        {
          databaseId: 1,
          url: 'https://github.com/owner/repo/pull/12#issuecomment-1',
          body: 'Looks good overall',
          authorLogin: 'reviewer-a',
          createdAt: '2026-05-20T10:00:00Z',
        },
        {
          databaseId: 2,
          url: 'https://github.com/owner/repo/pull/12#issuecomment-2',
          body: 'Fixed in follow-up',
          authorLogin: 'author',
          createdAt: '2026-05-20T10:05:00Z',
        },
      ],
      reviews: [
        {
          url: 'https://github.com/owner/repo/pull/12#pullrequestreview-1',
          body: 'Please cover the edge case.',
          authorLogin: 'reviewer-b',
          submittedAt: '2026-05-20T10:06:00Z',
        },
      ],
      reviewThreads: [
        {
          comments: [
            {
              databaseId: 10,
              url: 'https://github.com/owner/repo/pull/12#discussion_r10',
              body: 'Nit: rename this helper.',
              authorLogin: 'reviewer-c',
              createdAt: '2026-05-20T10:07:00Z',
            },
          ],
        },
        {
          comments: [
            {
              databaseId: 11,
              url: 'https://github.com/owner/repo/pull/12#discussion_r11',
              body: 'Please add a test.',
              authorLogin: 'reviewer-d',
              createdAt: '2026-05-20T10:08:00Z',
            },
            {
              databaseId: 12,
              url: 'https://github.com/owner/repo/pull/12#discussion_r12',
              body: 'Done in the next commit.',
              authorLogin: 'author',
              createdAt: '2026-05-20T10:09:00Z',
            },
          ],
        },
      ],
    });

    expect(details).toEqual({
      kind: 'comment-fixed',
      headSha: 'abcdef1234567890',
      pendingComments: [
        {
          kind: 'review',
          authorLogin: 'reviewer-b',
          url: 'https://github.com/owner/repo/pull/12#pullrequestreview-1',
          body: 'Please cover the edge case.',
          replyCommand:
            "gh pr comment 12 --body $'Replying to review: https://github.com/owner/repo/pull/12#pullrequestreview-1\\n\\nFixed in commit abcdef1234567890.\\n\\n<describe-the-fix>'",
        },
        {
          kind: 'review-thread',
          authorLogin: 'reviewer-c',
          url: 'https://github.com/owner/repo/pull/12#discussion_r10',
          body: 'Nit: rename this helper.',
          replyCommand:
            "gh api repos/owner/repo/pulls/12/comments/10/replies -X POST -f body=$'Fixed in commit abcdef1234567890.\\n\\n<describe-the-fix>'",
        },
      ],
    });
  });

  test('returns no pending comments after the author replies to issue comments and review threads', () => {
    const details = findPendingCommentFixes({
      repoSlug: 'owner/repo',
      pullNumber: 12,
      pullRequestAuthorLogin: 'author',
      headSha: 'abcdef1234567890',
      issueComments: [
        {
          databaseId: 1,
          url: 'https://github.com/owner/repo/pull/12#issuecomment-1',
          body: 'Please update the docs.',
          authorLogin: 'reviewer-a',
          createdAt: '2026-05-20T10:00:00Z',
        },
        {
          databaseId: 2,
          url: 'https://github.com/owner/repo/pull/12#issuecomment-2',
          body: 'Addressed in the latest commit.',
          authorLogin: 'author',
          createdAt: '2026-05-20T10:01:00Z',
        },
      ],
      reviews: [],
      reviewThreads: [
        {
          comments: [
            {
              databaseId: 10,
              url: 'https://github.com/owner/repo/pull/12#discussion_r10',
              body: 'Please add coverage.',
              authorLogin: 'reviewer-b',
              createdAt: '2026-05-20T10:02:00Z',
            },
            {
              databaseId: 11,
              url: 'https://github.com/owner/repo/pull/12#discussion_r11',
              body: 'Added in the latest commit.',
              authorLogin: 'author',
              createdAt: '2026-05-20T10:03:00Z',
            },
          ],
        },
      ],
    });

    expect(details.pendingComments).toEqual([]);
  });
});

describe('buildCommentFixedCheckResult', () => {
  test('fails with a readable summary when pending comments remain', () => {
    const result = buildCommentFixedCheckResult({
      kind: 'comment-fixed',
      headSha: 'abcdef1234567890',
      pendingComments: [
        {
          kind: 'issue-comment',
          authorLogin: 'reviewer-a',
          url: 'https://github.com/owner/repo/pull/12#issuecomment-1',
          body: 'Please update the docs.',
          replyCommand: 'gh pr comment 12 --body ...',
        },
      ],
    });

    expect(result).toEqual({
      command: 'comment-fixed: inspect unresolved comments',
      code: 1,
      stdout:
        '1 pending PR comment thread(s) still need a reply before merge. Latest commit: abcdef1234567890.',
      stderr: '',
    });
  });
});
