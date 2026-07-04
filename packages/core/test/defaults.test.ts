import { describe, expect, test } from 'bun:test';
import { calculateThresholds, calculateFcode } from '../src/frame-processor';
import { SceneDetector } from '../src/detector';

// The cut decision is (thresholds, fcode) over a finite input space.
// Enumerate every cell so a defaults change can't silently shift a sibling.

describe('calculateThresholds matrix', () => {
  test('low', () => {
    expect(calculateThresholds('low')).toEqual({ intraThresh: 3000, intraThresh2: 150 });
  });
  test('medium is Xvid stock (scxvid parity)', () => {
    expect(calculateThresholds('medium')).toEqual({ intraThresh: 2000, intraThresh2: 90 });
  });
  test('high', () => {
    expect(calculateThresholds('high')).toEqual({ intraThresh: 1000, intraThresh2: 50 });
  });
  test('unknown falls back to the default (medium)', () => {
    expect(calculateThresholds('bogus' as never)).toEqual({ intraThresh: 2000, intraThresh2: 90 });
  });
});

describe('calculateFcode matrix', () => {
  test('small', () => expect(calculateFcode('small', 1920, 1080)).toBe(2));
  test('medium', () => expect(calculateFcode('medium', 1920, 1080)).toBe(4));
  test('large', () => expect(calculateFcode('large', 1920, 1080)).toBe(6));
  test('auto SD', () => expect(calculateFcode('auto', 720, 480)).toBe(3));
  test('auto HD', () => expect(calculateFcode('auto', 1920, 1080)).toBe(4));
  test('auto 4K', () => expect(calculateFcode('auto', 3840, 2160)).toBe(5));
  test('unknown falls back to the default (small)', () => {
    expect(calculateFcode('bogus' as never, 1920, 1080)).toBe(2);
  });
});

describe('SceneDetector defaults', () => {
  // Recall-first defaults measured against vapoursynth-scxvid: medium + small
  // missed zero real cuts on the labeled clip; low missed 13% of them.
  test('defaults to medium sensitivity and small search range', () => {
    const d = new SceneDetector((() => {}) as never);
    const opts = (d as never as { options: { sensitivity: string; searchRange: string } }).options;
    expect(opts.sensitivity).toBe('medium');
    expect(opts.searchRange).toBe('small');
  });
  test('explicit options are respected', () => {
    const d = new SceneDetector((() => {}) as never, { sensitivity: 'low', searchRange: 'large' });
    const opts = (d as never as { options: { sensitivity: string; searchRange: string } }).options;
    expect(opts.sensitivity).toBe('low');
    expect(opts.searchRange).toBe('large');
  });
});
