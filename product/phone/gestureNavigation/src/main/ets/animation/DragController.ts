//@ts-nocheck
/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0.
 *
 * Per-frame transform driver for the drag overlay.
 *
 * Takes incremental onProgress events from SwipeRecognizer and writes
 * the six transform values into AppStorage. DragOverlay.ets subscribes
 * via @StorageLink and re-renders on each change. The mapping mirrors
 * AOSP Launcher3 SwipeUpAnimationLogic + TaskViewSimulator's per-frame
 * scale/translate/alpha/cornerRadius cascade, scaled 1:1 vp ↔ dp:
 *
 *   progress      = min(deltaVp / dragLengthVp, 1)
 *   overlay.x     = (fingerXPx - screenW/2) * 0.35    // damped horiz
 *   overlay.y     = fingerYPx - (screenH * scale / 2)
 *   scale         = lerp(1.0, 0.45, progress)
 *   alpha         = progress < 0.25
 *                     ? 1.0
 *                     : lerp(1.0, 0.85, (progress - 0.25) / 0.75)
 *   radius_vp     = lerp(0, 24, progress)
 *   backdropAlpha = lerp(0, 0.55, progress)
 *
 * dragLengthVp is sized as 75 % of screen height in vp — AOSP uses
 * mTransitionDragLength which scales with rotation/insets; the
 * simplification is good enough for a single-rotation phone shell.
 */

import Log from '../../../../../../../common/src/main/ets/default/Log';
import { GestureEndTarget } from '../recognizer/SwipeRecognizer';

const TAG = 'GestureNavigation_DragController';

// Commit-spring duration in ms. ArkUI's springMotion curve is
// over-damped here (0.34, 0.82) so settle happens within ~250 ms;
// 320 ms gives a small safety margin before the structural commit
// (goHome / openRecents) fires.
export const COMMIT_SPRING_MS = 320;

export const APP_KEY_DRAG_VISIBLE = 'OniroDragVisible';
export const APP_KEY_DRAG_X = 'OniroDragX';
export const APP_KEY_DRAG_Y = 'OniroDragY';
export const APP_KEY_DRAG_SCALE = 'OniroDragScale';
export const APP_KEY_DRAG_ALPHA = 'OniroDragAlpha';
export const APP_KEY_DRAG_RADIUS = 'OniroDragRadius';
export const APP_KEY_DRAG_BACKDROP_ALPHA = 'OniroDragBackdropAlpha';

const MIN_SCALE = 0.45;
const MAX_RADIUS_VP = 24;
const ALPHA_HOLD_FRAC = 0.25;
const ALPHA_FLOOR = 0.85;
// Backdrop is held at full opacity (1.0) once the overlay shows so
// the live foreground app behind it isn't visible while the snapshot
// shrinks. AOSP shows the wallpaper here; we use solid black until
// a wallpaper-PixelMap source is wired up.
const HORIZ_DAMPING = 0.35;
const DRAG_LENGTH_FRACTION = 0.75;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export interface DragControllerConfig {
  vpToPx: number;
  screenWidthPx: number;
  screenHeightPx: number;
}

export class DragController {
  private cfg: DragControllerConfig;
  private dragLengthVp: number;
  private screenWidthVp: number;
  private screenHeightVp: number;
  private tickCount = 0;

  constructor(cfg: DragControllerConfig) {
    this.cfg = cfg;
    this.screenHeightVp = cfg.screenHeightPx / cfg.vpToPx;
    this.screenWidthVp = cfg.screenWidthPx / cfg.vpToPx;
    this.dragLengthVp = this.screenHeightVp * DRAG_LENGTH_FRACTION;
  }

  /**
   * Called when the recognizer crosses slop and starts tracking.
   * Resets all transform values to their fullscreen state so the first
   * onProgress sees a clean baseline.
   */
  start(): void {
    this.tickCount = 0;
    AppStorage.SetOrCreate(APP_KEY_DRAG_X, 0);
    AppStorage.SetOrCreate(APP_KEY_DRAG_Y, 0);
    AppStorage.SetOrCreate(APP_KEY_DRAG_SCALE, 1.0);
    AppStorage.SetOrCreate(APP_KEY_DRAG_ALPHA, 1.0);
    AppStorage.SetOrCreate(APP_KEY_DRAG_RADIUS, 0);
    // Backdrop opens at full opacity. While the snapshot is at
    // scale=1 it hides the backdrop entirely; as the snapshot
    // shrinks the backdrop becomes the visible "behind" — opaque
    // black, not the live foreground app.
    AppStorage.SetOrCreate(APP_KEY_DRAG_BACKDROP_ALPHA, 1.0);
    AppStorage.SetOrCreate(APP_KEY_DRAG_VISIBLE, true);
  }

  /**
   * Called for every onProgress tick. Computes the six transform
   * values and writes them into AppStorage in a single batch so the
   * reactive layer only redraws once.
   */
  onProgress(displacementVp: number, lastXPx: number, lastYPx: number): void {
    const progress = Math.min(displacementVp / this.dragLengthVp, 1);
    const scale = lerp(1.0, MIN_SCALE, progress);

    // Translate: damped horizontal drift, vertical centred on finger.
    const centerXVp = this.screenWidthVp / 2;
    const fingerXVp = lastXPx / this.cfg.vpToPx;
    const fingerYVp = lastYPx / this.cfg.vpToPx;
    const x = (fingerXVp - centerXVp) * HORIZ_DAMPING;
    const y = fingerYVp - (this.screenHeightVp * scale / 2);

    const alpha = progress < ALPHA_HOLD_FRAC
      ? 1.0
      : lerp(1.0, ALPHA_FLOOR, (progress - ALPHA_HOLD_FRAC) / (1 - ALPHA_HOLD_FRAC));
    const radius = lerp(0, MAX_RADIUS_VP, progress);
    // Backdrop is held opaque from start() — no per-tick update.

    AppStorage.SetOrCreate(APP_KEY_DRAG_X, x);
    AppStorage.SetOrCreate(APP_KEY_DRAG_Y, y);
    AppStorage.SetOrCreate(APP_KEY_DRAG_SCALE, scale);
    AppStorage.SetOrCreate(APP_KEY_DRAG_ALPHA, alpha);
    AppStorage.SetOrCreate(APP_KEY_DRAG_RADIUS, radius);

    this.tickCount++;
    if (this.tickCount % 8 === 0) {
      Log.showDebug(TAG,
        `tick=${this.tickCount} prog=${progress.toFixed(2)} ` +
        `scale=${scale.toFixed(2)} alpha=${alpha.toFixed(2)} ` +
        `radius=${radius.toFixed(1)}vp`);
    }
  }

  /**
   * Commit-time spring: write the END transform values for the
   * decided target. The DragOverlay page's `.animation()` modifier
   * runs the actual spring physics in the render thread. Once the
   * spring settles (COMMIT_SPRING_MS later) onComplete fires so the
   * caller can do the structural commit (goHome / openRecents) and
   * tear the overlay down.
   *
   *   HOME    → centre-bottom, scale 0.12, alpha 0
   *   RECENTS → top-third of screen, scale 0.65, alpha 1
   *   CANCEL  → snap back to scale 1, alpha 1, x=0, y=0, radius 0
   */
  commit(target: GestureEndTarget, onComplete: () => void): void {
    let endX = 0;
    let endY = 0;
    let endScale = 1.0;
    let endAlpha = 1.0;
    let endRadius = 0;
    let endBackdropAlpha = 0;
    if (target === GestureEndTarget.HOME) {
      // App dissolves to nothing in the centre; backdrop fades to
      // reveal the launcher that's about to be brought forward.
      endScale = 0.12;
      endAlpha = 0;
      endY = 0;
      endRadius = MAX_RADIUS_VP;
      endBackdropAlpha = 0;
    } else if (target === GestureEndTarget.RECENTS) {
      // App shrinks to a thumbnail-sized card in the centre and
      // stays put with full opacity. The backdrop stays opaque so
      // OniroRecentsOverlay can fade in over it without revealing
      // the live foreground.
      endScale = 0.65;
      endAlpha = 1.0;
      endY = 0;
      endRadius = MAX_RADIUS_VP;
      endBackdropAlpha = 1.0;
    } else {
      // CANCEL → snap back to fullscreen with overshoot from spring.
      endScale = 1.0;
      endAlpha = 1.0;
      endX = 0;
      endY = 0;
      endRadius = 0;
      endBackdropAlpha = 0;
    }
    Log.showInfo(TAG,
      `commit-spring target=${GestureEndTarget[target]} ` +
      `endScale=${endScale} endAlpha=${endAlpha} endY=${endY.toFixed(1)}vp`);
    AppStorage.SetOrCreate(APP_KEY_DRAG_X, endX);
    AppStorage.SetOrCreate(APP_KEY_DRAG_Y, endY);
    AppStorage.SetOrCreate(APP_KEY_DRAG_SCALE, endScale);
    AppStorage.SetOrCreate(APP_KEY_DRAG_ALPHA, endAlpha);
    AppStorage.SetOrCreate(APP_KEY_DRAG_RADIUS, endRadius);
    AppStorage.SetOrCreate(APP_KEY_DRAG_BACKDROP_ALPHA, endBackdropAlpha);
    setTimeout(() => {
      onComplete();
    }, COMMIT_SPRING_MS);
  }

  /**
   * Hide and clear all drag-related state. Called after the commit
   * spring resolves (or directly from onReset for the no-overlay-up
   * path — e.g. a CANCEL'd stroke that never crossed slop).
   */
  reset(): void {
    AppStorage.SetOrCreate(APP_KEY_DRAG_VISIBLE, false);
    AppStorage.SetOrCreate(APP_KEY_DRAG_X, 0);
    AppStorage.SetOrCreate(APP_KEY_DRAG_Y, 0);
    AppStorage.SetOrCreate(APP_KEY_DRAG_SCALE, 1.0);
    AppStorage.SetOrCreate(APP_KEY_DRAG_ALPHA, 1.0);
    AppStorage.SetOrCreate(APP_KEY_DRAG_RADIUS, 0);
    AppStorage.SetOrCreate(APP_KEY_DRAG_BACKDROP_ALPHA, 0);
  }
}
