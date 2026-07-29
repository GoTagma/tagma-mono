import { describe, expect, test } from 'bun:test';
import {
  isUserInitiatedDetailsToggle,
  shouldScrollExpandedDetails,
} from '../src/components/chat/MessageBubble';

describe('chat message details scrolling', () => {
  test('ignores programmatic expansion from streaming and default-open content', () => {
    expect(isUserInitiatedDetailsToggle(false)).toBe(false);
    expect(shouldScrollExpandedDetails(true, false)).toBe(false);
  });

  test('scrolls only after a trusted user expansion', () => {
    expect(isUserInitiatedDetailsToggle(true)).toBe(true);
    expect(shouldScrollExpandedDetails(true, true)).toBe(true);
    expect(shouldScrollExpandedDetails(false, true)).toBe(false);
  });
});
