//@ts-nocheck
/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0.
 *
 * Per-frame transform driver for the drag overlay (AOSP Quickstep
 * "Overview" parity).
 *
 * The overlay renders a HORIZONTAL ROW of cards: N background-recents
 * to the LEFT, plus the captured foreground snapshot at the RIGHT. The
 * whole row is a single scaled container — the scale's fixed point is
 * the foreground card's BOTTOM-CENTER, so as the user drags up the
 * foreground card shrinks "out from under their finger" (its bottom
 * edge stays attached to the finger Y, AOSP-style) while the
 * background recents shrink toward the foreground and become visible
 * to its left.
 *
 *   progress         = min(deltaVp / dragLengthVp, 1)
 *   scale            = lerp(1.0, MIN_SCALE, progress)
 *   targetCenterXVp  = screenW/2 + (fingerX - screenW/2) * HORIZ_DAMPING
 *   targetBottomYVp  = fingerY                        // bottom-tracks-finger
 *   foregroundAlpha  = lerp 1.0 → 0.85 past 25 %
 *   recentsAlpha     = lerp 0   → 1.0 past 15 %
 *   radius_vp        = lerp(0, 24, progress)
 *
 * After RECENTS commit the row springs to the Overview pose: scale
 * 0.65, foreground card CENTERED at screen middle, recents visible
 * to the left.
 *
 * Row geometry (computed in updateGeometry):
 *   cardWidthVp   = screenWidthVp
 *   cardHeightVp  = screenHeightVp
 *   rowWidthVp    = (N+1)*cardW + N*SPACING_VP    // N = recents count
 *   anchorXVp     = rowWidth - cardW/2           // foreground card centerX in row
 *   anchorYVp     = cardHeight                   // foreground card BOTTOM in row
 *   rowLeftVp     = targetCenterX - anchorX
 *   rowTopVp      = targetBottomY - cardHeight
 *
 * Why "bottom-tracks-finger" instead of "center-tracks-finger":
 *   at gesture start (finger at bottom edge, scale=1) we want the
 *   foreground card to fill the screen exactly — i.e. its bottom edge
 *   at fingerY=screenH and its top at 0. The bottom-tracking formula
 *   gives this for free.
 */

import Log from '../../../../../../../common/src/main/ets/default/Log';
import { GestureEndTarget } from '../recognizer/SwipeRecognizer';

const TAG = 'GestureNavigation_DragController';

// Settle window for the commit spring before the structural handoff
// (or, for RECENTS, before flipping the window touchable).
export const COMMIT_SPRING_MS = 320;

// AppStorage keys.
export const APP_KEY_DRAG_VISIBLE = 'OniroDragVisible';
export const APP_KEY_DRAG_ROW_LEFT = 'OniroDragRowLeftVp';
export const APP_KEY_DRAG_ROW_TOP = 'OniroDragRowTopVp';
export const APP_KEY_DRAG_ROW_WIDTH = 'OniroDragRowWidthVp';
export const APP_KEY_DRAG_ROW_HEIGHT = 'OniroDragRowHeightVp';
export const APP_KEY_DRAG_CARD_WIDTH = 'OniroDragCardWidthVp';
export const APP_KEY_DRAG_CARD_HEIGHT = 'OniroDragCardHeightVp';
export const APP_KEY_DRAG_ANCHOR_X = 'OniroDragAnchorXVp';
export const APP_KEY_DRAG_ANCHOR_Y = 'OniroDragAnchorYVp';
export const APP_KEY_DRAG_SCALE = 'OniroDragScale';
export const APP_KEY_DRAG_ALPHA = 'OniroDragAlpha';
export const APP_KEY_DRAG_RECENTS_ALPHA = 'OniroDragRecentsAlpha';
export const APP_KEY_DRAG_RADIUS = 'OniroDragRadius';
export const APP_KEY_DRAG_BACKDROP_ALPHA = 'OniroDragBackdropAlpha';
export const APP_KEY_DRAG_RECENTS_MODE = 'OniroDragRecentsMode';
export const APP_KEY_DRAG_SPACING = 'OniroDragCardSpacingVp';

const MIN_SCALE = 0.45;
const OVERVIEW_SCALE = 0.65;             // pose at RECENTS commit
const MAX_RADIUS_VP = 24;
const ALPHA_HOLD_FRAC = 0.25;
const ALPHA_FLOOR = 0.85;
const RECENTS_ALPHA_HOLD_FRAC = 0.10;    // start fading recents in past 10 %
const HORIZ_DAMPING = 0.35;
const DRAG_LENGTH_FRACTION = 0.75;
const CARD_SPACING_VP = 40;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
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
  private recentsCount: number = 0;
  private tickCount = 0;

  constructor(cfg: DragControllerConfig) {
    this.cfg = cfg;
    this.screenHeightVp = cfg.screenHeightPx / cfg.vpToPx;
    this.screenWidthVp = cfg.screenWidthPx / cfg.vpToPx;
    this.dragLengthVp = this.screenHeightVp * DRAG_LENGTH_FRACTION;
  }

  /**
   * Called once after RecentsLoader resolves so the row width and
   * scale-anchor land in the right place. If no recents loaded (or
   * the load is still in flight when start() runs), row is just the
   * single foreground card.
   */
  setRecentsCount(n: number): void {
    this.recentsCount = n;
    Log.showInfo(TAG, `setRecentsCount=${n}`);
    // If a drag is currently active, recompute geometry under the
    // current scale/finger so the row stretches without snapping.
    if (AppStorage.Get<boolean>(APP_KEY_DRAG_VISIBLE) === true &&
        AppStorage.Get<boolean>(APP_KEY_DRAG_RECENTS_MODE) !== true) {
      const sc: number = AppStorage.Get<number>(APP_KEY_DRAG_SCALE) ?? 1;
      // No live finger position cached; just rewrite static geometry
      // (row width / card dims / anchor) — position keys keep their
      // last value, which is one tick stale but invisible to the eye.
      this.writeStaticGeometry();
      Log.showDebug(TAG, `geometry refresh mid-drag scale=${sc.toFixed(2)}`);
    } else {
      this.writeStaticGeometry();
    }
  }

  /**
   * Called when the recognizer crosses slop. Reset all transform values
   * to a clean fullscreen baseline so the first onProgress sees a
   * coherent starting state.
   */
  start(): void {
    this.tickCount = 0;
    AppStorage.SetOrCreate(APP_KEY_DRAG_RECENTS_MODE, false);
    AppStorage.SetOrCreate(APP_KEY_DRAG_SCALE, 1.0);
    AppStorage.SetOrCreate(APP_KEY_DRAG_ALPHA, 1.0);
    AppStorage.SetOrCreate(APP_KEY_DRAG_RECENTS_ALPHA, 0);
    AppStorage.SetOrCreate(APP_KEY_DRAG_RADIUS, 0);
    AppStorage.SetOrCreate(APP_KEY_DRAG_BACKDROP_ALPHA, 1.0);
    this.writeStaticGeometry();
    // Position the row so the foreground card fills the screen
    // exactly: bottom at screen-bottom, center at screen-middle.
    this.writePosition(this.screenWidthVp / 2, this.screenHeightVp);
    AppStorage.SetOrCreate(APP_KEY_DRAG_VISIBLE, true);
  }

  /**
   * Called for every onProgress tick. Updates scale + alpha + radius +
   * row position based on the current finger (px coords passed
   * through from the recognizer).
   */
  onProgress(displacementVp: number, lastXPx: number, lastYPx: number): void {
    const progress = Math.min(displacementVp / this.dragLengthVp, 1);
    const scale = lerp(1.0, MIN_SCALE, progress);

    const centerXVp = this.screenWidthVp / 2;
    const fingerXVp = lastXPx / this.cfg.vpToPx;
    const fingerYVp = lastYPx / this.cfg.vpToPx;
    const targetCenterXVp = centerXVp + (fingerXVp - centerXVp) * HORIZ_DAMPING;
    const targetBottomYVp = fingerYVp;

    const alpha = progress < ALPHA_HOLD_FRAC
      ? 1.0
      : lerp(1.0, ALPHA_FLOOR, (progress - ALPHA_HOLD_FRAC) / (1 - ALPHA_HOLD_FRAC));
    const recentsAlpha = progress < RECENTS_ALPHA_HOLD_FRAC
      ? 0
      : clamp01((progress - RECENTS_ALPHA_HOLD_FRAC) / (1 - RECENTS_ALPHA_HOLD_FRAC));
    const radius = lerp(0, MAX_RADIUS_VP, progress);

    AppStorage.SetOrCreate(APP_KEY_DRAG_SCALE, scale);
    AppStorage.SetOrCreate(APP_KEY_DRAG_ALPHA, alpha);
    AppStorage.SetOrCreate(APP_KEY_DRAG_RECENTS_ALPHA, recentsAlpha);
    AppStorage.SetOrCreate(APP_KEY_DRAG_RADIUS, radius);
    this.writePosition(targetCenterXVp, targetBottomYVp);

    this.tickCount++;
    if (this.tickCount % 8 === 0) {
      Log.showDebug(TAG,
        `tick=${this.tickCount} prog=${progress.toFixed(2)} ` +
        `sc=${scale.toFixed(2)} fgA=${alpha.toFixed(2)} ` +
        `recA=${recentsAlpha.toFixed(2)} cx=${targetCenterXVp.toFixed(0)}vp ` +
        `by=${targetBottomYVp.toFixed(0)}vp`);
    }
  }

  /**
   * Commit-time spring. Writes the END pose so DragOverlay's
   * `.animation()` modifier runs the spring on the GPU. After
   * COMMIT_SPRING_MS, onComplete fires.
   *
   *   HOME    → scale 0.12, alpha 0, slight scale-out into launcher
   *   RECENTS → Overview pose (scale 0.65, foreground centered at
   *             screen middle); also sets recentsMode=true so the
   *             overlay flips to interactive.
   *   CANCEL  → snap back to fullscreen pose, alpha 1
   */
  commit(target: GestureEndTarget, onComplete: () => void): void {
    if (target === GestureEndTarget.HOME) {
      AppStorage.SetOrCreate(APP_KEY_DRAG_SCALE, 0.12);
      AppStorage.SetOrCreate(APP_KEY_DRAG_ALPHA, 0);
      AppStorage.SetOrCreate(APP_KEY_DRAG_RECENTS_ALPHA, 0);
      AppStorage.SetOrCreate(APP_KEY_DRAG_RADIUS, MAX_RADIUS_VP);
      AppStorage.SetOrCreate(APP_KEY_DRAG_BACKDROP_ALPHA, 0);
      // Drift the (now tiny) foreground toward screen center as it
      // dissolves — looks like a hot-seat handoff even if we never
      // land exactly on the icon.
      this.writePosition(this.screenWidthVp / 2, this.screenHeightVp * 0.92);
    } else if (target === GestureEndTarget.RECENTS) {
      // Overview pose: foreground card CENTERED horizontally and
      // vertically in the viewport, scale 0.65, recents visible.
      AppStorage.SetOrCreate(APP_KEY_DRAG_SCALE, OVERVIEW_SCALE);
      AppStorage.SetOrCreate(APP_KEY_DRAG_ALPHA, 1.0);
      AppStorage.SetOrCreate(APP_KEY_DRAG_RECENTS_ALPHA, 1.0);
      AppStorage.SetOrCreate(APP_KEY_DRAG_RADIUS, MAX_RADIUS_VP);
      AppStorage.SetOrCreate(APP_KEY_DRAG_BACKDROP_ALPHA, 1.0);
      // Centered → centerY at screenH/2 → bottom at screenH/2 +
      // (cardH * scale)/2 — but we anchor on the bottom in row local
      // coords, so target the equivalent "fingerY" that places center
      // at screen mid. With bottom-anchored scale:
      //   afterScaleCenterY = posY + cardH * (1 - sc/2)
      //   want this = screenH/2 → posY = screenH/2 - cardH * (1 - sc/2)
      // The writePosition helper takes a targetBottomY that becomes
      // posY = targetBottomY - cardH, so:
      //   targetBottomY = screenH/2 + cardH * (sc/2)
      // With cardH = screenH:
      //   targetBottomY = screenH/2 + screenH * sc/2 = screenH * (1 + sc)/2
      const targetBottomY = this.screenHeightVp * (1 + OVERVIEW_SCALE) / 2;
      this.writePosition(this.screenWidthVp / 2, targetBottomY);
    } else {
      // CANCEL — snap back to fullscreen.
      AppStorage.SetOrCreate(APP_KEY_DRAG_SCALE, 1.0);
      AppStorage.SetOrCreate(APP_KEY_DRAG_ALPHA, 1.0);
      AppStorage.SetOrCreate(APP_KEY_DRAG_RECENTS_ALPHA, 0);
      AppStorage.SetOrCreate(APP_KEY_DRAG_RADIUS, 0);
      AppStorage.SetOrCreate(APP_KEY_DRAG_BACKDROP_ALPHA, 0);
      this.writePosition(this.screenWidthVp / 2, this.screenHeightVp);
    }
    Log.showInfo(TAG,
      `commit-spring target=${GestureEndTarget[target]} -> ` +
      `sc=${AppStorage.Get<number>(APP_KEY_DRAG_SCALE)?.toFixed(2)}`);
    setTimeout(() => {
      if (target === GestureEndTarget.RECENTS) {
        // The overlay stays up and the user can interact with it.
        // Flag recents-mode so DragOverlay enables tap handlers.
        AppStorage.SetOrCreate(APP_KEY_DRAG_RECENTS_MODE, true);
      }
      onComplete();
    }, COMMIT_SPRING_MS);
  }

  /**
   * Hide and clear all drag-related state.
   */
  reset(): void {
    AppStorage.SetOrCreate(APP_KEY_DRAG_VISIBLE, false);
    AppStorage.SetOrCreate(APP_KEY_DRAG_RECENTS_MODE, false);
    AppStorage.SetOrCreate(APP_KEY_DRAG_SCALE, 1.0);
    AppStorage.SetOrCreate(APP_KEY_DRAG_ALPHA, 1.0);
    AppStorage.SetOrCreate(APP_KEY_DRAG_RECENTS_ALPHA, 0);
    AppStorage.SetOrCreate(APP_KEY_DRAG_RADIUS, 0);
    AppStorage.SetOrCreate(APP_KEY_DRAG_BACKDROP_ALPHA, 0);
  }

  // ---- Internal --------------------------------------------------------

  private writeStaticGeometry(): void {
    const cardW = this.screenWidthVp;
    const cardH = this.screenHeightVp;
    const rowW = (this.recentsCount + 1) * cardW + this.recentsCount * CARD_SPACING_VP;
    const rowH = cardH;
    // Scale fixed point = foreground card BOTTOM-CENTER in row coords.
    const anchorX = rowW - cardW / 2;
    const anchorY = cardH;
    AppStorage.SetOrCreate(APP_KEY_DRAG_CARD_WIDTH, cardW);
    AppStorage.SetOrCreate(APP_KEY_DRAG_CARD_HEIGHT, cardH);
    AppStorage.SetOrCreate(APP_KEY_DRAG_ROW_WIDTH, rowW);
    AppStorage.SetOrCreate(APP_KEY_DRAG_ROW_HEIGHT, rowH);
    AppStorage.SetOrCreate(APP_KEY_DRAG_ANCHOR_X, anchorX);
    AppStorage.SetOrCreate(APP_KEY_DRAG_ANCHOR_Y, anchorY);
    AppStorage.SetOrCreate(APP_KEY_DRAG_SPACING, CARD_SPACING_VP);
  }

  /** Place the row so foreground card centerX lands at targetCenterX
   *  and foreground card BOTTOM lands at targetBottomY (both vp). */
  private writePosition(targetCenterXVp: number, targetBottomYVp: number): void {
    const cardW = this.screenWidthVp;
    const cardH = this.screenHeightVp;
    const rowW = (this.recentsCount + 1) * cardW + this.recentsCount * CARD_SPACING_VP;
    const anchorX = rowW - cardW / 2;
    // posX + anchorX = targetCenterX  →  posX = targetCenterX - anchorX
    // posY + anchorY = targetBottomY  →  posY = targetBottomY - cardH
    const posX = targetCenterXVp - anchorX;
    const posY = targetBottomYVp - cardH;
    AppStorage.SetOrCreate(APP_KEY_DRAG_ROW_LEFT, posX);
    AppStorage.SetOrCreate(APP_KEY_DRAG_ROW_TOP, posY);
  }
}
