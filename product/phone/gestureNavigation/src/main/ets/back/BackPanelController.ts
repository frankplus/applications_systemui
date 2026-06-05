//@ts-nocheck
/*
 * Copyright (C) 2022 The Android Open Source Project
 * Copyright (c) 2026 Francesco Pham
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Derivative work: ported from AOSP SystemUI BackPanelController.kt and
 * BackPanel.kt (Copyright (C) 2022 The Android Open Source Project);
 * translated from Kotlin to ArkTS and modified.
 *
 * Side-edge "back" indicator — a port of AOSP SystemUI's
 * BackPanelController.kt (the 7-state gesture machine) fused with the
 * non-draw half of BackPanel.kt (the spring-animated float model). The
 * Canvas half of BackPanel.kt lives in pages/BackPanel.ets; this class
 * feeds it a packed frame object through AppStorage every animation
 * tick.
 *
 * State machine (verbatim from AOSP):
 *   GONE → ENTRY (slop crossed) → ACTIVE / INACTIVE  (drag past/under
 *   the trigger threshold) → on release: COMMITTED / FLUNG (fires back)
 *   or CANCELLED (retracts).  The arrow's horizontalTranslation,
 *   vertical translation, length/height, background pill width/height/
 *   corners, scale and alpha each ride their own SpringForce so the
 *   indicator stretches toward and springs back from the finger.
 *
 * Driving model: the controller runs the spring physics itself on a
 * single setInterval ticker (dt measured from Date.now(), so jitter
 * only makes strides uneven, never unstable — the solver is analytic).
 * It owns the VelocityTracker (sees every raw pointer event from the
 * service, so fling velocity is exact). Each tick it packs the ~13 draw
 * floats into OniroBackFrame; the .ets Canvas @Watch'es that and
 * repaints. The window itself never moves — the arrow's screen Y is
 * carried in the frame and drawn at absolute vp coords.
 */

import Log from '../../../../../../../common/src/main/ets/default/Log';
import vibrator from '@ohos.vibrator';
import { VelocityTracker } from './VelocityTracker';
import {
  AnimatedFloat, SpringForce, AnimationEndListener,
  MIN_VISIBLE_CHANGE_PIXELS, MIN_VISIBLE_CHANGE_ROTATION_DEGREES,
  MIN_VISIBLE_CHANGE_SCALE, MIN_VISIBLE_CHANGE_ALPHA,
} from './Spring';
import {
  EdgePanelParams, BackIndicatorDimens, ArrowDimens, BackgroundDimens,
} from './EdgePanelParams';

const TAG = 'GestureNavigation_BackPanel';

export const APP_KEY_BACK_FRAME = 'OniroBackFrame';

// Timing (ms) — verbatim from BackPanelController.kt.
const MIN_DURATION_ACTIVE_BEFORE_INACTIVE_ANIMATION = 300;
const MIN_DURATION_ACTIVE_AFTER_INACTIVE_ANIMATION = 130;
const MIN_DURATION_CANCELLED_ANIMATION = 200;
const MIN_DURATION_COMMITTED_ANIMATION = 80;
const MIN_DURATION_COMMITTED_AFTER_FLING_ANIMATION = 120;
const MIN_DURATION_INACTIVE_BEFORE_FLUNG_ANIMATION = 50;
const MIN_DURATION_INACTIVE_BEFORE_ACTIVE_ANIMATION = 160;
const MIN_DURATION_ENTRY_BEFORE_ACTIVE_ANIMATION = 10;
const MAX_DURATION_ENTRY_BEFORE_ACTIVE_ANIMATION = 100;
const MIN_DURATION_FLING_ANIMATION = 160;
const MIN_DURATION_ENTRY_TO_ACTIVE_CONSIDERED_AS_FLING = 100;
const MIN_DURATION_INACTIVE_TO_ACTIVE_CONSIDERED_AS_FLING = 400;

const POP_ON_FLING_DELAY = 60;
const POP_ON_FLING_VELOCITY = 2;
const POP_ON_COMMITTED_VELOCITY = 3;
const POP_ON_ENTRY_TO_ACTIVE_VELOCITY = 4.5;
const POP_ON_INACTIVE_TO_ACTIVE_VELOCITY = 4.7;
const POP_ON_INACTIVE_VELOCITY = -1.5;

const FAILSAFE_DELAY_MS = 350;

// ViewConfiguration equivalents, in vp.
const TOUCH_SLOP_VP = 8;
const EDGE_SLOP_VP = 12;                 // GONE → ENTRY threshold
const MIN_FLING_VELOCITY_VP_PER_MS = 0.05; // ~50 vp/s
const MIN_FLING_DISTANCE_VP = TOUCH_SLOP_VP * 3;

// navigation_edge_panel_height — the arrow's "window" height; the arrow
// vertical centre is kept this/2 away from the screen edges.
const PANEL_HEIGHT_VP = 268;

export enum GestureState {
  GONE = 0,
  ENTRY = 1,
  ACTIVE = 2,
  INACTIVE = 3,
  FLUNG = 4,
  COMMITTED = 5,
  CANCELLED = 6,
}

export interface BackPanelCallbacks {
  /** Perform the actual back navigation (inject BACK key). */
  triggerBack: () => void;
}

function saturate(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function smoothStep(edge0: number, edge1: number, x: number): number {
  const t = saturate((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
function constrain(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Fires `runnable` after a delay once the watched spring settles (not
 *  on cancel). Port of BackPanelController.DelayedOnAnimationEndListener. */
class DelayedOnAnimationEndListener implements AnimationEndListener {
  constructor(
    private runnableDelay: number,
    private runnable: () => void,
    private elapsedSinceEntry: () => number,
    private schedule: (cb: () => void, delay: number) => void,
  ) {}
  onAnimationEnd(canceled: boolean): void {
    if (!canceled) {
      const delay = Math.max(0, this.runnableDelay - this.elapsedSinceEntry());
      this.schedule(this.runnable, delay);
    }
  }
  run(): void { this.runnable(); }
}

/**
 * BackPanel.kt minus onDraw — the spring-animated float model. The
 * controller drives these; the .ets Canvas reads frame() to paint.
 */
class BackPanelModel {
  arrowsPointLeft = false;
  isLeftPanel = false;

  arrowLength = new AnimatedFloat('arrowLength', MIN_VISIBLE_CHANGE_PIXELS);
  arrowHeight = new AnimatedFloat('arrowHeight', MIN_VISIBLE_CHANGE_ROTATION_DEGREES);
  backgroundWidth = new AnimatedFloat('backgroundWidth', MIN_VISIBLE_CHANGE_PIXELS, 0);
  backgroundHeight = new AnimatedFloat('backgroundHeight', MIN_VISIBLE_CHANGE_PIXELS, 0);
  backgroundEdgeCornerRadius = new AnimatedFloat('backgroundEdgeCornerRadius');
  backgroundFarCornerRadius = new AnimatedFloat('backgroundFarCornerRadius');
  scale = new AnimatedFloat('scale', MIN_VISIBLE_CHANGE_SCALE, 0);
  scalePivotX = new AnimatedFloat('scalePivotX', MIN_VISIBLE_CHANGE_PIXELS, 0);
  horizontalTranslation = new AnimatedFloat('horizontalTranslation');
  verticalTranslation = new AnimatedFloat('verticalTranslation');
  arrowAlpha = new AnimatedFloat('arrowAlpha', MIN_VISIBLE_CHANGE_ALPHA, 0, 1);
  backgroundAlpha = new AnimatedFloat('backgroundAlpha', MIN_VISIBLE_CHANGE_ALPHA, 0, 1);

  private all: AnimatedFloat[] = [
    this.arrowLength, this.arrowHeight, this.backgroundWidth, this.backgroundHeight,
    this.backgroundEdgeCornerRadius, this.backgroundFarCornerRadius, this.scale,
    this.scalePivotX, this.horizontalTranslation, this.verticalTranslation,
    this.arrowAlpha, this.backgroundAlpha,
  ];

  /** Advance every float; returns true if any is still running. */
  tick(dtSec: number): boolean {
    let any = false;
    for (const f of this.all) any = f.tick(dtSec) || any;
    return any;
  }
  get anyRunning(): boolean {
    for (const f of this.all) if (f.isRunning) return true;
    return false;
  }
  cancelAnimations(): void { for (const f of this.all) f.cancel(); }

  addAnimationEndListener(f: AnimatedFloat, l: AnimationEndListener): boolean {
    if (f.isRunning) { f.addEndListener(l); return true; }
    l.onAnimationEnd(false);
    return false;
  }

  setStretch(
    horizontalTranslationStretchAmount: number,
    arrowStretchAmount: number,
    arrowAlphaStretchAmount: number,
    backgroundAlphaStretchAmount: number,
    backgroundWidthStretchAmount: number,
    backgroundHeightStretchAmount: number,
    edgeCornerStretchAmount: number,
    farCornerStretchAmount: number,
    fullyStretchedDimens: BackIndicatorDimens,
  ): void {
    this.horizontalTranslation.stretchBy(fullyStretchedDimens.horizontalTranslation, horizontalTranslationStretchAmount);
    this.arrowLength.stretchBy(fullyStretchedDimens.arrowDimens.length, arrowStretchAmount);
    this.arrowHeight.stretchBy(fullyStretchedDimens.arrowDimens.height, arrowStretchAmount);
    this.arrowAlpha.stretchBy(fullyStretchedDimens.arrowDimens.alpha, arrowAlphaStretchAmount);
    this.backgroundAlpha.stretchBy(fullyStretchedDimens.backgroundDimens.alpha, backgroundAlphaStretchAmount);
    this.backgroundWidth.stretchBy(fullyStretchedDimens.backgroundDimens.width, backgroundWidthStretchAmount);
    this.backgroundHeight.stretchBy(fullyStretchedDimens.backgroundDimens.height, backgroundHeightStretchAmount);
    this.backgroundEdgeCornerRadius.stretchBy(fullyStretchedDimens.backgroundDimens.edgeCornerRadius, edgeCornerStretchAmount);
    this.backgroundFarCornerRadius.stretchBy(fullyStretchedDimens.backgroundDimens.farCornerRadius, farCornerStretchAmount);
  }

  popOffEdge(startingVelocity: number): void {
    this.scale.stretchTo(0, startingVelocity * -0.8);
    this.horizontalTranslation.stretchTo(0, startingVelocity * 200);
  }
  popScale(startingVelocity: number): void {
    this.scalePivotX.snapTo(this.backgroundWidth.pos / 2);
    this.scale.stretchTo(0, startingVelocity);
  }
  popArrowAlpha(startingVelocity: number, springForce?: SpringForce | null): void {
    this.arrowAlpha.stretchTo(0, startingVelocity, springForce ?? undefined);
  }

  resetStretch(): void {
    this.backgroundAlpha.snapTo(1);
    this.verticalTranslation.snapTo(0);
    this.scale.snapTo(1);
    this.horizontalTranslation.snapToRestingPosition();
    this.arrowLength.snapToRestingPosition();
    this.arrowHeight.snapToRestingPosition();
    this.arrowAlpha.snapToRestingPosition();
    this.backgroundWidth.snapToRestingPosition();
    this.backgroundHeight.snapToRestingPosition();
    this.backgroundEdgeCornerRadius.snapToRestingPosition();
    this.backgroundFarCornerRadius.snapToRestingPosition();
  }

  setRestingDimens(restingParams: BackIndicatorDimens, animate: boolean = true): void {
    this.horizontalTranslation.updateRestingPosition(restingParams.horizontalTranslation);
    this.scale.updateRestingPosition(restingParams.scale);
    this.backgroundAlpha.updateRestingPosition(restingParams.backgroundDimens.alpha);
    this.arrowAlpha.updateRestingPosition(restingParams.arrowDimens.alpha, animate);
    this.arrowLength.updateRestingPosition(restingParams.arrowDimens.length, animate);
    this.arrowHeight.updateRestingPosition(restingParams.arrowDimens.height, animate);
    this.scalePivotX.updateRestingPosition(restingParams.scalePivotX, animate);
    this.backgroundWidth.updateRestingPosition(restingParams.backgroundDimens.width, animate);
    this.backgroundHeight.updateRestingPosition(restingParams.backgroundDimens.height, animate);
    this.backgroundEdgeCornerRadius.updateRestingPosition(restingParams.backgroundDimens.edgeCornerRadius, animate);
    this.backgroundFarCornerRadius.updateRestingPosition(restingParams.backgroundDimens.farCornerRadius, animate);
  }

  animateVertically(yPos: number): void { this.verticalTranslation.stretchTo(yPos); }

  setSpring(springs: {
    horizontalTranslation?: SpringForce | null; verticalTranslation?: SpringForce | null;
    scale?: SpringForce | null; arrowLength?: SpringForce | null; arrowHeight?: SpringForce | null;
    arrowAlpha?: SpringForce | null; backgroundAlpha?: SpringForce | null;
    backgroundFarCornerRadius?: SpringForce | null; backgroundEdgeCornerRadius?: SpringForce | null;
    backgroundWidth?: SpringForce | null; backgroundHeight?: SpringForce | null;
  }): void {
    if (springs.arrowLength) this.arrowLength.setSpring(springs.arrowLength);
    if (springs.arrowHeight) this.arrowHeight.setSpring(springs.arrowHeight);
    if (springs.arrowAlpha) this.arrowAlpha.setSpring(springs.arrowAlpha);
    if (springs.backgroundAlpha) this.backgroundAlpha.setSpring(springs.backgroundAlpha);
    if (springs.backgroundFarCornerRadius) this.backgroundFarCornerRadius.setSpring(springs.backgroundFarCornerRadius);
    if (springs.backgroundEdgeCornerRadius) this.backgroundEdgeCornerRadius.setSpring(springs.backgroundEdgeCornerRadius);
    if (springs.scale) this.scale.setSpring(springs.scale);
    if (springs.backgroundWidth) this.backgroundWidth.setSpring(springs.backgroundWidth);
    if (springs.backgroundHeight) this.backgroundHeight.setSpring(springs.backgroundHeight);
    if (springs.horizontalTranslation) this.horizontalTranslation.setSpring(springs.horizontalTranslation);
    if (springs.verticalTranslation) this.verticalTranslation.setSpring(springs.verticalTranslation);
  }
}

export interface BackPanelConfig {
  vpToPx: number;
  screenWidthPx: number;
  screenHeightPx: number;
}

export class BackPanelController {
  private cfg: BackPanelConfig;
  private cbs: BackPanelCallbacks;
  private params = new EdgePanelParams();
  private model = new BackPanelModel();

  currentState: GestureState = GestureState.GONE;
  private previousState: GestureState = GestureState.GONE;

  private screenWidthVp: number;
  private screenHeightVp: number;
  private fullyStretchedThreshold = 0;

  // Touch tracking (all in vp).
  private startX = 0;
  private startY = 0;
  private baseCenterYVp = 0;
  private previousXTranslation = 0;
  private previousXTranslationOnActiveOffset = 0;
  private totalTouchDeltaActive = 0;
  private totalTouchDeltaInactive = 0;
  private touchDeltaStartX = 0;
  private hasPassedDragSlop = false;

  private velocityTracker = new VelocityTracker(100, 20);

  private gestureEntryTime = 0;
  private gestureInactiveTime = 0;
  private pastThresholdTime = 0;
  private entryToActiveDelay = 0;

  // Spring ticker.
  private tickerId: number | null = null;
  private lastTickMs = 0;
  // Pending postDelayed callbacks (for cancelAllPendingAnimations).
  private pendingTimers: number[] = [];
  private failsafeTimer: number | null = null;
  private frameSeq = 0;

  private now(): number { return Date.now(); }
  private get elapsedTimeSinceEntry(): number { return this.now() - this.gestureEntryTime; }
  private get elapsedTimeSinceInactive(): number { return this.now() - this.gestureInactiveTime; }

  constructor(cfg: BackPanelConfig, cbs: BackPanelCallbacks) {
    this.cfg = cfg;
    this.cbs = cbs;
    this.screenWidthVp = cfg.screenWidthPx / cfg.vpToPx;
    this.screenHeightVp = cfg.screenHeightPx / cfg.vpToPx;
    this.fullyStretchedThreshold = Math.min(this.screenWidthVp, this.params.swipeProgressThreshold);
    this.updateArrowState(GestureState.GONE, true);
    this.updateRestingArrowDimens();
    this.writeFrame();
  }

  // ---- postDelayed helpers --------------------------------------------

  private postDelayed(cb: () => void, delay: number): void {
    const id = setTimeout(() => {
      this.pendingTimers = this.pendingTimers.filter((t) => t !== id);
      cb();
    }, delay) as unknown as number;
    this.pendingTimers.push(id);
  }
  private clearPendingTimers(): void {
    for (const id of this.pendingTimers) clearTimeout(id);
    this.pendingTimers = [];
  }

  // ---- Ticker ----------------------------------------------------------

  private ensureTicker(): void {
    if (this.tickerId !== null) return;
    this.lastTickMs = this.now();
    this.tickerId = setInterval(() => this.onTick(), 16) as unknown as number;
  }
  private stopTicker(): void {
    if (this.tickerId !== null) { clearInterval(this.tickerId); this.tickerId = null; }
  }
  private onTick(): void {
    const t = this.now();
    let dt = (t - this.lastTickMs) / 1000;
    this.lastTickMs = t;
    if (dt <= 0) return;
    if (dt > 0.064) dt = 0.064; // cap after a stall
    const running = this.model.tick(dt);
    this.writeFrame();
    if (!running && this.currentState === GestureState.GONE) {
      this.stopTicker();
    }
  }

  // ---- Frame writer ----------------------------------------------------

  private writeFrame(): void {
    const m = this.model;
    const visible = this.currentState !== GestureState.GONE;
    AppStorage.SetOrCreate(APP_KEY_BACK_FRAME, {
      seq: ++this.frameSeq,
      visible,
      isLeftPanel: m.isLeftPanel,
      arrowsPointLeft: m.arrowsPointLeft,
      centerYVp: this.baseCenterYVp + m.verticalTranslation.pos,
      arrowLength: m.arrowLength.pos,
      arrowHeight: m.arrowHeight.pos,
      backgroundWidth: m.backgroundWidth.pos,
      backgroundHeight: m.backgroundHeight.pos,
      edgeCornerRadius: m.backgroundEdgeCornerRadius.pos,
      farCornerRadius: m.backgroundFarCornerRadius.pos,
      scale: m.scale.pos,
      scalePivotX: m.scalePivotX.pos,
      horizontalTranslation: m.horizontalTranslation.pos,
      arrowAlpha: m.arrowAlpha.pos,
      backgroundAlpha: m.backgroundAlpha.pos,
      arrowThickness: this.params.arrowThickness,
    });
  }

  // ---- Public pointer API (called by the service) ----------------------

  /** Pointer DOWN already known to be in a side hot-zone. isLeft=true
   *  for the left edge. Returns true (always accepted). */
  onPointerDown(x: number, y: number, _timeMs: number, isLeft: boolean): boolean {
    this.cancelAllPendingAnimations();
    this.startX = x;
    this.startY = y;
    this.model.isLeftPanel = isLeft;
    this.model.arrowsPointLeft = false; // arrow points back toward the edge
    this.velocityTracker.reset();
    this.velocityTracker.addMovement(_timeMs, x);

    this.updateArrowState(GestureState.GONE);
    this.updateYStartPosition(y);

    this.previousXTranslation = 0;
    this.previousXTranslationOnActiveOffset = 0;
    this.totalTouchDeltaActive = 0;
    this.totalTouchDeltaInactive = 0;
    this.touchDeltaStartX = x;
    this.pastThresholdTime = 0;
    this.hasPassedDragSlop = false;
    this.model.resetStretch();
    this.writeFrame();
    return true;
  }

  onPointerMove(x: number, y: number, timeMs: number): void {
    this.velocityTracker.addMovement(timeMs, x);
    if (this.dragSlopExceeded(x, this.startX)) {
      this.handleMoveEvent(x, y, timeMs);
    }
  }

  onPointerEnd(x: number, y: number, timeMs: number, canceled: boolean): void {
    this.velocityTracker.addMovement(timeMs, x);
    if (canceled) {
      this.updateArrowState(GestureState.GONE);
      return;
    }
    switch (this.currentState) {
      case GestureState.ENTRY:
        if (this.isFlungAwayFromEdge(x) || this.previousXTranslation > this.params.staticTriggerThreshold) {
          this.updateArrowState(GestureState.FLUNG);
        } else {
          this.updateArrowState(GestureState.CANCELLED);
        }
        break;
      case GestureState.INACTIVE:
        if (this.isFlungAwayFromEdge(x)) {
          this.postDelayed(() => this.updateArrowState(GestureState.FLUNG), MIN_DURATION_INACTIVE_BEFORE_FLUNG_ANIMATION);
        } else {
          this.updateArrowState(GestureState.CANCELLED);
        }
        break;
      case GestureState.ACTIVE:
        if (this.previousState === GestureState.ENTRY &&
            this.elapsedTimeSinceEntry < MIN_DURATION_ENTRY_TO_ACTIVE_CONSIDERED_AS_FLING) {
          this.updateArrowState(GestureState.FLUNG);
        } else if (this.previousState === GestureState.INACTIVE &&
            this.elapsedTimeSinceInactive < MIN_DURATION_INACTIVE_TO_ACTIVE_CONSIDERED_AS_FLING) {
          this.postDelayed(() => this.updateArrowState(GestureState.COMMITTED), MIN_DURATION_ACTIVE_AFTER_INACTIVE_ANIMATION);
        } else {
          this.updateArrowState(GestureState.COMMITTED);
        }
        break;
      default:
        this.updateArrowState(GestureState.CANCELLED);
        break;
    }
  }

  destroy(): void {
    this.cancelAllPendingAnimations();
    this.stopTicker();
  }

  // ---- Internal --------------------------------------------------------

  private cancelAllPendingAnimations(): void {
    this.cancelFailsafe();
    this.model.cancelAnimations();
    this.clearPendingTimers();
  }

  private dragSlopExceeded(curX: number, startX: number): boolean {
    if (this.hasPassedDragSlop) return true;
    if (Math.abs(curX - startX) > EDGE_SLOP_VP) {
      this.updateArrowState(GestureState.ENTRY);
      this.hasPassedDragSlop = true;
    }
    return this.hasPassedDragSlop;
  }

  private updateYStartPosition(touchYvp: number): void {
    let y = touchYvp - this.params.fingerOffset;
    y = Math.max(y, this.params.minArrowYPosition);
    this.baseCenterYVp = constrain(y, PANEL_HEIGHT_VP / 2, this.screenHeightVp - PANEL_HEIGHT_VP / 2);
    if (this.baseCenterYVp < this.params.minArrowYPosition) this.baseCenterYVp = this.params.minArrowYPosition;
  }

  private handleMoveEvent(x: number, y: number, _timeMs: number): void {
    const yOffset = y - this.startY;
    const yTranslation = Math.abs(yOffset);
    const xTranslation = Math.max(0, this.model.isLeftPanel ? x - this.startX : this.startX - x);

    const xDelta = xTranslation - this.previousXTranslation;
    this.previousXTranslation = xTranslation;

    if (Math.abs(xDelta) > 0) {
      const isInSameDirection = Math.sign(xDelta) === Math.sign(this.totalTouchDeltaActive);
      const isInDynamicRange = this.params.inDynamicRange(this.totalTouchDeltaActive);
      const isTouchInContinuousDirection = isInSameDirection || isInDynamicRange;
      if (isTouchInContinuousDirection) {
        this.totalTouchDeltaActive += xDelta;
      } else {
        this.totalTouchDeltaActive = xDelta;
        this.touchDeltaStartX = x;
      }
      const minimumDelta = -TOUCH_SLOP_VP;
      this.totalTouchDeltaInactive = Math.max(this.totalTouchDeltaInactive + xDelta, minimumDelta);
    }

    this.updateArrowStateOnMove(yTranslation, xTranslation);

    let gestureProgress: number | null = null;
    switch (this.currentState) {
      case GestureState.ACTIVE: gestureProgress = this.fullScreenProgress(xTranslation); break;
      case GestureState.ENTRY: gestureProgress = this.staticThresholdProgress(xTranslation); break;
      case GestureState.INACTIVE: gestureProgress = this.reactivationThresholdProgress(this.totalTouchDeltaInactive); break;
      default: gestureProgress = null;
    }
    if (gestureProgress !== null) {
      switch (this.currentState) {
        case GestureState.ACTIVE: this.stretchActiveBackIndicator(gestureProgress); break;
        case GestureState.ENTRY: this.stretchEntryBackIndicator(gestureProgress); break;
        case GestureState.INACTIVE: this.stretchInactiveBackIndicator(gestureProgress); break;
        default: break;
      }
    }
    this.setArrowStrokeAlpha(gestureProgress);
    this.setVerticalTranslation(yOffset);
    this.ensureTicker();
  }

  private updateArrowStateOnMove(yTranslation: number, xTranslation: number): void {
    const isWithinYActivationThreshold = xTranslation * 2 >= yTranslation;
    const isPastStaticThreshold = xTranslation > this.params.staticTriggerThreshold;
    switch (this.currentState) {
      case GestureState.ENTRY:
        if (this.isPastThresholdToActive(isPastStaticThreshold, undefined, () => this.entryToActiveDelayCalc())) {
          this.updateArrowState(GestureState.ACTIVE);
        }
        break;
      case GestureState.INACTIVE: {
        const isPastDynamicReactivationThreshold = this.totalTouchDeltaInactive >= this.params.reactivationTriggerThreshold;
        if (this.isPastThresholdToActive(
            isPastStaticThreshold && isPastDynamicReactivationThreshold && isWithinYActivationThreshold,
            MIN_DURATION_INACTIVE_BEFORE_ACTIVE_ANIMATION)) {
          this.updateArrowState(GestureState.ACTIVE);
        }
        break;
      }
      case GestureState.ACTIVE: {
        const isPastDynamicDeactivationThreshold = this.totalTouchDeltaActive <= this.params.deactivationTriggerThreshold;
        const isMinDurationElapsed = this.elapsedTimeSinceEntry > MIN_DURATION_ACTIVE_BEFORE_INACTIVE_ANIMATION;
        const isPastAllThresholds = !isWithinYActivationThreshold || isPastDynamicDeactivationThreshold;
        if (isPastAllThresholds && isMinDurationElapsed) {
          this.updateArrowState(GestureState.INACTIVE);
        }
        break;
      }
      default: break;
    }
  }

  private entryToActiveDelayCalc(): number {
    return this.convertVelocityToAnimationFactor(MIN_DURATION_ENTRY_BEFORE_ACTIVE_ANIMATION, MAX_DURATION_ENTRY_BEFORE_ACTIVE_ANIMATION);
  }

  private setArrowStrokeAlpha(gestureProgress: number | null): void {
    let strokeAlphaProgress: number | null;
    switch (this.currentState) {
      case GestureState.ENTRY:
      case GestureState.INACTIVE: strokeAlphaProgress = gestureProgress; break;
      case GestureState.ACTIVE:
      case GestureState.FLUNG:
      case GestureState.COMMITTED: strokeAlphaProgress = 1; break;
      default: strokeAlphaProgress = 0;
    }
    let indicator: BackIndicatorDimens;
    switch (this.currentState) {
      case GestureState.ENTRY: indicator = this.params.entryIndicator; break;
      case GestureState.INACTIVE: indicator = this.params.preThresholdIndicator; break;
      case GestureState.ACTIVE: indicator = this.params.activeIndicator; break;
      default: indicator = this.params.preThresholdIndicator;
    }
    if (strokeAlphaProgress !== null && indicator.arrowDimens.alphaSpring) {
      const stepVal = indicator.arrowDimens.alphaSpring.get(strokeAlphaProgress);
      if (stepVal.isNewState) this.model.popArrowAlpha(0, stepVal.value);
    }
  }

  private setVerticalTranslation(yOffset: number): void {
    const yTranslation = Math.abs(yOffset);
    const maxYOffset = (PANEL_HEIGHT_VP - this.params.entryIndicator.backgroundDimens.height) / 2;
    const rubberbandAmount = 15;
    const yProgress = saturate(yTranslation / (maxYOffset * rubberbandAmount));
    const yPosition = this.params.verticalTranslationInterpolator.getInterpolation(yProgress) * maxYOffset * Math.sign(yOffset);
    this.model.animateVertically(yPosition);
  }

  private fullScreenProgress(xTranslation: number): number {
    return saturate((xTranslation - this.previousXTranslationOnActiveOffset) / this.fullyStretchedThreshold);
  }
  private staticThresholdProgress(xTranslation: number): number {
    return saturate(xTranslation / this.params.staticTriggerThreshold);
  }
  private reactivationThresholdProgress(totalTouchDelta: number): number {
    return saturate(totalTouchDelta / this.params.reactivationTriggerThreshold);
  }

  private stretchActiveBackIndicator(progress: number): void {
    this.model.setStretch(
      this.params.horizontalTranslationInterpolator.getInterpolation(progress),
      this.params.arrowAngleInterpolator.getInterpolation(progress),
      1, 1,
      this.params.activeWidthInterpolator.getInterpolation(progress),
      1, 1, 1,
      this.params.fullyStretchedIndicator,
    );
  }
  private stretchEntryBackIndicator(progress: number): void {
    this.model.setStretch(
      0,
      this.params.arrowAngleInterpolator.getInterpolation(progress),
      this.params.entryIndicator.arrowDimens.alphaInterpolator?.get(progress).value ?? 0,
      1,
      this.params.entryWidthInterpolator.getInterpolation(progress),
      this.params.heightInterpolator.getInterpolation(progress),
      this.params.edgeCornerInterpolator.getInterpolation(progress),
      this.params.farCornerInterpolator.getInterpolation(progress),
      this.params.preThresholdIndicator,
    );
  }

  private previousPreThresholdWidthInterpolator = this.params.entryWidthInterpolator;
  private preThresholdWidthStretchAmount(progress: number): number {
    let interpolator;
    const isPastSlop = this.totalTouchDeltaInactive > TOUCH_SLOP_VP;
    if (isPastSlop) {
      interpolator = this.totalTouchDeltaInactive > 0
        ? this.params.entryWidthInterpolator
        : this.params.entryWidthTowardsEdgeInterpolator;
    } else {
      interpolator = this.previousPreThresholdWidthInterpolator;
    }
    this.previousPreThresholdWidthInterpolator = interpolator;
    return Math.max(interpolator.getInterpolation(progress), 0);
  }
  private stretchInactiveBackIndicator(progress: number): void {
    this.model.setStretch(
      0,
      this.params.arrowAngleInterpolator.getInterpolation(progress),
      this.params.preThresholdIndicator.arrowDimens.alphaInterpolator?.get(progress).value ?? 0,
      1,
      this.preThresholdWidthStretchAmount(progress),
      this.params.heightInterpolator.getInterpolation(progress),
      this.params.edgeCornerInterpolator.getInterpolation(progress),
      this.params.farCornerInterpolator.getInterpolation(progress),
      this.params.preThresholdIndicator,
    );
  }

  private isFlungAwayFromEdge(endX: number, startX: number = this.touchDeltaStartX): boolean {
    const flingDistance = this.model.isLeftPanel ? endX - startX : startX - endX;
    const rawVel = this.velocityTracker.computeCurrentVelocity(); // vp/ms (raw x)
    const flingVelocity = this.model.isLeftPanel ? rawVel : -rawVel;
    const isPastFlingVelocityThreshold = flingVelocity > MIN_FLING_VELOCITY_VP_PER_MS;
    return flingDistance > MIN_FLING_DISTANCE_VP && isPastFlingVelocityThreshold;
  }

  private isPastThresholdToActive(isPastThreshold: boolean, delay?: number, dynamicDelay?: () => number): boolean {
    const isPastThresholdForFirstTime = this.pastThresholdTime === 0;
    if (!isPastThreshold) { this.pastThresholdTime = 0; return false; }
    if (isPastThresholdForFirstTime) {
      this.pastThresholdTime = this.now();
      this.entryToActiveDelay = dynamicDelay ? dynamicDelay() : (delay ?? 0);
    }
    const timePastThreshold = this.now() - this.pastThresholdTime;
    return timePastThreshold > this.entryToActiveDelay;
  }

  private convertVelocityToAnimationFactor(
    valueOnFastVelocity: number, valueOnSlowVelocity: number,
    fastVelocityBound: number = 1, slowVelocityBound: number = 0.5,
  ): number {
    const xVel = Math.abs(this.velocityTracker.computeCurrentVelocity()); // vp/ms
    const factor = smoothStep(slowVelocityBound, fastVelocityBound, xVel);
    return lerp(valueOnFastVelocity, valueOnSlowVelocity, 1 - factor);
  }

  private updateRestingArrowDimens(): void {
    switch (this.currentState) {
      case GestureState.GONE:
      case GestureState.ENTRY:
        this.model.setSpring({
          arrowLength: this.params.entryIndicator.arrowDimens.lengthSpring,
          arrowHeight: this.params.entryIndicator.arrowDimens.heightSpring,
          scale: this.params.entryIndicator.scaleSpring,
          verticalTranslation: this.params.entryIndicator.verticalTranslationSpring,
          horizontalTranslation: this.params.entryIndicator.horizontalTranslationSpring,
          backgroundAlpha: this.params.entryIndicator.backgroundDimens.alphaSpring,
          backgroundWidth: this.params.entryIndicator.backgroundDimens.widthSpring,
          backgroundHeight: this.params.entryIndicator.backgroundDimens.heightSpring,
          backgroundEdgeCornerRadius: this.params.entryIndicator.backgroundDimens.edgeCornerRadiusSpring,
          backgroundFarCornerRadius: this.params.entryIndicator.backgroundDimens.farCornerRadiusSpring,
        });
        break;
      case GestureState.INACTIVE:
        this.model.setSpring({
          arrowLength: this.params.preThresholdIndicator.arrowDimens.lengthSpring,
          arrowHeight: this.params.preThresholdIndicator.arrowDimens.heightSpring,
          horizontalTranslation: this.params.preThresholdIndicator.horizontalTranslationSpring,
          scale: this.params.preThresholdIndicator.scaleSpring,
          backgroundWidth: this.params.preThresholdIndicator.backgroundDimens.widthSpring,
          backgroundHeight: this.params.preThresholdIndicator.backgroundDimens.heightSpring,
          backgroundEdgeCornerRadius: this.params.preThresholdIndicator.backgroundDimens.edgeCornerRadiusSpring,
          backgroundFarCornerRadius: this.params.preThresholdIndicator.backgroundDimens.farCornerRadiusSpring,
        });
        break;
      case GestureState.ACTIVE:
        this.model.setSpring({
          arrowLength: this.params.activeIndicator.arrowDimens.lengthSpring,
          arrowHeight: this.params.activeIndicator.arrowDimens.heightSpring,
          scale: this.params.activeIndicator.scaleSpring,
          horizontalTranslation: this.params.activeIndicator.horizontalTranslationSpring,
          backgroundWidth: this.params.activeIndicator.backgroundDimens.widthSpring,
          backgroundHeight: this.params.activeIndicator.backgroundDimens.heightSpring,
          backgroundEdgeCornerRadius: this.params.activeIndicator.backgroundDimens.edgeCornerRadiusSpring,
          backgroundFarCornerRadius: this.params.activeIndicator.backgroundDimens.farCornerRadiusSpring,
        });
        break;
      case GestureState.FLUNG:
        this.model.setSpring({
          arrowLength: this.params.flungIndicator.arrowDimens.lengthSpring,
          arrowHeight: this.params.flungIndicator.arrowDimens.heightSpring,
          backgroundWidth: this.params.flungIndicator.backgroundDimens.widthSpring,
          backgroundHeight: this.params.flungIndicator.backgroundDimens.heightSpring,
          backgroundEdgeCornerRadius: this.params.flungIndicator.backgroundDimens.edgeCornerRadiusSpring,
          backgroundFarCornerRadius: this.params.flungIndicator.backgroundDimens.farCornerRadiusSpring,
        });
        break;
      case GestureState.COMMITTED:
        this.model.setSpring({
          arrowLength: this.params.committedIndicator.arrowDimens.lengthSpring,
          arrowHeight: this.params.committedIndicator.arrowDimens.heightSpring,
          scale: this.params.committedIndicator.scaleSpring,
          backgroundAlpha: this.params.committedIndicator.backgroundDimens.alphaSpring,
          backgroundWidth: this.params.committedIndicator.backgroundDimens.widthSpring,
          backgroundHeight: this.params.committedIndicator.backgroundDimens.heightSpring,
          backgroundEdgeCornerRadius: this.params.committedIndicator.backgroundDimens.edgeCornerRadiusSpring,
          backgroundFarCornerRadius: this.params.committedIndicator.backgroundDimens.farCornerRadiusSpring,
        });
        break;
      case GestureState.CANCELLED:
        this.model.setSpring({ backgroundAlpha: this.params.cancelledIndicator.backgroundDimens.alphaSpring });
        break;
      default: break;
    }

    const cs = this.currentState;
    const scale =
      (cs === GestureState.ACTIVE || cs === GestureState.FLUNG) ? this.params.activeIndicator.scale :
      (cs === GestureState.COMMITTED) ? this.params.committedIndicator.scale :
      this.params.preThresholdIndicator.scale;
    const scalePivotX =
      (cs === GestureState.ACTIVE) ? this.params.activeIndicator.scalePivotX :
      (cs === GestureState.FLUNG || cs === GestureState.COMMITTED) ? this.params.committedIndicator.scalePivotX :
      this.params.preThresholdIndicator.scalePivotX;
    let horizontalTranslation: number | null;
    switch (cs) {
      case GestureState.GONE: horizontalTranslation = (this.params.activeIndicator.backgroundDimens.width ?? 0) * -1; break;
      case GestureState.ENTRY:
      case GestureState.INACTIVE: horizontalTranslation = this.params.entryIndicator.horizontalTranslation; break;
      case GestureState.FLUNG:
      case GestureState.ACTIVE: horizontalTranslation = this.params.activeIndicator.horizontalTranslation; break;
      case GestureState.CANCELLED: horizontalTranslation = this.params.cancelledIndicator.horizontalTranslation; break;
      default: horizontalTranslation = null;
    }
    const arrowDimens: ArrowDimens =
      (cs === GestureState.GONE || cs === GestureState.ENTRY || cs === GestureState.INACTIVE) ? this.params.entryIndicator.arrowDimens :
      (cs === GestureState.ACTIVE) ? this.params.activeIndicator.arrowDimens :
      (cs === GestureState.FLUNG) ? this.params.flungIndicator.arrowDimens :
      (cs === GestureState.COMMITTED) ? this.params.committedIndicator.arrowDimens :
      this.params.cancelledIndicator.arrowDimens;
    const backgroundDimens: BackgroundDimens =
      (cs === GestureState.GONE || cs === GestureState.ENTRY || cs === GestureState.INACTIVE) ? this.params.entryIndicator.backgroundDimens :
      (cs === GestureState.ACTIVE) ? this.params.activeIndicator.backgroundDimens :
      (cs === GestureState.FLUNG) ? this.params.activeIndicator.backgroundDimens :
      (cs === GestureState.COMMITTED) ? this.params.committedIndicator.backgroundDimens :
      this.params.cancelledIndicator.backgroundDimens;

    this.model.setRestingDimens({
      horizontalTranslation, scale, scalePivotX, arrowDimens, backgroundDimens,
    }, !(cs === GestureState.FLUNG || cs === GestureState.COMMITTED));
  }

  private updateArrowState(newState: GestureState, force: boolean = false): void {
    if (!force && this.currentState === newState) return;
    this.previousState = this.currentState;
    this.currentState = newState;

    switch (this.currentState) {
      case GestureState.CANCELLED:
        break; // cancelBack() — no-op (no predictive back)
      case GestureState.FLUNG:
      case GestureState.COMMITTED:
        if (this.previousState !== GestureState.FLUNG) this.cbs.triggerBack();
        break;
      case GestureState.ENTRY:
      case GestureState.INACTIVE:
      case GestureState.ACTIVE:
        break; // setTriggerBack(...) — no-op
      default: break;
    }

    switch (this.currentState) {
      case GestureState.GONE:
        this.updateRestingArrowDimens();
        this.writeFrame();
        break;
      case GestureState.ENTRY:
        this.updateRestingArrowDimens();
        this.gestureEntryTime = this.now();
        this.ensureTicker();
        break;
      case GestureState.ACTIVE:
        this.previousXTranslationOnActiveOffset = this.previousXTranslation;
        this.updateRestingArrowDimens();
        this.performActivatedHaptic();
        this.model.popOffEdge(this.previousState === GestureState.INACTIVE ? POP_ON_INACTIVE_TO_ACTIVE_VELOCITY : POP_ON_ENTRY_TO_ACTIVE_VELOCITY);
        this.ensureTicker();
        break;
      case GestureState.INACTIVE:
        this.gestureInactiveTime = this.now();
        this.totalTouchDeltaInactive = this.params.deactivationTriggerThreshold;
        this.model.popOffEdge(POP_ON_INACTIVE_VELOCITY);
        this.performDeactivatedHaptic();
        this.updateRestingArrowDimens();
        this.ensureTicker();
        break;
      case GestureState.FLUNG:
        if (this.previousState !== GestureState.ACTIVE) this.performActivatedHaptic();
        this.postDelayed(() => this.model.popScale(POP_ON_FLING_VELOCITY), POP_ON_FLING_DELAY);
        this.postDelayed(() => this.updateArrowState(GestureState.COMMITTED), MIN_DURATION_FLING_ANIMATION);
        this.updateRestingArrowDimens();
        this.ensureTicker();
        break;
      case GestureState.COMMITTED:
        if (this.previousState === GestureState.FLUNG) {
          this.updateRestingArrowDimens();
          this.postDelayed(() => this.onEndSetGone(), MIN_DURATION_COMMITTED_AFTER_FLING_ANIMATION);
        } else {
          this.model.popScale(POP_ON_COMMITTED_VELOCITY);
          this.postDelayed(() => this.onAlphaEndSetGone(), MIN_DURATION_COMMITTED_ANIMATION);
        }
        this.ensureTicker();
        break;
      case GestureState.CANCELLED: {
        const delay = Math.max(0, MIN_DURATION_CANCELLED_ANIMATION - this.elapsedTimeSinceEntry);
        this.playWithBackgroundWidthAnimation(() => this.onEndSetGone(), delay);
        const springForceOnCancelled = this.params.cancelledIndicator.arrowDimens.alphaSpring?.get(0).value;
        this.model.popArrowAlpha(0, springForceOnCancelled);
        this.ensureTicker();
        break;
      }
      default: break;
    }
  }

  // ---- COMMITTED / CANCELLED → GONE sequencing -------------------------

  private onEndSetGone(): void {
    this.cancelFailsafe();
    this.updateArrowState(GestureState.GONE);
  }
  private onAlphaEndSetGone(): void {
    this.updateRestingArrowDimens();
    const listener = new DelayedOnAnimationEndListener(0, () => this.onEndSetGone(),
      () => this.elapsedTimeSinceEntry, (cb, d) => this.postDelayed(cb, d));
    if (!this.model.addAnimationEndListener(this.model.backgroundAlpha, listener)) {
      this.scheduleFailsafe();
    }
  }
  private playWithBackgroundWidthAnimation(onEnd: () => void, delay: number): void {
    if (delay === 0) {
      this.updateRestingArrowDimens();
      const listener = new DelayedOnAnimationEndListener(0, onEnd,
        () => this.elapsedTimeSinceEntry, (cb, d) => this.postDelayed(cb, d));
      if (!this.model.addAnimationEndListener(this.model.backgroundWidth, listener)) {
        this.scheduleFailsafe();
      }
    } else {
      this.postDelayed(() => this.playWithBackgroundWidthAnimation(onEnd, 0), delay);
    }
  }

  // ---- Failsafe --------------------------------------------------------

  private scheduleFailsafe(): void {
    this.cancelFailsafe();
    this.failsafeTimer = setTimeout(() => this.updateArrowState(GestureState.GONE, true), FAILSAFE_DELAY_MS) as unknown as number;
  }
  private cancelFailsafe(): void {
    if (this.failsafeTimer !== null) { clearTimeout(this.failsafeTimer); this.failsafeTimer = null; }
  }

  // ---- Haptics (best-effort) ------------------------------------------

  private performActivatedHaptic(): void { this.vibrate(20); }
  private performDeactivatedHaptic(): void { this.vibrate(10); }
  private vibrate(durationMs: number): void {
    // Best-effort haptic — rejects silently if VIBRATE isn't granted or
    // there's no vibrator (e.g. emulator). Never breaks the gesture.
    try {
      vibrator.startVibration(
        { type: 'time', duration: durationMs },
        { id: 0, usage: 'physicalFeedback' },
      ).catch(() => {});
    } catch (e) {
      // ignore
    }
  }
}
