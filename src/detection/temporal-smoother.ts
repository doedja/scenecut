/**
 * Temporal Smoother - Sliding window filter to reduce false positives
 *
 * Three rules:
 * 1. Minimum gap: Suppress detections within minConsecutive frames of each other (keep highest confidence)
 * 2. Flash suppression: Isolated single-frame detections with low confidence are suppressed
 * 3. Cluster merging: Consecutive triggered frames (common in dissolves) keep only highest-confidence one
 */

import { TemporalSmoothing } from '../types';

interface DetectionEntry {
  frameNumber: number;
  confidence: number;
}

export interface SmoothedResult {
  isSceneChange: boolean;
  confidence: number;
}

export class TemporalSmoother {
  private windowSize: number;
  private minConsecutive: number;

  // Sliding window of recent detections
  private recentDetections: DetectionEntry[] = [];

  // Last confirmed scene change frame
  private lastConfirmedFrame: number = 0;

  // Buffer for cluster detection
  private pendingCluster: DetectionEntry[] = [];
  private nonDetectionCount: number = 0;

  // Flash suppression: minimum confidence for isolated detections
  private flashConfidenceThreshold: number = 0.4;

  constructor(config: TemporalSmoothing) {
    this.windowSize = config.windowSize;
    this.minConsecutive = config.minConsecutive;
  }

  /**
   * Process a frame's detection result through temporal smoothing
   */
  process(frameNumber: number, rawIsSceneChange: boolean, rawConfidence: number): SmoothedResult {
    // If no detection, track gap and possibly flush pending cluster
    if (!rawIsSceneChange) {
      this.nonDetectionCount++;

      // If we had a pending cluster and enough non-detections have passed,
      // emit the best detection from the cluster
      if (this.pendingCluster.length > 0 && this.nonDetectionCount >= 2) {
        const best = this.flushCluster();
        if (best) {
          return best;
        }
      }

      return { isSceneChange: false, confidence: 0 };
    }

    // We have a detection
    this.nonDetectionCount = 0;

    // Rule 1: Minimum gap enforcement
    if (frameNumber - this.lastConfirmedFrame < this.minConsecutive) {
      // Too close to last confirmed scene change
      // If this has higher confidence, replace pending, but don't emit yet
      if (this.pendingCluster.length > 0) {
        const best = this.pendingCluster.reduce((a, b) => a.confidence > b.confidence ? a : b);
        if (rawConfidence > best.confidence) {
          // Replace entire cluster with this better detection
          this.pendingCluster = [{ frameNumber, confidence: rawConfidence }];
        }
      }
      return { isSceneChange: false, confidence: 0 };
    }

    // Rule 3: Cluster merging - add to pending cluster
    this.pendingCluster.push({ frameNumber, confidence: rawConfidence });

    // Don't emit immediately; wait to see if more consecutive detections follow
    return { isSceneChange: false, confidence: 0 };
  }

  /**
   * Flush the pending cluster, emitting the highest-confidence detection
   */
  private flushCluster(): SmoothedResult | null {
    if (this.pendingCluster.length === 0) {
      return null;
    }

    // Find the detection with highest confidence
    const best = this.pendingCluster.reduce((a, b) => a.confidence > b.confidence ? a : b);

    // Rule 2: Flash suppression - isolated single-frame detections with low confidence
    if (this.pendingCluster.length === 1 && best.confidence < this.flashConfidenceThreshold) {
      this.pendingCluster = [];
      return null;
    }

    // Confirm this detection
    this.lastConfirmedFrame = best.frameNumber;
    this.recentDetections.push(best);

    // Keep sliding window bounded
    while (this.recentDetections.length > this.windowSize) {
      this.recentDetections.shift();
    }

    this.pendingCluster = [];

    return {
      isSceneChange: true,
      confidence: best.confidence
    };
  }
}
