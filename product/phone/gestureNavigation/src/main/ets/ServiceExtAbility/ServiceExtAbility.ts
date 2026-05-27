//@ts-nocheck
/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Bottom-edge gesture-navigation host. Owns the dock peek-in window and
 * the OniroRecentsOverlay window; delegates all swipe recognition to
 * SwipeRecognizer (a port of AOSP Launcher3 Quickstep).
 *
 * Quickstep parity work lives in ./recognizer/ — this file only wires
 * inputMonitor events into the recognizer and translates its callbacks
 * into window operations.
 */

import ServiceExtension from '@ohos.app.ability.ServiceExtensionAbility';
import inputMonitor from '@ohos.multimodalInput.inputMonitor';
import display from '@ohos.display';
import window from '@ohos.window';
import settings from '@ohos.settings';
import data_dataShare from '@ohos.data.dataShare';
import Log from '../../../../../../../common/src/main/ets/default/Log';
import Constants from '../../../../../../../common/src/main/ets/default/Constants';
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
const DOCK_WIDTH_VP = 112;
const DOCK_HEIGHT_VP = 40;
const DOCK_BOTTOM_INSET_VP = 12;

const NAV_MODE_GESTURE = '0';
const NAV_MODE_URI =
  'datashare:///com.ohos.settingsdata/entry/settingsdata/SETTINGSDATA?Proxy=true&key=' +
  Constants.KEY_NAVIGATIONBAR_STATUS;

const APP_KEY_DOCK_VISIBLE = 'OniroDockVisible';
const APP_KEY_DOCK_PROGRESS = 'OniroDockProgress';   // 0..1 toward HOLD_DELTA_VP
const APP_KEY_DOCK_MODE = 'OniroDockMode';           // 'home' | 'recents'

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

  private dockWindow: window.Window | null = null;
  private dockShown = false;

  private dragWindow: window.Window | null = null;
  private dragShown = false;
  private snapshotCapture: SnapshotCapture = new SnapshotCapture();
  private dragController: DragController | null = null;
  // True from onCommit until the post-spring teardown completes —
  // suppresses the synchronous onReset path so the spring runs to
  // settle instead of being short-circuited.
  private commitAnimating = false;

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
    this.recognizer = this.buildRecognizer();
    this.initDockWindow();
    this.initDragWindow();
    this.initNavModeSubscription();
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
        this.showDock();
        this.dragController?.start();
        this.showDragOverlay();
        // Best-effort capture. Overlay is already up at scale=1 so
        // when the PixelMap arrives the @StorageLink swaps it in.
        this.snapshotCapture.capture(this.screenWidthPx, this.screenHeightPx);
      },
      onProgress: (deltaVp: number, mode: ProgressMode, lastX: number, lastY: number) => {
        if (!this.dockShown) this.showDock();
        const progress = Math.min(deltaVp / MIN_DELTA_RECENTS_VP, 1);
        AppStorage.SetOrCreate(APP_KEY_DOCK_PROGRESS, progress);
        AppStorage.SetOrCreate(APP_KEY_DOCK_MODE, mode);
        this.dragController?.onProgress(deltaVp, lastX, lastY);
      },
      onCommit: (target: GestureEndTarget, info: CommitInfo) => {
        this.handleCommit(target, info);
      },
      onReset: () => {
        // If commitAnimating, the spring is mid-flight and will
        // tear down the overlay itself in its onComplete. We still
        // hide the dock (it's the pre-commit hint, not part of the
        // commit) but leave the drag overlay alone.
        this.hideDock();
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
    if (this.navMode === NAV_MODE_GESTURE) {
      this.startMonitor();
    } else {
      this.stopMonitor();
      this.hideDock();
    }
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
      const accepted = r.onPointerDown(id, x, y, timeMs);
      return false; // never pilfer at DOWN — observation only.
    }
    if (action === TOUCH_MOVE) {
      r.onPointerMove(id, x, y, timeMs);
      return false;
    }
    if (action === TOUCH_UP || action === TOUCH_CANCEL) {
      r.onPointerEnd(id, x, y, timeMs, action === TOUCH_CANCEL);
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
    // or capture+show never raced in), there's nothing to spring —
    // just do the structural commit immediately.
    if (!this.dragShown || !this.dragController) {
      this.runStructuralCommit(target);
      return;
    }
    this.commitAnimating = true;
    this.dragController.commit(target, () => {
      this.runStructuralCommit(target);
      // Tear down after the structural commit so the system has the
      // ability already started by the time the overlay disappears.
      this.dragController?.reset();
      this.hideDragOverlay();
      this.snapshotCapture.clear();
      this.commitAnimating = false;
    });
  }

  private runStructuralCommit(target: GestureEndTarget): void {
    if (target === GestureEndTarget.HOME) {
      this.goHome();
    } else if (target === GestureEndTarget.RECENTS) {
      this.openRecents();
    }
    // CANCEL: no structural action.
  }

  private goHome(): void {
    Log.showInfo(TAG, 'goHome');
    try {
      this.context.startAbility({
        bundleName: 'com.ohos.launcher',
        abilityName: 'com.ohos.launcher.MainAbility'
      });
    } catch (err) {
      Log.showError(TAG, `goHome failed: ${JSON.stringify(err)}`);
    }
  }

  private openRecents(): void {
    Log.showInfo(TAG, 'openRecents');
    // Always recreate so the page's aboutToAppear re-runs and we fetch a
    // fresh mission list. If a previous recents window is still around (the
    // user may have re-swiped without dismissing), destroy it first.
    try {
      const existing = window.findWindow('OniroRecentsOverlay');
      existing.destroyWindow().then(() => {
        this.createRecentsWindow();
      }).catch(() => {
        this.createRecentsWindow();
      });
    } catch (_e) {
      this.createRecentsWindow();
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
        Log.showInfo(TAG, 'dock window content set');
      }).catch((e) => {
        Log.showError(TAG, `dock setUIContent failed: ${JSON.stringify(e)}`);
      });
    }).catch((e) => {
      Log.showError(TAG, `createWindow(dock) failed: ${JSON.stringify(e)}`);
    });
  }

  private createRecentsWindow(): void {
    // TYPE_VOLUME_OVERLAY (not TYPE_SYSTEM_TOAST) — toast windows aren't
    // focusable, so onClick handlers on the backdrop / cards never fire and
    // clicks bleed through to the app underneath. The same type is used by
    // systemui's notification & volume panels, both of which need input.
    const cfg: window.Configuration = {
      name: 'OniroRecentsOverlay',
      windowType: window.WindowType.TYPE_VOLUME_OVERLAY,
      ctx: this.context,
    };
    window.createWindow(cfg).then((win) => {
      win.resize(this.screenWidthPx, this.screenHeightPx).catch(() => {});
      win.moveWindowTo(0, 0).catch(() => {});
      win.setUIContent('pages/RecentsOverlay').then(() => {
        win.setWindowBackgroundColor('#00000000');
        win.setWindowFocusable(true).catch((e) => {
          Log.showWarn(TAG, `recents setFocusable failed: ${JSON.stringify(e)}`);
        });
        win.setWindowTouchable(true).catch((e) => {
          Log.showWarn(TAG, `recents setTouchable failed: ${JSON.stringify(e)}`);
        });
        win.showWindow().then(() => {
          AppStorage.SetOrCreate('OniroRecentsOpen', true);
        }).catch((e) => {
          Log.showWarn(TAG, `recents show failed: ${JSON.stringify(e)}`);
        });
      }).catch((e) => {
        Log.showError(TAG, `recents setUIContent failed: ${JSON.stringify(e)}`);
      });
    }).catch((e) => {
      Log.showError(TAG, `createWindow(recents) failed: ${JSON.stringify(e)}`);
    });
  }

  private showDock(): void {
    if (this.dockShown || !this.dockWindow) return;
    this.dockShown = true;
    AppStorage.SetOrCreate(APP_KEY_DOCK_VISIBLE, true);
    this.dockWindow.showWindow().catch((e) => {
      Log.showWarn(TAG, `dock show failed: ${JSON.stringify(e)}`);
    });
  }

  private hideDock(): void {
    AppStorage.SetOrCreate(APP_KEY_DOCK_VISIBLE, false);
    AppStorage.SetOrCreate(APP_KEY_DOCK_PROGRESS, 0);
    this.dockShown = false;
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
        Log.showInfo(TAG, 'drag window content set');
      }).catch((e) => {
        Log.showError(TAG, `drag setUIContent failed: ${JSON.stringify(e)}`);
      });
    }).catch((e) => {
      Log.showError(TAG, `createWindow(drag) failed: ${JSON.stringify(e)}`);
    });
  }

  private showDragOverlay(): void {
    if (this.dragShown || !this.dragWindow) return;
    this.dragShown = true;
    this.dragWindow.showWindow().catch((e) => {
      Log.showWarn(TAG, `drag show failed: ${JSON.stringify(e)}`);
    });
  }

  private hideDragOverlay(): void {
    if (!this.dragShown || !this.dragWindow) return;
    this.dragShown = false;
    this.dragWindow.hide().catch((e) => {
      Log.showWarn(TAG, `drag hide failed: ${JSON.stringify(e)}`);
    });
  }
}

export default GestureNavigationServiceExtAbility;
