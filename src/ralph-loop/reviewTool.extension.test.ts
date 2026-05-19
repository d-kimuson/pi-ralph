import { describe, expect, test } from 'vitest';

import { reviewTool } from './reviewTool.extension.ts';

describe('reviewTool', () => {
  test('uses an object schema at the top level for provider compatibility', () => {
    expect(JSON.stringify(reviewTool.parameters)).toContain('"type":"object"');
  });
});
