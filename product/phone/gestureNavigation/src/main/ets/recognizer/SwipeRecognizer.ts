//@ts-nocheck
/*
 * Copyright (C) 2018 The Android Open Source Project
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
 * Derivative work: the recogniser and its end-target decision cascade are
 * ported from AOSP Launcher3 Quickstep OtherActivityInputConsumer.java and
 * AbsSwipeUpHandler.java (Copyright (C) 2018 The Android Open Source
 * Project); translated to TypeScript and modified (single-finger,
 * simplified).
 *
 * Bottom-edge swipe recognizer modeled on AOSP Launcher3's Quickstep
 * (packages/apps/Launcher3/quickstep/src/com/android/quickstep/
 * inputconsumers/OtherActivityInputConsumer.java +
 * AbsSwipeUpHandler.java's calculateEndTarget()).
 *
 * Owns no windows. Caller feeds pointer events; recognizer fires:
 *   onTrackingStart  — slop crossed, dock peek-in can begin
 *   onProgress       — incremental drag, with hinted final mode for UI
 *   onCommit         — final target (HOME, RECENTS, or CANCEL)
 *   onReset          — state machine cleared (caller hides transient UI)
 *
 * Quickstep decision cascade (simplified — single-finger only):
 *   1. Cancelled or never crossed slop                       → CANCEL
 *   2. Near-horizontal stroke (≤ overviewMinDegrees)         → CANCEL
 *      (Android would route into quick-switch here; we ignore.)
 *   3. End velocity above fling threshold AND moving up      → HOME
 *   4. Motion-paused during stroke                           → RECENTS
 *   5. Drag distance ≥ minDeltaRecentsVp                     → RECENTS
 *   6. Drag distance ≥ minDeltaHomeVp                        → HOME
 *   7. Otherwise                                             → CANCEL
 *
 * Distances and speeds are in vp / vp-per-ms internally; pointer-event
 * positions come in as px and the recognizer converts using vpToPx.
 */

import { VelocityTracker } from './VelocityTracker';
import { MotionPauseDetector, MotionPauseConfig, DEFAULT_MOTION_PAUSE_CONFIG } from './MotionPauseDetector';

export enum GestureEndTarget {
  CANCEL = 0,
  HOME = 1,
  RECENTS = 2,
}

export type ProgressMode = 'home' | 'recents';

export interface RecognizerConfig {
  vpToPx: number;
  screenHeightPx: number;

  hotZoneVp: number;          // pointer-down must land within this of bottom
  touchSlopVp: number;        // travel before we consider it a gesture
  dockShowAfterVp: number;    // first dock-peek threshold
  minDeltaHomeVp: number;     // travel to qualify for HOME on release
  minDeltaRecentsVp: number;  // travel to qualify for RECENTS without pause
  flingVpPerMs: number;       // up-fling above this commits HOME
  overviewMinDegrees: number; // strokes shallower than this are rejected
  holdMs: number;             // legacy hold timer to commit RECENTS mid-drag
  holdDriftVp: number;        // drift tolerance during hold window
  motionPause: MotionPauseConfig;
}

export interface RecognizerCallbacks {
  onTrackingStart?: (startXPx: number, startYPx: number) => void;
  onProgress?: (
    displacementVp: number,
    mode: ProgressMode,
    lastXPx: number,
    lastYPx: number,
  ) => void;
  onCommit: (target: GestureEndTarget, info: CommitInfo) => void;
  onReset?: () => void;
}

export interface CommitInfo {
  displacementVp: number;
  endVelocityVpPerMs: number;
  paused: boolean;
  elapsedMs: number;
  rejection?: string;
}

enum State {
  IDLE = 0,
  TRACKING_BELOW_SLOP = 1,
  TRACKING_VERTICAL = 2,
  TRACKING_REJECTED = 3,  // near-horizontal — wait for UP to reset, ignore moves
  COMMITTED = 4,
}

interface PointerState {
  id: number;
  startX: number;
  startY: number;
  startTimeMs: number;
  lastX: number;
  lastY: number;
  lastTimeMs: number;
  maxDisplacementVp: number;
  trackingStartFired: boolean;
  dockPeekFired: boolean;
  holdArmedAtY: number;
  holdTimerId: number | null;
}

export class SwipeRecognizer {
  private cfg: RecognizerConfig;
  private cbs: RecognizerCallbacks;
  private state: State = State.IDLE;
  private pointer: PointerState | null = null;
  private velocityY: VelocityTracker = new VelocityTracker(100, 20);
  private speedTracker: VelocityTracker = new VelocityTracker(50, 10);
  private pauseDetector: MotionPauseDetector;

  constructor(cfg: RecognizerConfig, cbs: RecognizerCallbacks) {
    this.cfg = cfg;
    this.cbs = cbs;
    this.pauseDetector = new MotionPauseDetector(cfg.motionPause ?? DEFAULT_MOTION_PAUSE_CONFIG);
  }

  updateConfig(patch: Partial<RecognizerConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  isActive(): boolean {
    return this.state !== State.IDLE;
  }

  /**
   * Pointer DOWN event.
   * Returns true if the recognizer accepted the pointer (i.e. it
   * landed inside the bottom hot-zone and no other gesture is active).
   */
  onPointerDown(pointerId: number, x: number, y: number, timeMs: number): boolean {
    if (this.state !== State.IDLE) {
      // Another finger came down during an active stroke — ignore (Quickstep
      // uses ACTION_POINTER_DOWN handling here; for single-finger recents
      // gesture, additional pointers can be ignored without breaking the
      // primary tracking.)
      return false;
    }
    const hotZonePx = this.cfg.hotZoneVp * this.cfg.vpToPx;
    if (this.cfg.screenHeightPx <= 0 || y < this.cfg.screenHeightPx - hotZonePx) {
      return false;
    }
    this.pointer = {
      id: pointerId,
      startX: x,
      startY: y,
      startTimeMs: timeMs,
      lastX: x,
      lastY: y,
      lastTimeMs: timeMs,
      maxDisplacementVp: 0,
      trackingStartFired: false,
      dockPeekFired: false,
      holdArmedAtY: -1,
      holdTimerId: null,
    };
    this.velocityY.reset();
    this.speedTracker.reset();
    this.pauseDetector.reset();
    this.velocityY.addMovement(timeMs, y);
    this.speedTracker.addMovement(timeMs, y);
    this.state = State.TRACKING_BELOW_SLOP;
    return true;
  }

  /**
   * Pointer MOVE event for the gesture-owning pointer.
   * Ignored for non-owning pointer IDs or when the recognizer is not
   * tracking anything.
   */
  onPointerMove(pointerId: number, x: number, y: number, timeMs: number): void {
    const p = this.pointer;
    if (!p || p.id !== pointerId) return;
    if (this.state === State.COMMITTED || this.state === State.IDLE) return;
    if (this.state === State.TRACKING_REJECTED) return;

    p.lastX = x;
    p.lastY = y;
    p.lastTimeMs = timeMs;
    this.velocityY.addMovement(timeMs, y);
    this.speedTracker.addMovement(timeMs, y);

    const deltaPx = p.startY - y;
    if (deltaPx <= 0) return;
    const deltaVp = deltaPx / this.cfg.vpToPx;
    if (deltaVp > p.maxDisplacementVp) p.maxDisplacementVp = deltaVp;

    if (this.state === State.TRACKING_BELOW_SLOP) {
      // Have we moved enough to commit to "this is a gesture" at all?
      if (deltaVp < this.cfg.touchSlopVp) return;

      // Angle gate: if the stroke is too shallow, refuse the gesture and
      // wait for UP. Quickstep would hand off to the quick-switch consumer
      // here; we just bail so the foreground app keeps the touch.
      const horizPx = Math.abs(x - p.startX);
      const angleDeg = Math.atan2(deltaPx, Math.max(horizPx, 1)) * (180 / Math.PI);
      if (angleDeg < this.cfg.overviewMinDegrees) {
        this.state = State.TRACKING_REJECTED;
        return;
      }
      this.state = State.TRACKING_VERTICAL;
      p.trackingStartFired = true;
      this.cbs.onTrackingStart?.(p.startX, p.startY);
    }

    // We're TRACKING_VERTICAL now. Drive dock peek-in and motion-pause.
    if (deltaVp >= this.cfg.dockShowAfterVp) {
      if (!p.dockPeekFired) p.dockPeekFired = true;
      const mode: ProgressMode = deltaVp >= this.cfg.minDeltaRecentsVp ? 'recents' : 'home';
      this.cbs.onProgress?.(deltaVp, mode, x, y);
    }

    const speedVpPerMs = Math.abs(this.speedTracker.computeCurrentVelocity()) / this.cfg.vpToPx;
    this.pauseDetector.addPosition(timeMs, speedVpPerMs, deltaVp);

    // Legacy hold-to-recents: if user reaches RECENTS distance and holds
    // (drift below tolerance) for HOLD_MS, commit immediately. This
    // pre-dates motion-pause detection in the codebase but is harmless —
    // motion-pause will fire on the same gesture, so worst case is we
    // commit slightly earlier. Kept as a deliberate redundancy.
    if (deltaVp >= this.cfg.minDeltaRecentsVp && p.holdTimerId === null) {
      p.holdArmedAtY = y;
      p.holdTimerId = setTimeout(() => {
        const cur = this.pointer;
        if (!cur || cur.id !== pointerId || this.state !== State.TRACKING_VERTICAL) return;
        const driftVp = Math.abs(cur.lastY - p.holdArmedAtY) / this.cfg.vpToPx;
        if (driftVp < this.cfg.holdDriftVp) {
          this.commit(GestureEndTarget.RECENTS, { reason: 'hold-timer' });
        } else {
          cur.holdTimerId = null;
        }
      }, this.cfg.holdMs);
    }
  }

  /**
   * Pointer UP / CANCEL event.
   */
  onPointerEnd(pointerId: number, x: number, y: number, timeMs: number, canceled: boolean): void {
    const p = this.pointer;
    if (!p || p.id !== pointerId) return;

    if (canceled) {
      this.commit(GestureEndTarget.CANCEL, { reason: 'canceled' });
      return;
    }
    if (this.state === State.TRACKING_REJECTED) {
      // Stroke never qualified — silent cancel.
      this.commit(GestureEndTarget.CANCEL, { reason: 'rejected-angle' });
      return;
    }
    if (this.state === State.TRACKING_BELOW_SLOP) {
      this.commit(GestureEndTarget.CANCEL, { reason: 'below-slop' });
      return;
    }
    if (this.state !== State.TRACKING_VERTICAL) {
      // Already committed (hold timer fired). Nothing to do.
      this.resetInternal();
      return;
    }

    this.velocityY.addMovement(timeMs, y);
    const deltaPx = p.startY - y;
    const deltaVp = Math.max(deltaPx / this.cfg.vpToPx, 0);
    const elapsedMs = Math.max(timeMs - p.startTimeMs, 1);

    // Velocity in vp/ms. velocityY tracks raw Y (px); upward motion makes
    // dy/dt negative, so flip sign and convert.
    const yVelPxPerMs = this.velocityY.computeCurrentVelocity();
    const upVelVpPerMs = -yVelPxPerMs / this.cfg.vpToPx;
    const paused = this.pauseDetector.isPaused();

    const target = this.calculateEndTarget(deltaVp, upVelVpPerMs, paused);
    this.commit(target, {
      reason: target === GestureEndTarget.CANCEL ? 'no-criteria' : undefined,
      endVelocityVpPerMs: upVelVpPerMs,
      paused,
      elapsedMs,
      displacementVp: deltaVp,
    });
  }

  private calculateEndTarget(deltaVp: number, upVelVpPerMs: number, paused: boolean): GestureEndTarget {
    if (upVelVpPerMs >= this.cfg.flingVpPerMs && deltaVp >= this.cfg.touchSlopVp) {
      // Quickstep: fast upward fling → HOME regardless of pause state.
      return GestureEndTarget.HOME;
    }
    if (paused) {
      // Motion-pause is sticky: even if the user releases at a short
      // distance, having paused mid-stroke commits to Recents.
      return GestureEndTarget.RECENTS;
    }
    if (deltaVp >= this.cfg.minDeltaRecentsVp) {
      return GestureEndTarget.RECENTS;
    }
    if (deltaVp >= this.cfg.minDeltaHomeVp) {
      return GestureEndTarget.HOME;
    }
    return GestureEndTarget.CANCEL;
  }

  private commit(target: GestureEndTarget, extras: Partial<CommitInfo> & { reason?: string }): void {
    if (this.state === State.COMMITTED) return;
    const p = this.pointer;
    if (p && p.holdTimerId !== null) {
      clearTimeout(p.holdTimerId);
      p.holdTimerId = null;
    }
    const info: CommitInfo = {
      displacementVp: extras.displacementVp ?? (p ? (p.startY - p.lastY) / this.cfg.vpToPx : 0),
      endVelocityVpPerMs: extras.endVelocityVpPerMs ?? 0,
      paused: extras.paused ?? this.pauseDetector.isPaused(),
      elapsedMs: extras.elapsedMs ?? 0,
      rejection: extras.reason,
    };
    this.state = State.COMMITTED;
    this.cbs.onCommit(target, info);
    this.resetInternal();
  }

  private resetInternal(): void {
    const hadPointer = this.pointer !== null;
    this.pointer = null;
    this.velocityY.reset();
    this.speedTracker.reset();
    this.pauseDetector.reset();
    this.state = State.IDLE;
    if (hadPointer) this.cbs.onReset?.();
  }
}
