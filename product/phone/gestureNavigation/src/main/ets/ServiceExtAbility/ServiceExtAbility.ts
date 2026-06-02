//@ts-nocheck
/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Bottom-edge gesture-navigation host. Owns the home-indicator bar
 * (always shown while gesture nav is the active nav mode) and the
 * OniroDragOverlay window (which doubles as the Quickstep-style
 * Overview surface on RECENTS commit); delegates all swipe recognition
 * to SwipeRecognizer (a port of AOSP Launcher3 Quickstep).
 *
 * Quickstep parity work lives in ./recognizer/ — this file only wires
 * inputMonitor events into the recognizer and translates its callbacks
 * into window operations.
 */

import ServiceExtension from '@ohos.app.ability.ServiceExtensionAbility';
import abilityManager from '@ohos.app.ability.abilityManager';
import inputMonitor from '@ohos.multimodalInput.inputMonitor';
import inputEventClient from '@ohos.multimodalInput.inputEventClient';
import display from '@ohos.display';
import window from '@ohos.window';
import settings from '@ohos.settings';
import data_dataShare from '@ohos.data.dataShare';
import Log from '../../../../../../../common/src/main/ets/default/Log';
import Constants from '../../../../../../../common/src/main/ets/default/Constants';
import { BackPanelController, GestureState } from '../back/BackPanelController';
import {
  SwipeRecognizer,
  GestureEndTarget,
  RecognizerConfig,
  CommitInfo,
  ProgressMode,
} from '../recognizer/SwipeRecognizer';
import { DEFAULT_MOTION_PAUSE_CONFIG } from '../recognizer/MotionPauseDetector';
import { SnapshotCapture } from '../animation/SnapshotCapture';
import { DragController } from '../animation/DragController';
import { WallpaperCache } from '../animation/WallpaperCache';
import { RecentsLoader } from '../animation/RecentsLoader';

const TAG = 'GestureNavigation_ServiceExtAbility';

// Hot-zone, dock, and commit thresholds. The values below come from two
// sources:
//   * HOT_ZONE_VP / dock geometry / 800 vp·s legacy fling: original
//     reverse-engineered values from sceneboard_disasm/FINDINGS.md §C and
//     harmony-port-work/PLAN.md §4 (HarmonyOS StyleConstants defaults).
//   * TOUCH_SLOP_VP / FLING_VP_PER_MS / motion-pause band: AOSP Launcher3
//     Quickstep dimens (motion_pause_detector_speed_slow = 0.15 dp/ms,
//     quickstep_fling_threshold_speed = 0.5 dp/ms,
//     motion_pause_detector_min_displacement_from_app = 36 dp).
const HOT_ZONE_VP = 32;
const TOUCH_SLOP_VP = 12;            // 8 dp default × 1.414 quickstep nav-mode factor
const DOCK_SHOW_AFTER_VP = 16;
const MIN_DELTA_HOME_VP = 120;       // minimum drag to commit HOME on release
const MIN_DELTA_RECENTS_VP = 200;    // minimum drag to commit RECENTS on release
const FLING_VP_PER_MS = 0.5;         // upward fling above this commits HOME
const OVERVIEW_MIN_DEGREES = 15;     // shallower strokes are rejected
const HOLD_MS = 250;                 // legacy hold-to-recents timer
const HOLD_DRIFT_VP = 24;
const DOCK_WIDTH_VP = 140;
const DOCK_HEIGHT_VP = 24;
const DOCK_BOTTOM_INSET_VP = 4;

// Side-edge BACK gesture: a DOWN within this many vp of the left or
// right screen edge (and NOT in the bottom HOME/RECENTS hot zone) starts
// a back gesture. AOSP config_backGestureInset default = 30dp.
const BACK_EDGE_WIDTH_VP = 30;
// keyCode for BACK (@ohos.multimodalInput.keyCode KEYCODE_BACK).
const KEYCODE_BACK = 2;

// The side-edge BACK gesture is suppressed while the launcher (home
// screen) is the foreground app: there's nothing to navigate "back" to on
// the home screen, and a side swipe there should reach the launcher
// untouched (e.g. its own page switching).
const LAUNCHER_BUNDLE = 'com.ohos.launcher';
// Throttle for the self-healing getTopAbility() re-query on touch DOWN.
const FG_CHECK_THROTTLE_MS = 1500;

const NAV_MODE_GESTURE = '0';
const NAV_MODE_URI =
  'datashare:///com.ohos.settingsdata/entry/settingsdata/SETTINGSDATA?Proxy=true&key=' +
  Constants.KEY_NAVIGATIONBAR_STATUS;

const APP_KEY_DOCK_VISIBLE = 'OniroDockVisible';
// Written by phone_dropdownpanel/pages/index.ets when the panel becomes
// visible / hides. Read here to suppress bottom-edge gestures while the
// dropdown is interactive (otherwise our HOME/RECENTS commit fights the
// panel's own swipe-up-to-close PanGesture). systemui HAPs share a
// process (same bundle, no per-module process attr — proven by the
// statusbar↔dropdown LocalEvent path) so AppStorage bridges them.
const APP_KEY_DROPDOWN_PANEL_OPEN = 'OniroDropdownPanelOpen';

// Touch action codes per @ohos.multimodalInput.touchEvent.Action
const TOUCH_CANCEL = 0;
const TOUCH_DOWN = 1;
const TOUCH_MOVE = 2;
const TOUCH_UP = 3;

// Mouse action codes per @ohos.multimodalInput.mouseEvent.Action
const MOUSE_CANCEL = 0;
const MOUSE_MOVE = 1;
const MOUSE_BUTTON_DOWN = 2;
const MOUSE_BUTTON_UP = 3;
const MOUSE_BUTTON_LEFT = 0;

// Mouse events don't carry a pointer ID. Use a synthetic one that can't
// collide with any real touch pointer (touch IDs are small, starting at 0).
const MOUSE_POINTER_ID = 1000;

enum PanGestureType {
  DEFAULT = 0,
  GAME_OPERATE = 1,
}

class GestureNavigationServiceExtAbility extends ServiceExtension {
  private screenHeightPx = 0;
  private screenWidthPx = 0;
  private vpToPx = 1;

  private recognizer: SwipeRecognizer | null = null;

  private touchReceiver = (ev) => this.handleTouch(ev);
  private mouseReceiver = (ev) => this.handleMouse(ev);
  private monitorActive = false;
  private mouseButtonDown = false;
  // Per AOSP InputConsumer semantics: once we accept a DOWN in the
  // bottom hot zone, every subsequent MOVE/UP for that pointer is also
  // consumed (return true from inputMonitor) so the foreground app
  // doesn't see half a touch stream — even if the recognizer later
  // rejects the gesture (TRACKING_REJECTED). Reset to null on UP /
  // CANCEL. Single-pointer model: only one consumed pointer at a time.
  private consumingPointerId: number | null = null;

  private dockWindow: window.Window | null = null;

  // Side-edge BACK gesture. Owns its own fullscreen overlay window
  // (the arrow Canvas) and a BackPanelController (state machine + spring
  // physics, a port of AOSP BackPanelController.kt). Routed entirely
  // separately from the bottom HOME/RECENTS recognizer; the two own
  // disjoint hot zones (side edges vs bottom edge) so a pointer belongs
  // to exactly one of them for its whole lifetime.
  private backController: BackPanelController | null = null;
  private backWindow: window.Window | null = null;
  private backPointerId: number | null = null;
  // Deferred pilfer: a side-edge DOWN starts TRACKING the pointer but is
  // NOT consumed (inputMonitor returns false) until the controller leaves
  // GONE — i.e. horizontal slop is crossed and it's a confirmed back-swipe.
  // Until then the touch falls through to the foreground app so taps on
  // edge-anchored UI (e.g. the leftmost/rightmost keyboard keys, which sit
  // inside the 30vp BACK strip) are not swallowed. AOSP achieves the same
  // with InputMonitor.pilferPointers(); OHOS's touch monitor has no such
  // call (return-bool is the only lever), so on a real swipe the app sees a
  // benign half-stream (DOWN + sub-slop MOVEs, no UP) — keyboards commit on
  // UP, which we then own, so no stray character is typed.
  private backPilfered = false;

  // Cached "is the launcher the current foreground app" flag, read
  // synchronously at touch-DOWN to gate the side-edge BACK gesture. The
  // launcher is NOT a normal mission on this platform (it lives in a
  // separate, empty LAUNCHER mission list that getMissionInfos never
  // reports), so the foreground app is read via abilityManager.getTopAbility()
  // (systemapi, no permission needed). Kept fresh reactively by WMS's
  // systemBarTintChange event (fires on foreground-window changes), plus a
  // throttled re-query on touch DOWN as a self-healing fallback.
  private foregroundIsLauncher = false;
  private tintChangeCb = (_state) => this.refreshForegroundIsLauncher();
  private lastForegroundCheckMs = 0;

  private dragWindow: window.Window | null = null;
  private dragShown = false;
  private snapshotCapture: SnapshotCapture = new SnapshotCapture();
  private dragController: DragController | null = null;
  private wallpaperCache: WallpaperCache = new WallpaperCache();
  private recentsLoader: RecentsLoader = new RecentsLoader();
  // True from onCommit until the post-spring teardown completes —
  // suppresses the synchronous onReset path so the spring runs to
  // settle instead of being short-circuited.
  private commitAnimating = false;
  // True from the moment a RECENTS commit's spring settles until the
  // user taps somewhere (recents card / foreground card / backdrop) —
  // the drag overlay is "live" as the Overview surface. We poll the
  // OniroDragVisible flag (DragOverlay flips it on dismiss) to spot
  // the transition back to idle so we can revert the window to
  // non-touchable for the next gesture.
  private inRecentsMode = false;

  private dataShareHelper: data_dataShare.DataShareHelper | null = null;
  private navMode: string = '1';

  onCreate(want): void {
    Log.showInfo(TAG, 'onCreate');
    try {
      const d = display.getDefaultDisplaySync();
      this.screenHeightPx = d.height;
      this.screenWidthPx = d.width;
      this.vpToPx = d.densityPixels;
      Log.showInfo(TAG, `display ${d.width}x${d.height} densityPx=${d.densityPixels}`);
    } catch (err) {
      Log.showError(TAG, `getDefaultDisplaySync failed: ${JSON.stringify(err)}`);
    }
    this.dragController = new DragController({
      vpToPx: this.vpToPx,
      screenWidthPx: this.screenWidthPx,
      screenHeightPx: this.screenHeightPx,
    });
    // Wallpaper is best-effort. If the fetch fails the wallpaper layer
    // in DragOverlay.ets just doesn't paint (it's gated on the
    // wallpaper PixelMap); the snap + dim + cards still render normally.
    this.wallpaperCache.load();
    this.recognizer = this.buildRecognizer();
    this.backController = new BackPanelController(
      {
        vpToPx: this.vpToPx,
        screenWidthPx: this.screenWidthPx,
        screenHeightPx: this.screenHeightPx,
      },
      { triggerBack: () => this.triggerBack() },
    );
    this.initDockWindow();
    this.initDragWindow();
    this.initBackWindow();
    this.initNavModeSubscription();
    this.initForegroundTracking();
    // windowAnimationManager.setController() is registered from
    // DragOverlay's aboutToAppear instead — registering from a
    // ServiceExtensionAbility's onCreate crashes at the first
    // onScreenUnlock with SIGSEGV in libace_napi.z.so. The napi env
    // captured at setController-time must belong to a UI context
    // (mirrors launcher's RemoteWindowWrapper.aboutToAppear).
  }

  /**
   * Called at the start of every gesture (slop crossed). If the
   * previous gesture's RECENTS-commit overlay is still up — either
   * because the user is re-swiping without dismissing, or because
   * they've already tapped a card and we just haven't completed the
   * dismiss cleanup yet — drive it to clean state before the new
   * gesture proceeds. Flips the window back to non-touchable so the
   * recogniser keeps receiving raw touch events (inputMonitor sees
   * them either way, but a touchable=true overlay would also let
   * stray onClick handlers fire).
   */
  private resetOverlayForGesture(): void {
    if (this.dragWindow && (this.inRecentsMode || this.dragShown)) {
      this.dragWindow.setWindowFocusable(false).catch((e) => {
        Log.showWarn(TAG, `pre-gesture setFocusable failed: ${JSON.stringify(e)}`);
      });
      this.dragWindow.setWindowTouchable(false).catch((e) => {
        Log.showWarn(TAG, `pre-gesture setTouchable failed: ${JSON.stringify(e)}`);
      });
    }
    this.inRecentsMode = false;
    this.dragShown = false;
  }

  onDestroy(): void {
    Log.showInfo(TAG, 'onDestroy');
    this.stopMonitor();
    this.dataShareHelper?.off('dataChange', NAV_MODE_URI);
    this.dataShareHelper = null;
    if (this.dockWindow) {
      this.dockWindow.destroyWindow().catch((e) => {
        Log.showWarn(TAG, `destroy dock failed: ${JSON.stringify(e)}`);
      });
      this.dockWindow = null;
    }
    if (this.dragWindow) {
      this.dragWindow.destroyWindow().catch((e) => {
        Log.showWarn(TAG, `destroy drag failed: ${JSON.stringify(e)}`);
      });
      this.dragWindow = null;
    }
    if (this.backController) {
      this.backController.destroy();
      this.backController = null;
    }
    if (this.backWindow) {
      this.backWindow.destroyWindow().catch((e) => {
        Log.showWarn(TAG, `destroy back failed: ${JSON.stringify(e)}`);
      });
      this.backWindow = null;
    }
    try {
      window.off('systemBarTintChange', this.tintChangeCb);
    } catch (e) {
      Log.showWarn(TAG, `systemBarTintChange off failed: ${JSON.stringify(e)}`);
    }
    this.wallpaperCache.stop();
    this.snapshotCapture.clear();
  }

  onRequest(_want, startId): void {
    Log.showInfo(TAG, `onRequest startId=${startId}`);
  }

  // ---- Recognizer wiring ------------------------------------------------

  private buildRecognizer(): SwipeRecognizer {
    const cfg: RecognizerConfig = {
      vpToPx: this.vpToPx,
      screenHeightPx: this.screenHeightPx,
      hotZoneVp: HOT_ZONE_VP,
      touchSlopVp: TOUCH_SLOP_VP,
      dockShowAfterVp: DOCK_SHOW_AFTER_VP,
      minDeltaHomeVp: MIN_DELTA_HOME_VP,
      minDeltaRecentsVp: MIN_DELTA_RECENTS_VP,
      flingVpPerMs: FLING_VP_PER_MS,
      overviewMinDegrees: OVERVIEW_MIN_DEGREES,
      holdMs: HOLD_MS,
      holdDriftVp: HOLD_DRIFT_VP,
      motionPause: DEFAULT_MOTION_PAUSE_CONFIG,
    };
    return new SwipeRecognizer(cfg, {
      onTrackingStart: (_sx: number, _sy: number) => {
        Log.showDebug(TAG, 'recognizer: tracking start (slop passed)');
        this.resetOverlayForGesture();
        this.dragController?.start();
        // Kick off the recents fetch IN PARALLEL with the snapshot
        // — both can take 100-300 ms but the snapshot blocks the
        // overlay-show. Once recents resolve, push the count into
        // the controller so the row width / scale anchor refresh.
        this.recentsLoader.load().then(() => {
          this.dragController?.setRecentsCount(this.recentsLoader.count());
        });
        // Show the overlay only after the snapshot is ready — every
        // DragOverlay layer is gated on `visible && snap`, so flipping
        // visible earlier (e.g. inside dragController.start) would
        // still need a non-null snap to paint anything. Deferring the
        // show to here also dodges a one-frame flash from layers that
        // would otherwise be live while Image(snap)'s GPU texture is
        // still uploading. Capture is ~45 ms warm, ~700 ms first-call.
        this.snapshotCapture.capture(this.screenWidthPx, this.screenHeightPx)
          .then((elapsed) => {
            if (elapsed < 0) return;          // capture failed
            if (!this.recognizer?.isActive()) return; // gesture already over
            this.showDragOverlay();
          });
      },
      onProgress: (deltaVp: number, _mode: ProgressMode, lastX: number, lastY: number) => {
        this.dragController?.onProgress(deltaVp, lastX, lastY);
      },
      onCommit: (target: GestureEndTarget, info: CommitInfo) => {
        this.handleCommit(target, info);
      },
      onReset: () => {
        // If commitAnimating, the spring is mid-flight and will tear
        // down the overlay itself in its onComplete. The home-indicator
        // dock stays visible across gestures — it only hides when
        // nav-mode switches away from gesture.
        if (!this.commitAnimating) {
          this.dragController?.reset();
          this.hideDragOverlay();
          this.snapshotCapture.clear();
        }
      },
    });
  }

  // ---- Nav-mode subscription -------------------------------------------

  private initNavModeSubscription(): void {
    this.refreshNavMode();
    data_dataShare.createDataShareHelper(this.context, NAV_MODE_URI)
      .then((helper) => {
        this.dataShareHelper = helper;
        helper.on('dataChange', NAV_MODE_URI, () => this.refreshNavMode());
      })
      .catch((e) => {
        Log.showError(TAG, `dataShareHelper failed: ${JSON.stringify(e)}`);
      });
  }

  private refreshNavMode(): void {
    let raw = '1';
    try {
      raw = settings.getValueSync(this.context, Constants.KEY_NAVIGATIONBAR_STATUS, '1');
    } catch (e) {
      Log.showWarn(TAG, `getValueSync failed: ${JSON.stringify(e)}`);
    }
    if (raw !== this.navMode) {
      Log.showInfo(TAG, `navMode changed -> ${raw}`);
      this.navMode = raw;
    }
    const gesture = this.navMode === NAV_MODE_GESTURE;
    if (gesture) {
      this.startMonitor();
    } else {
      this.stopMonitor();
    }
    AppStorage.SetOrCreate(APP_KEY_DOCK_VISIBLE, gesture);
  }

  // ---- Foreground-app (launcher) tracking ------------------------------

  /**
   * Subscribe to WMS's systemBarTintChange (fires when the foreground
   * window changes — the launcher and apps apply different system-bar
   * styles) and do an initial foreground read. systemui's TintStateManager
   * already relies on this same event for status-bar tinting.
   */
  private initForegroundTracking(): void {
    try {
      window.on('systemBarTintChange', this.tintChangeCb);
      Log.showInfo(TAG, 'systemBarTintChange subscribed (launcher tracking)');
    } catch (e) {
      Log.showError(TAG, `systemBarTintChange subscribe failed: ${JSON.stringify(e)}`);
    }
    this.refreshForegroundIsLauncher();
  }

  /**
   * Re-read the foreground (top) ability and cache whether it's the
   * launcher. getTopAbility() returns the real top ability's ElementName
   * regardless of mission-list type, so it sees the launcher (which is not
   * a queryable mission). Only logs on a state change.
   */
  private refreshForegroundIsLauncher(): void {
    this.lastForegroundCheckMs = Date.now();
    abilityManager.getTopAbility().then((top) => {
      const b: string = top?.bundleName ?? '';
      const isLauncher = b === LAUNCHER_BUNDLE;
      if (isLauncher !== this.foregroundIsLauncher) {
        this.foregroundIsLauncher = isLauncher;
        Log.showInfo(TAG, `foregroundIsLauncher -> ${isLauncher} (top=${b})`);
      }
    }).catch((e) => {
      Log.showWarn(TAG, `getTopAbility failed: ${JSON.stringify(e)}`);
    });
  }

  // ---- Input monitor ---------------------------------------------------

  private startMonitor(): void {
    if (this.monitorActive) return;
    try {
      inputMonitor.on('touch', this.touchReceiver);
      // Mouse channel is mandatory on the x86_64 emulator (no touchscreen
      // device exists) and harmless on real phones.
      inputMonitor.on('mouse', this.mouseReceiver);
      this.monitorActive = true;
      Log.showInfo(TAG, 'inputMonitor registered (touch + mouse)');
    } catch (err) {
      Log.showError(TAG, `inputMonitor.on failed: ${JSON.stringify(err)}`);
    }
  }

  private stopMonitor(): void {
    if (!this.monitorActive) return;
    try {
      inputMonitor.off('touch', this.touchReceiver);
    } catch (err) {
      Log.showWarn(TAG, `inputMonitor.off(touch) failed: ${JSON.stringify(err)}`);
    }
    try {
      inputMonitor.off('mouse', this.mouseReceiver);
    } catch (err) {
      Log.showWarn(TAG, `inputMonitor.off(mouse) failed: ${JSON.stringify(err)}`);
    }
    Log.showInfo(TAG, 'inputMonitor unregistered');
    this.monitorActive = false;
    this.mouseButtonDown = false;
    // Recognizer is allowed to keep its state until natural end.
  }

  // ---- Touch / mouse handling -----------------------------------------

  private handleTouch(ev): boolean {
    const t = ev?.touch;
    if (!t) return false;
    const id = (t.id ?? 0) | 0;
    const x = t.screenX ?? 0;
    const y = t.screenY ?? 0;
    const timeMs = (ev.actionTime ?? 0) / 1000;
    return this.dispatch(ev.action, id, x, y, timeMs);
  }

  // Mouse drag mapped to touch: BUTTON_DOWN starts a stroke, MOVE updates,
  // BUTTON_UP / CANCEL ends. Only the left button qualifies.
  private handleMouse(ev): boolean {
    const action = ev?.action;
    const x = ev?.screenX ?? 0;
    const y = ev?.screenY;
    const timeMs = (ev?.actionTime ?? 0) / 1000;
    if (action === undefined || y === undefined) return false;
    if (action === MOUSE_BUTTON_DOWN) {
      if ((ev.button ?? MOUSE_BUTTON_LEFT) !== MOUSE_BUTTON_LEFT) return false;
      this.mouseButtonDown = true;
      return this.dispatch(TOUCH_DOWN, MOUSE_POINTER_ID, x, y, timeMs);
    }
    if (action === MOUSE_MOVE && this.mouseButtonDown) {
      return this.dispatch(TOUCH_MOVE, MOUSE_POINTER_ID, x, y, timeMs);
    }
    if (action === MOUSE_BUTTON_UP || action === MOUSE_CANCEL) {
      if (!this.mouseButtonDown) return false;
      this.mouseButtonDown = false;
      const mapped = action === MOUSE_CANCEL ? TOUCH_CANCEL : TOUCH_UP;
      return this.dispatch(mapped, MOUSE_POINTER_ID, x, y, timeMs);
    }
    return false;
  }

  private dispatch(action: number, id: number, x: number, y: number, timeMs: number): boolean {
    const r = this.recognizer;
    if (!r) return false;
    if (this.checkAndSetPerationType() === PanGestureType.GAME_OPERATE) return false;

    if (action === TOUCH_DOWN) {
      // Self-healing fallback for the launcher flag: if systemBarTintChange
      // ever missed a foreground transition, re-query here (throttled).
      // Async, so it corrects the NEXT gesture — the reactive event +
      // goHome() optimistic set cover the immediate case.
      if (Date.now() - this.lastForegroundCheckMs > FG_CHECK_THROTTLE_MS) {
        this.refreshForegroundIsLauncher();
      }
      // Side-edge BACK takes priority on the left/right edge strips, but
      // only ABOVE the bottom HOME/RECENTS hot zone so the bottom-corner
      // overlap stays with the home gesture, and NOT while the launcher
      // (home screen) is foreground — there's nothing to go back to there,
      // and the swipe should reach the launcher untouched. A DOWN here only
      // TRACKS the pointer; consuming is deferred until the swipe is
      // confirmed (see backPilfered / TOUCH_MOVE below), so a tap on an
      // edge-anchored target like a keyboard key still reaches the app.
      const inBottomHotZone =
        this.screenHeightPx > 0 && y >= this.screenHeightPx - HOT_ZONE_VP * this.vpToPx;
      // Single-pointer: ignore a second finger while a back gesture (or a
      // bottom gesture) already owns a pointer.
      if (!inBottomHotZone && !this.foregroundIsLauncher && this.backController &&
          this.backPointerId === null && this.consumingPointerId === null) {
        const edgePx = BACK_EDGE_WIDTH_VP * this.vpToPx;
        let isLeft: boolean | null = null;
        if (x <= edgePx) isLeft = true;
        else if (x >= this.screenWidthPx - edgePx) isLeft = false;
        if (isLeft !== null) {
          this.backController.onPointerDown(x / this.vpToPx, y / this.vpToPx, timeMs, isLeft);
          this.backPointerId = id;
          this.backPilfered = false; // not consuming yet — wait for slop
          return false;              // let the app/keyboard see the DOWN
        }
      }

      // Defer to the dropdown panel when it's interactive — otherwise our
      // bottom-edge commit fights the panel's own swipe-up-to-close
      // PanGesture, and the panel can't be dismissed by swiping up.
      if (AppStorage.Get<boolean>(APP_KEY_DROPDOWN_PANEL_OPEN) === true) {
        return false;
      }
      const accepted = r.onPointerDown(id, x, y, timeMs);
      if (accepted) {
        // Pilfer: prevent the foreground app from seeing the DOWN +
        // subsequent stream. Returning true from inputMonitor's
        // TouchEventReceiver consumes the event (see
        // @ohos.multimodalInput.inputMonitor.d.ts line 39-49). Without
        // this, scrollable apps like Settings consume the same swipe
        // and scroll while our gesture also runs.
        this.consumingPointerId = id;
        return true;
      }
      return false;
    }

    if (action === TOUCH_MOVE) {
      if (this.backPointerId === id && this.backController) {
        this.backController.onPointerMove(x / this.vpToPx, y / this.vpToPx, timeMs);
        // Deferred pilfer: the controller leaves GONE only once horizontal
        // slop (EDGE_SLOP_VP) is crossed — a confirmed back-swipe, not a tap
        // or a vertical scroll. From that point on we own the stream.
        if (!this.backPilfered && this.backController.currentState !== GestureState.GONE) {
          this.backPilfered = true;
        }
        return this.backPilfered;
      }
      if (this.consumingPointerId === id) {
        r.onPointerMove(id, x, y, timeMs);
        return true;
      }
      return false;
    }

    if (action === TOUCH_UP || action === TOUCH_CANCEL) {
      if (this.backPointerId === id && this.backController) {
        this.backController.onPointerEnd(
          x / this.vpToPx, y / this.vpToPx, timeMs, action === TOUCH_CANCEL);
        const consumed = this.backPilfered;
        this.backPointerId = null;
        this.backPilfered = false;
        // A tap (never pilfered) returns false so the app sees the UP and
        // the key registers; a confirmed swipe returns true (we owned it).
        return consumed;
      }
      if (this.consumingPointerId === id) {
        r.onPointerEnd(id, x, y, timeMs, action === TOUCH_CANCEL);
        this.consumingPointerId = null;
        return true;
      }
      return false;
    }

    return false;
  }

  // ---- Commit dispatch -------------------------------------------------

  private handleCommit(target: GestureEndTarget, info: CommitInfo): void {
    Log.showInfo(TAG,
      `commit target=${GestureEndTarget[target]} deltaVp=${info.displacementVp.toFixed(1)} ` +
      `vVp/ms=${info.endVelocityVpPerMs.toFixed(3)} paused=${info.paused} ` +
      `elapsed=${info.elapsedMs.toFixed(0)}ms` +
      (info.rejection ? ` rejection=${info.rejection}` : ''));
    // If the drag overlay never came up (gesture rejected pre-slop,
    // or capture+show never raced in), there's no spring to run.
    // HOME still needs the structural commit; RECENTS without an
    // overlay is a no-op (would just open an empty Overview which
    // is worse than doing nothing).
    if (!this.dragShown || !this.dragController) {
      if (target === GestureEndTarget.HOME) {
        this.goHome();
      }
      this.recentsLoader.clear();
      return;
    }
    this.commitAnimating = true;
    const teardown = (): void => {
      this.dragController?.reset();
      this.hideDragOverlay();
      this.snapshotCapture.clear();
      this.recentsLoader.clear();
      this.commitAnimating = false;
    };
    // HOME: kick off the launcher launch IN PARALLEL with our
    // shrink-spring instead of after. OHOS's WMS launch animation on
    // com.ohos.launcher isn't suppressible from a non-system-bundle
    // caller — see DragOverlay.activateMission for the same reasoning.
    // By starting the launcher at spring t=0, the system's launch
    // animation runs underneath our overlay while we shrink; by spring
    // end the launcher is settled and we just tear down. Without this
    // the user saw two sequential animations: our shrink-to-dot, then
    // the launcher's expand-to-fullscreen.
    if (target === GestureEndTarget.HOME) {
      this.goHome();
    }
    this.dragController.commit(target, () => {
      // Spring settled. RECENTS keeps the overlay LIVE as the
      // Overview surface (flip touchable+focusable + watch for
      // user dismissal). HOME / CANCEL tear down immediately —
      // the structural commit already fired above.
      if (target === GestureEndTarget.RECENTS) {
        this.enterRecentsMode();
      } else {
        teardown();
      }
    });
  }

  /**
   * Spring has settled in the Overview pose. Flip the drag window
   * touchable + focusable so the user can interact with the cards,
   * and start polling for the dismiss signal (DragOverlay sets
   * OniroDragVisible=false when the user taps anywhere).
   */
  private enterRecentsMode(): void {
    Log.showInfo(TAG, 'enterRecentsMode');
    this.inRecentsMode = true;
    this.commitAnimating = false;
    if (this.dragWindow) {
      this.dragWindow.setWindowFocusable(true).catch((e) => {
        Log.showWarn(TAG, `recents setFocusable failed: ${JSON.stringify(e)}`);
      });
      this.dragWindow.setWindowTouchable(true).catch((e) => {
        Log.showWarn(TAG, `recents setTouchable failed: ${JSON.stringify(e)}`);
      });
    }
    this.pollForOverlayDismiss();
  }

  /**
   * Poll OniroDragVisible every 80 ms while in recents mode. Once
   * the overlay flips it to false (any tap inside DragOverlay), tear
   * down: revert window touchable, release the snapshot + recents
   * PixelMaps, and clear any controller state.
   */
  private pollForOverlayDismiss(): void {
    const check = (): void => {
      if (!this.inRecentsMode) return;
      const visible = AppStorage.Get<boolean>('OniroDragVisible');
      if (visible === false) {
        Log.showInfo(TAG, 'overlay dismissed by user — cleaning up');
        if (this.dragWindow) {
          this.dragWindow.setWindowFocusable(false).catch(() => {});
          this.dragWindow.setWindowTouchable(false).catch(() => {});
        }
        this.dragShown = false;
        this.inRecentsMode = false;
        this.dragController?.reset();
        this.snapshotCapture.clear();
        this.recentsLoader.clear();
        return;
      }
      setTimeout(check, 80);
    };
    setTimeout(check, 80);
  }

  private goHome(): void {
    Log.showInfo(TAG, 'goHome');
    // Bringing the launcher to the front — suppress the side-edge BACK
    // gesture immediately rather than waiting for systemBarTintChange, so a
    // back-swipe right after this is ignored. The reactive event / DOWN
    // re-query self-correct this if the startAbility below fails.
    this.foregroundIsLauncher = true;
    try {
      this.context.startAbility({
        bundleName: 'com.ohos.launcher',
        abilityName: 'com.ohos.launcher.MainAbility'
      });
    } catch (err) {
      Log.showError(TAG, `goHome failed: ${JSON.stringify(err)}`);
    }
  }

  // Inject a BACK key down+up — the same mechanism the 3-button nav bar
  // uses (features/navigationservice/.../KeyCodeEvent.ts). Called by the
  // BackPanelController when the side-edge gesture commits.
  private triggerBack(): void {
    Log.showInfo(TAG, 'triggerBack');
    try {
      inputEventClient.injectEvent({
        KeyEvent: { isPressed: true, keyCode: KEYCODE_BACK, keyDownDuration: 1, isIntercepted: false },
      });
      inputEventClient.injectEvent({
        KeyEvent: { isPressed: false, keyCode: KEYCODE_BACK, keyDownDuration: 1, isIntercepted: false },
      });
    } catch (err) {
      Log.showError(TAG, `triggerBack injectEvent failed: ${JSON.stringify(err)}`);
    }
  }

  // Mirror of SCBGestureNavBarViewModel.checkAndSetPerationType: returns
  // GAME_OPERATE for apps that opt out of nav gestures. Stub for now —
  // hook point for future IME-active / game-mode / anti-touch rules.
  private checkAndSetPerationType(): PanGestureType {
    return PanGestureType.DEFAULT;
  }

  // ---- Dock + recents window plumbing ---------------------------------

  private initDockWindow(): void {
    const widthPx = Math.round(DOCK_WIDTH_VP * this.vpToPx);
    const heightPx = Math.round(DOCK_HEIGHT_VP * this.vpToPx);
    const bottomPx = Math.round(DOCK_BOTTOM_INSET_VP * this.vpToPx);
    const left = Math.round((this.screenWidthPx - widthPx) / 2);
    const top = Math.round(this.screenHeightPx - heightPx - bottomPx);

    const cfg: window.Configuration = {
      name: 'OniroGestureDock',
      windowType: window.WindowType.TYPE_SYSTEM_TOAST,
      ctx: this.context,
    };
    window.createWindow(cfg).then((win) => {
      this.dockWindow = win;
      win.resize(widthPx, heightPx).catch((e) => {
        Log.showWarn(TAG, `dock resize failed: ${JSON.stringify(e)}`);
      });
      win.moveWindowTo(left, top).catch((e) => {
        Log.showWarn(TAG, `dock move failed: ${JSON.stringify(e)}`);
      });
      win.setUIContent('pages/GestureDock').then(() => {
        win.setWindowBackgroundColor('#00000000');
        win.setWindowTouchable(false).catch((e) => {
          Log.showWarn(TAG, `dock setTouchable failed: ${JSON.stringify(e)}`);
        });
        // Pre-show: keep the dock window permanently shown so the
        // ~1s cold-path cost of `showWindow()` after every foreground
        // transition doesn't land on the gesture critical path. The
        // GestureDock page gates its content on OniroDockVisible
        // (opacity 0 when invisible) so the perma-shown window paints
        // nothing while gesture nav is disabled.
        win.showWindow().catch((e) => {
          Log.showWarn(TAG, `dock pre-show failed: ${JSON.stringify(e)}`);
        });
      }).catch((e) => {
        Log.showError(TAG, `dock setUIContent failed: ${JSON.stringify(e)}`);
      });
    }).catch((e) => {
      Log.showError(TAG, `createWindow(dock) failed: ${JSON.stringify(e)}`);
    });
  }

  private initDragWindow(): void {
    // TYPE_VOLUME_OVERLAY + setWindowTouchable(false) lets the overlay
    // float above the foreground app without intercepting touches —
    // the recognizer keeps reading them off inputMonitor.
    const cfg: window.Configuration = {
      name: 'OniroDragOverlay',
      windowType: window.WindowType.TYPE_VOLUME_OVERLAY,
      ctx: this.context,
    };
    window.createWindow(cfg).then((win) => {
      this.dragWindow = win;
      win.resize(this.screenWidthPx, this.screenHeightPx).catch((e) => {
        Log.showWarn(TAG, `drag resize failed: ${JSON.stringify(e)}`);
      });
      win.moveWindowTo(0, 0).catch((e) => {
        Log.showWarn(TAG, `drag move failed: ${JSON.stringify(e)}`);
      });
      win.setUIContent('pages/DragOverlay').then(() => {
        win.setWindowBackgroundColor('#00000000');
        win.setWindowFocusable(false).catch((e) => {
          Log.showWarn(TAG, `drag setFocusable failed: ${JSON.stringify(e)}`);
        });
        win.setWindowTouchable(false).catch((e) => {
          Log.showWarn(TAG, `drag setTouchable failed: ${JSON.stringify(e)}`);
        });
        // Pre-show: drag overlay window stays permanently visible.
        // `dragWindow.showWindow()` paid ~1s after every foreground
        // transition (render-service cold path post-WMS work), while
        // subsequent show calls without an intervening hide were
        // ~3ms. By never hiding (and gating every visible layer in
        // DragOverlay.ets on `this.visible`) we move the cost off
        // the gesture critical path. `dragShown` still tracks logical
        // state for resetOverlay, commit, and recents-mode bookkeeping.
        win.showWindow().catch((e) => {
          Log.showWarn(TAG, `drag pre-show failed: ${JSON.stringify(e)}`);
        });
      }).catch((e) => {
        Log.showError(TAG, `drag setUIContent failed: ${JSON.stringify(e)}`);
      });
    }).catch((e) => {
      Log.showError(TAG, `createWindow(drag) failed: ${JSON.stringify(e)}`);
    });
  }

  /**
   * Fullscreen overlay window hosting the back-arrow Canvas
   * (pages/BackPanel). Same recipe as the drag overlay: a
   * TYPE_VOLUME_OVERLAY that floats above the foreground app,
   * non-touchable (the recognizer reads touches off inputMonitor) and
   * pre-shown permanently — the BackPanel page paints a fully
   * transparent surface until the controller flips the frame to
   * visible, so there's no per-gesture showWindow() cold-path cost.
   */
  private initBackWindow(): void {
    const cfg: window.Configuration = {
      name: 'OniroBackPanel',
      windowType: window.WindowType.TYPE_VOLUME_OVERLAY,
      ctx: this.context,
    };
    window.createWindow(cfg).then((win) => {
      this.backWindow = win;
      win.resize(this.screenWidthPx, this.screenHeightPx).catch((e) => {
        Log.showWarn(TAG, `back resize failed: ${JSON.stringify(e)}`);
      });
      win.moveWindowTo(0, 0).catch((e) => {
        Log.showWarn(TAG, `back move failed: ${JSON.stringify(e)}`);
      });
      win.setUIContent('pages/BackPanel').then(() => {
        win.setWindowBackgroundColor('#00000000');
        win.setWindowFocusable(false).catch((e) => {
          Log.showWarn(TAG, `back setFocusable failed: ${JSON.stringify(e)}`);
        });
        win.setWindowTouchable(false).catch((e) => {
          Log.showWarn(TAG, `back setTouchable failed: ${JSON.stringify(e)}`);
        });
        win.showWindow().catch((e) => {
          Log.showWarn(TAG, `back pre-show failed: ${JSON.stringify(e)}`);
        });
      }).catch((e) => {
        Log.showError(TAG, `back setUIContent failed: ${JSON.stringify(e)}`);
      });
    }).catch((e) => {
      Log.showError(TAG, `createWindow(back) failed: ${JSON.stringify(e)}`);
    });
  }

  private showDragOverlay(): void {
    if (this.dragShown || !this.dragWindow) return;
    this.dragShown = true;
    // Window is already shown (initDragWindow pre-shows). Flip
    // OniroDragVisible NOW (not in dragController.start) — only after
    // the snapshot capture has resolved and written OniroDragSnap, so
    // every layer in DragOverlay.ets (all gated on `visible && snap`)
    // appears in the same frame the snap Image has a texture.
    // Otherwise the user sees a flash for the 45–700 ms of capture
    // latency.
    this.dragController?.show();
  }

  private hideDragOverlay(): void {
    if (!this.dragShown || !this.dragWindow) return;
    this.dragShown = false;
    // Window stays shown; DragController's reset() flips
    // OniroDragVisible=false, which clears the page's content.
  }
}

export default GestureNavigationServiceExtAbility;
