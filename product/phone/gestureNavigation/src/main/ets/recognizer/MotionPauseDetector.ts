//@ts-nocheck
/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0.
 *
 * Loose port of Quickstep's MotionPauseDetector
 * (packages/apps/Launcher3/quickstep/src/com/android/quickstep/util/
 * MotionPauseDetector.java).
 *
 * Goal: detect that an in-flight upward swipe has *decelerated and held*
 * for long enough to commit to the Overview / Recents target. Without
 * this detector, a slow swipe-and-hold reads identically to a slow
 * swipe-and-release at end of stroke; with it, the user can hover and
 * latch on Recents the way Quickstep does on Android.
 *
 * Thresholds (Quickstep dimens, dp/ms ↔ vp/ms):
 *   motion_pause_detector_speed_slow       = 0.15  dp/ms = 150 vp/s
 *   motion_pause_detector_speed_very_slow  = 0.0285 dp/ms = 28.5 vp/s
 *   force-pause timeout                    = 300   ms
 *   min displacement before pause allowed  = 36    dp (vp)
 */

export interface MotionPauseConfig {
  slowVpPerMs: number;       // pause candidate enters this band
  verySlowVpPerMs: number;   // forced pause after timeout
  pauseTimeoutMs: number;    // continuous time in slow band → pause
  minDisplacementVp: number; // require this much travel first
}

export const DEFAULT_MOTION_PAUSE_CONFIG: MotionPauseConfig = {
  slowVpPerMs: 0.15,
  verySlowVpPerMs: 0.0285,
  pauseTimeoutMs: 300,
  minDisplacementVp: 36,
};

export class MotionPauseDetector {
  private cfg: MotionPauseConfig;
  private slowEnteredAt: number = -1;
  private paused: boolean = false;
  private maxDisplacementVp: number = 0;

  constructor(cfg: MotionPauseConfig = DEFAULT_MOTION_PAUSE_CONFIG) {
    this.cfg = cfg;
  }

  reset(): void {
    this.slowEnteredAt = -1;
    this.paused = false;
    this.maxDisplacementVp = 0;
  }

  /**
   * Feed the latest speed and displacement.
   *
   * @param timeMs        monotonic ms timestamp.
   * @param speedVpPerMs  current speed (absolute value).
   * @param displaceVp    current upward displacement from gesture start
   *                      (positive when moving away from the bottom edge).
   * @returns true when the pause state flipped on this call.
   */
  addPosition(timeMs: number, speedVpPerMs: number, displaceVp: number): boolean {
    const absSpeed = Math.abs(speedVpPerMs);
    if (displaceVp > this.maxDisplacementVp) this.maxDisplacementVp = displaceVp;

    // Pause is only meaningful after the user has actually committed to a
    // swipe upward — guards against false positives from the slop region.
    if (this.maxDisplacementVp < this.cfg.minDisplacementVp) {
      this.slowEnteredAt = -1;
      return false;
    }

    const wasPaused = this.paused;
    if (absSpeed <= this.cfg.verySlowVpPerMs) {
      // Effectively stopped — instant pause regardless of timer.
      this.paused = true;
    } else if (absSpeed <= this.cfg.slowVpPerMs) {
      if (this.slowEnteredAt < 0) {
        this.slowEnteredAt = timeMs;
      } else if (!this.paused && timeMs - this.slowEnteredAt >= this.cfg.pauseTimeoutMs) {
        this.paused = true;
      }
    } else {
      // Faster than slow band — reset the candidacy timer and (sticky)
      // do NOT un-pause: once Quickstep latches on Overview it stays
      // latched even if the user wiggles, so we mirror that.
      this.slowEnteredAt = -1;
    }
    return this.paused !== wasPaused;
  }

  isPaused(): boolean {
    return this.paused;
  }
}
