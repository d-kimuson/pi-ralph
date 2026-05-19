import type {
  RalphLoopCommandResult,
  RalphLoopExecutor,
  RalphLoopMergeConditionDetails,
  RalphLoopPendingComment,
} from './ralphLoop.service.ts';

export type CommentFixedIssueComment = {
  readonly databaseId: number;
  readonly url: string;
  readonly body: string;
  readonly authorLogin: string;
  readonly createdAt: string;
};

export type CommentFixedReview = {
  readonly url: string;
  readonly body: string;
  readonly authorLogin: string;
  readonly submittedAt: string;
};

export type CommentFixedReviewThreadComment = {
  readonly databaseId: number;
  readonly url: string;
  readonly body: string;
  readonly authorLogin: string;
  readonly createdAt: string;
};

export type CommentFixedReviewThread = {
  readonly comments: readonly CommentFixedReviewThreadComment[];
};

export type CommentFixedSnapshot = {
  readonly repoSlug: string;
  readonly pullNumber: number;
  readonly pullRequestAuthorLogin: string;
  readonly headSha: string;
  readonly issueComments: readonly CommentFixedIssueComment[];
  readonly reviews: readonly CommentFixedReview[];
  readonly reviewThreads: readonly CommentFixedReviewThread[];
};

const COMMENT_FIXED_INSPECT_COMMAND = 'comment-fixed: inspect unresolved comments';
const REPO_SLUG_COMMAND = 'gh repo view --json nameWithOwner';
const PR_METADATA_COMMAND = 'gh pr view --json number,author';
const HEAD_SHA_COMMAND = 'git rev-parse HEAD';

const escapeForDollarSingleQuoted = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");

const createIssueCommentReplyCommand = (
  pullNumber: number,
  targetUrl: string,
  headSha: string,
): string =>
  `gh pr comment ${pullNumber} --body $'Replying to review: ${escapeForDollarSingleQuoted(targetUrl)}\\n\\nFixed in commit ${escapeForDollarSingleQuoted(headSha)}.\\n\\n<describe-the-fix>'`;

const createReviewThreadReplyCommand = (
  repoSlug: string,
  pullNumber: number,
  commentId: number,
  headSha: string,
): string =>
  `gh api repos/${repoSlug}/pulls/${pullNumber}/comments/${commentId}/replies -X POST -f body=$'Fixed in commit ${escapeForDollarSingleQuoted(headSha)}.\\n\\n<describe-the-fix>'`;

const createPendingComment = (
  pendingComment: Omit<RalphLoopPendingComment, 'replyCommand'> & {
    readonly repoSlug: string;
    readonly pullNumber: number;
    readonly headSha: string;
    readonly commentId?: number;
  },
): RalphLoopPendingComment => ({
  kind: pendingComment.kind,
  authorLogin: pendingComment.authorLogin,
  url: pendingComment.url,
  body: pendingComment.body,
  replyCommand:
    pendingComment.kind === 'review-thread' && pendingComment.commentId !== undefined
      ? createReviewThreadReplyCommand(
          pendingComment.repoSlug,
          pendingComment.pullNumber,
          pendingComment.commentId,
          pendingComment.headSha,
        )
      : createIssueCommentReplyCommand(
          pendingComment.pullNumber,
          pendingComment.url,
          pendingComment.headSha,
        ),
});

const toTime = (value: string): number => new Date(value).getTime();

export const findPendingCommentFixes = (
  snapshot: CommentFixedSnapshot,
): RalphLoopMergeConditionDetails => {
  const lastAuthorIssueReplyTime = Math.max(
    -Infinity,
    ...snapshot.issueComments
      .filter((comment) => comment.authorLogin === snapshot.pullRequestAuthorLogin)
      .map((comment) => toTime(comment.createdAt)),
  );

  const pendingIssueComments = snapshot.issueComments
    .filter(
      (comment) =>
        comment.authorLogin !== snapshot.pullRequestAuthorLogin &&
        toTime(comment.createdAt) > lastAuthorIssueReplyTime,
    )
    .map((comment) =>
      createPendingComment({
        kind: 'issue-comment',
        authorLogin: comment.authorLogin,
        url: comment.url,
        body: comment.body,
        repoSlug: snapshot.repoSlug,
        pullNumber: snapshot.pullNumber,
        headSha: snapshot.headSha,
      }),
    );

  const pendingReviews = snapshot.reviews
    .filter(
      (review) =>
        review.authorLogin !== snapshot.pullRequestAuthorLogin &&
        review.body.trim() !== '' &&
        toTime(review.submittedAt) > lastAuthorIssueReplyTime,
    )
    .map((review) =>
      createPendingComment({
        kind: 'review',
        authorLogin: review.authorLogin,
        url: review.url,
        body: review.body,
        repoSlug: snapshot.repoSlug,
        pullNumber: snapshot.pullNumber,
        headSha: snapshot.headSha,
      }),
    );

  const pendingReviewThreads = snapshot.reviewThreads
    .flatMap((thread) => thread.comments.at(-1))
    .filter(
      (comment): comment is CommentFixedReviewThreadComment =>
        comment !== undefined && comment.authorLogin !== snapshot.pullRequestAuthorLogin,
    )
    .map((comment) =>
      createPendingComment({
        kind: 'review-thread',
        authorLogin: comment.authorLogin,
        url: comment.url,
        body: comment.body,
        repoSlug: snapshot.repoSlug,
        pullNumber: snapshot.pullNumber,
        headSha: snapshot.headSha,
        commentId: comment.databaseId,
      }),
    );

  return {
    kind: 'comment-fixed',
    headSha: snapshot.headSha,
    pendingComments: [...pendingIssueComments, ...pendingReviews, ...pendingReviewThreads],
  };
};

export const buildCommentFixedCheckResult = (
  details: RalphLoopMergeConditionDetails,
): RalphLoopCommandResult => ({
  command: COMMENT_FIXED_INSPECT_COMMAND,
  code: details.pendingComments.length === 0 ? 0 : 1,
  stdout:
    details.pendingComments.length === 0
      ? `No pending PR comments remain. Latest commit: ${details.headSha}.`
      : `${details.pendingComments.length} pending PR comment thread(s) still need a reply before merge. Latest commit: ${details.headSha}.`,
  stderr: '',
});

const splitRepoSlug = (repoSlug: string): { readonly owner: string; readonly name: string } => {
  const [owner, name] = repoSlug.split('/');

  if (owner === undefined || name === undefined || owner === '' || name === '') {
    throw new Error(`Invalid repository slug: ${repoSlug}`);
  }

  return { owner, name };
};

const COMMENT_FIXED_GRAPHQL_QUERY =
  'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { comments(first: 100) { nodes { databaseId url body createdAt author { login } } } reviews(first: 100) { nodes { url body submittedAt author { login } } } reviewThreads(first: 100) { nodes { comments(first: 100) { nodes { databaseId url body createdAt author { login } } } } } } } }';

const createGraphQlCommand = (repoSlug: string, pullNumber: number): string => {
  const { owner, name } = splitRepoSlug(repoSlug);

  return [
    'gh api graphql',
    `-F owner=${owner}`,
    `-F name=${name}`,
    `-F number=${pullNumber}`,
    `-f query=$'${COMMENT_FIXED_GRAPHQL_QUERY}'`,
  ].join(' ');
};

const parseJson = (value: string): unknown => JSON.parse(value);

const asObject = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  return Object.fromEntries(Object.entries(value));
};

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const readString = (object: Record<string, unknown>, key: string): string | undefined =>
  typeof object[key] === 'string' ? object[key] : undefined;

const readNumber = (object: Record<string, unknown>, key: string): number | undefined =>
  typeof object[key] === 'number' ? object[key] : undefined;

const readObject = (
  object: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => asObject(object[key]);

const parseRepoSlug = (result: RalphLoopCommandResult): string => {
  const parsed = asObject(parseJson(result.stdout));
  const nameWithOwner = parsed === undefined ? undefined : readString(parsed, 'nameWithOwner');

  if (nameWithOwner === undefined || nameWithOwner === '') {
    throw new Error('GitHub repository slug was missing from gh repo view output.');
  }

  return nameWithOwner;
};

const parsePullRequestMetadata = (
  result: RalphLoopCommandResult,
): {
  readonly number: number;
  readonly authorLogin: string;
} => {
  const parsed = asObject(parseJson(result.stdout));
  const author = parsed === undefined ? undefined : readObject(parsed, 'author');
  const number = parsed === undefined ? undefined : readNumber(parsed, 'number');
  const authorLogin = author === undefined ? undefined : readString(author, 'login');

  if (number === undefined || authorLogin === undefined) {
    throw new Error('Pull request metadata was missing from gh pr view output.');
  }

  return {
    number,
    authorLogin,
  };
};

const parseGraphQlSnapshot = (
  repoSlug: string,
  pullNumber: number,
  pullRequestAuthorLogin: string,
  headSha: string,
  result: RalphLoopCommandResult,
): CommentFixedSnapshot => {
  const parsed = asObject(parseJson(result.stdout));
  const data = parsed === undefined ? undefined : readObject(parsed, 'data');
  const repository = data === undefined ? undefined : readObject(data, 'repository');
  const pullRequest = repository === undefined ? undefined : readObject(repository, 'pullRequest');

  if (pullRequest === undefined) {
    throw new Error('Pull request comments were missing from gh api graphql output.');
  }

  const issueComments = asArray(readObject(pullRequest, 'comments')?.['nodes']).flatMap(
    (comment) => {
      const object = asObject(comment);
      const author = object === undefined ? undefined : readObject(object, 'author');
      const databaseId = object === undefined ? undefined : readNumber(object, 'databaseId');
      const url = object === undefined ? undefined : readString(object, 'url');
      const body = object === undefined ? undefined : readString(object, 'body');
      const createdAt = object === undefined ? undefined : readString(object, 'createdAt');
      const authorLogin = author === undefined ? undefined : readString(author, 'login');

      if (
        databaseId === undefined ||
        url === undefined ||
        body === undefined ||
        createdAt === undefined ||
        authorLogin === undefined
      ) {
        return [];
      }

      return [
        {
          databaseId,
          url,
          body,
          authorLogin,
          createdAt,
        },
      ];
    },
  );

  const reviews = asArray(readObject(pullRequest, 'reviews')?.['nodes']).flatMap((review) => {
    const object = asObject(review);
    const author = object === undefined ? undefined : readObject(object, 'author');
    const url = object === undefined ? undefined : readString(object, 'url');
    const body = object === undefined ? undefined : readString(object, 'body');
    const submittedAt = object === undefined ? undefined : readString(object, 'submittedAt');
    const authorLogin = author === undefined ? undefined : readString(author, 'login');

    if (
      url === undefined ||
      body === undefined ||
      submittedAt === undefined ||
      authorLogin === undefined
    ) {
      return [];
    }

    return [
      {
        url,
        body,
        authorLogin,
        submittedAt,
      },
    ];
  });

  const reviewThreads = asArray(readObject(pullRequest, 'reviewThreads')?.['nodes']).map(
    (thread) => {
      const threadObject = asObject(thread);
      const comments = asArray(readObject(threadObject ?? {}, 'comments')?.['nodes']).flatMap(
        (comment) => {
          const object = asObject(comment);
          const author = object === undefined ? undefined : readObject(object, 'author');
          const databaseId = object === undefined ? undefined : readNumber(object, 'databaseId');
          const url = object === undefined ? undefined : readString(object, 'url');
          const body = object === undefined ? undefined : readString(object, 'body');
          const createdAt = object === undefined ? undefined : readString(object, 'createdAt');
          const authorLogin = author === undefined ? undefined : readString(author, 'login');

          if (
            databaseId === undefined ||
            url === undefined ||
            body === undefined ||
            createdAt === undefined ||
            authorLogin === undefined
          ) {
            return [];
          }

          return [
            {
              databaseId,
              url,
              body,
              authorLogin,
              createdAt,
            },
          ];
        },
      );

      return {
        comments,
      };
    },
  );

  return {
    repoSlug,
    pullNumber,
    pullRequestAuthorLogin,
    headSha,
    issueComments,
    reviews,
    reviewThreads,
  };
};

export const runCommentFixedCheck = async (
  execute: RalphLoopExecutor,
): Promise<{
  readonly results: readonly RalphLoopCommandResult[];
  readonly details: RalphLoopMergeConditionDetails;
}> => {
  const repoResult = await execute(REPO_SLUG_COMMAND);

  if (repoResult.code !== 0) {
    return {
      results: [repoResult],
      details: {
        kind: 'comment-fixed',
        headSha: '',
        pendingComments: [],
      },
    };
  }

  const repoSlug = parseRepoSlug(repoResult);
  const prMetadataResult = await execute(PR_METADATA_COMMAND);

  if (prMetadataResult.code !== 0) {
    return {
      results: [repoResult, prMetadataResult],
      details: {
        kind: 'comment-fixed',
        headSha: '',
        pendingComments: [],
      },
    };
  }

  const prMetadata = parsePullRequestMetadata(prMetadataResult);
  const headShaResult = await execute(HEAD_SHA_COMMAND);

  if (headShaResult.code !== 0) {
    return {
      results: [repoResult, prMetadataResult, headShaResult],
      details: {
        kind: 'comment-fixed',
        headSha: '',
        pendingComments: [],
      },
    };
  }

  const graphQlResult = await execute(createGraphQlCommand(repoSlug, prMetadata.number));

  if (graphQlResult.code !== 0) {
    return {
      results: [repoResult, prMetadataResult, headShaResult, graphQlResult],
      details: {
        kind: 'comment-fixed',
        headSha: headShaResult.stdout.trim(),
        pendingComments: [],
      },
    };
  }

  const details = findPendingCommentFixes(
    parseGraphQlSnapshot(
      repoSlug,
      prMetadata.number,
      prMetadata.authorLogin,
      headShaResult.stdout.trim(),
      graphQlResult,
    ),
  );

  return {
    results: [
      repoResult,
      prMetadataResult,
      headShaResult,
      graphQlResult,
      buildCommentFixedCheckResult(details),
    ],
    details,
  };
};
