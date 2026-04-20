/**
 * Online non-max suppression with refractory gap.
 * Keeps only the highest-probability cut within a minGap window.
 */

export interface SmootherConfig {
  minGap?: number;
  threshold?: number;
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

  private pending: Candidate[] = [];
  private lastConfirmed: number = -1e9;

  constructor(config: SmootherConfig = {}) {
    this.minGap = config.minGap ?? 6;
    this.threshold = config.threshold ?? 0.5;
    this.lookahead = config.lookahead ?? Math.max(2, Math.floor(this.minGap / 2));
  }

  observe(frameNumber: number, pCut: number): SmoothedEmission[] {
    if (pCut >= this.threshold) {
      this.pending.push({ frameNumber, pCut });
    }

    const out: SmoothedEmission[] = [];
    while (this.pending.length > 0 && frameNumber - this.pending[0].frameNumber >= this.lookahead) {
      const c = this.popBestInWindow(this.pending[0].frameNumber);
      if (c && c.frameNumber - this.lastConfirmed >= this.minGap) {
        this.lastConfirmed = c.frameNumber;
        out.push({ frameNumber: c.frameNumber, confidence: c.pCut });
      }
    }
    return out;
  }

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
