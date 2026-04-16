/**
 * Scene Smoother — online non-max suppression with refractory gap.
 *
 * Given a stream of (frame, p_cut) observations, emits a subset as confirmed
 * scene changes. Rules, applied simultaneously:
 *
 *   1. p_cut must exceed a decision threshold (default 0.5 — the sigmoid
 *      midpoint, meaning rawScore >= intraThresh2).
 *   2. Confirmed cuts cannot be closer than `minGap` frames apart. Within a
 *      refractory window, only the highest-probability candidate wins.
 *   3. NMS is applied online with a small lookahead (half the window) so a
 *      stronger candidate a few frames later can override an earlier one.
 *
 * This replaces ad-hoc "flash suppression" and "cluster merging" heuristics
 * with a single principled rule: within any minGap window, keep the max.
 */

export interface SmootherConfig {
  /** Minimum frame gap between confirmed cuts (default: 6 frames ~ 0.25s @ 24fps) */
  minGap?: number;
  /** Decision threshold on p_cut ∈ [0,1] (default: 0.5) */
  threshold?: number;
  /** Lookahead in frames for NMS (default: minGap / 2) */
  lookahead?: number;
}

export interface Candidate {
  frameNumber: number;
  pCut: number;
}

export interface SmoothedEmission {
  frameNumber: number;
  confidence: number;
}

export class SceneSmoother {
  private minGap: number;
  private threshold: number;
  private lookahead: number;

  /** Candidates awaiting NMS decision. Sorted ascending by frameNumber. */
  private pending: Candidate[] = [];
  /** Last confirmed cut frame (−∞ initially). */
  private lastConfirmed: number = -1e9;

  constructor(config: SmootherConfig = {}) {
    this.minGap = config.minGap ?? 6;
    this.threshold = config.threshold ?? 0.5;
    this.lookahead = config.lookahead ?? Math.max(2, Math.floor(this.minGap / 2));
  }

  /**
   * Feed an observation. Returns any cut(s) that can now be confirmed —
   * usually 0 or 1. Cut i is confirmed once frame i+lookahead has been seen.
   */
  observe(frameNumber: number, pCut: number): SmoothedEmission[] {
    if (pCut >= this.threshold) {
      this.pending.push({ frameNumber, pCut });
    }

    const out: SmoothedEmission[] = [];
    // A pending candidate at frame f is safe to decide once we have seen
    // frame f + lookahead: no stronger candidate can arrive within its NMS window.
    while (this.pending.length > 0 && frameNumber - this.pending[0].frameNumber >= this.lookahead) {
      const c = this.popBestInWindow(this.pending[0].frameNumber);
      if (c && c.frameNumber - this.lastConfirmed >= this.minGap) {
        this.lastConfirmed = c.frameNumber;
        out.push({ frameNumber: c.frameNumber, confidence: c.pCut });
      }
    }
    return out;
  }

  /**
   * Flush remaining pending candidates at end-of-stream.
   */
  flush(): SmoothedEmission[] {
    const out: SmoothedEmission[] = [];
    while (this.pending.length > 0) {
      const first = this.pending[0].frameNumber;
      const c = this.popBestInWindow(first);
      if (c && c.frameNumber - this.lastConfirmed >= this.minGap) {
        this.lastConfirmed = c.frameNumber;
        out.push({ frameNumber: c.frameNumber, confidence: c.pCut });
      }
    }
    return out;
  }

  /**
   * Given the earliest pending frame f, pick the highest-probability
   * candidate in [f, f + minGap) and drop all others in that window.
   */
  private popBestInWindow(anchor: number): Candidate | null {
    let best: Candidate | null = null;
    let bestIdx = -1;
    let cutoffIdx = this.pending.length;
    for (let i = 0; i < this.pending.length; i++) {
      const c = this.pending[i];
      if (c.frameNumber - anchor >= this.minGap) { cutoffIdx = i; break; }
      if (!best || c.pCut > best.pCut) { best = c; bestIdx = i; }
    }
    if (bestIdx < 0) {
      this.pending.splice(0, cutoffIdx);
      return null;
    }
    this.pending.splice(0, cutoffIdx);
    return best;
  }
}
