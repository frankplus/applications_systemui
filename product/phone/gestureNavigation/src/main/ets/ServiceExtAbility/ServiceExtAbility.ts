//@ts-nocheck
/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Side-edge BACK gesture host. Owns the OniroBackPanel window (the back-arrow
 * Canvas) and a BackPanelController (state machine + spring physics, a port
 * of AOSP BackPanelController.kt).
 *
 * The bottom-edge swipe-up gesture (HOME / RECENTS / Overview) used to live
 * here too, but moved to the phone_launcher GestureNavHost — the launcher is
 * where the app icon rects and the windowAnimationManager controller live, so
 * the go-home shrink can target the real icon. This service now handles ONLY
 * the side-edge BACK gesture. The two own disjoint hot zones (side edges here
 * vs the launcher's bottom edge) in two processes — exactly how AOSP runs the
 * EdgeBackGestureHandler alongside Quickstep.
 *
 * Foreground tracking (to suppress BACK on the home screen) is PUSH-based:
 * the launcher publishes a sticky desktop-focus CommonEvent (it's the
 * authority on its own focus), so we never run a getTopAbility sync binder.
 */

import ServiceExtension from '@ohos.app.ability.ServiceExtensionAbility';
import inputMonitor from '@ohos.multimodalInput.inputMonitor';
import inputEventClient from '@ohos.multimodalInput.inputEventClient';
import display from '@ohos.display';
import window from '@ohos.window';
import settings from '@ohos.settings';
import data_dataShare from '@ohos.data.dataShare';
import commonEventManager from '@ohos.commonEventManager';
import Log from '../../../../../../../common/src/main/ets/default/Log';
import Constants from '../../../../../../../common/src/main/ets/default/Constants';
import { BackPanelController, GestureState } from '../back/BackPanelController';

const TAG = 'GestureNavigation_ServiceExtAbility';

// Bottom hot zone reserved for the launcher's HOME/RECENTS swipe-up gesture.
// A side-edge BACK DOWN inside it is ignored so the bottom-corner overlap
// stays with the launcher's home gesture (matches AOSP, where the bottom
// inset belongs to Quickstep, not the EdgeBackGestureHandler).
const HOT_ZONE_VP = 32;

// Side-edge BACK gesture: a DOWN within this many vp of the left or right
// screen edge (and NOT in the bottom hot zone) starts a back gesture. AOSP
// config_backGestureInset default = 30dp.
const BACK_EDGE_WIDTH_VP = 30;
// keyCode for BACK (@ohos.multimodalInput.keyCode KEYCODE_BACK).
const KEYCODE_BACK = 2;

// CommonEvent the launcher publishes on desktop focus change (MainAbility
// DESKTOP_FOCUS_EVENT). code 1 = launcher (desktop) foreground, 0 = an app
// foreground. The launcher PUSHES its own focus — we PULL nothing, which
// removes the getTopAbility sync-binder stall and the observer brittleness
// (an app could background then refocus with no fresh FOREGROUND event). See
// the migration plan §7.
const DESKTOP_FOCUS_EVENT = 'com.ohos.oniro.desktop.focus_changed';

const NAV_MODE_GESTURE = '0';
const NAV_MODE_URI =
  'datashare:///com.ohos.settingsdata/entry/settingsdata/SETTINGSDATA?Proxy=true&key=' +
  Constants.KEY_NAVIGATIONBAR_STATUS;

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

  private touchReceiver = (ev) => this.handleTouch(ev);
  private mouseReceiver = (ev) => this.handleMouse(ev);
  private monitorActive = false;
  private mouseButtonDown = false;

  // Side-edge BACK gesture. Owns its own fullscreen overlay window (the
  // arrow Canvas) and a BackPanelController (state machine + spring physics,
  // a port of AOSP BackPanelController.kt).
  private backController: BackPanelController | null = null;
  private backWindow: window.Window | null = null;
  private backPointerId: number | null = null;
  // Deferred pilfer: a side-edge DOWN starts TRACKING the pointer but is NOT
  // consumed (inputMonitor returns false) until the controller leaves GONE —
  // i.e. horizontal slop is crossed and it's a confirmed back-swipe. Until
  // then the touch falls through to the foreground app so taps on
  // edge-anchored UI (e.g. the leftmost/rightmost keyboard keys, which sit
  // inside the 30vp BACK strip) are not swallowed. AOSP achieves the same with
  // InputMonitor.pilferPointers(); OHOS's touch monitor has no such call
  // (return-bool is the only lever), so on a real swipe the app sees a benign
  // half-stream (DOWN + sub-slop MOVEs, no UP) — keyboards commit on UP, which
  // we then own, so no stray character is typed.
  private backPilfered = false;

  // Cached "is the launcher the current foreground app" flag, read
  // synchronously at touch-DOWN to gate the side-edge BACK gesture. Fed by the
  // launcher's desktop-focus CommonEvent PUSH (initForegroundTracking). Biased
  // toward false (BACK enabled): worst case is a harmless BACK on the home
  // screen, never a dead BACK in an app.
  private foregroundIsLauncher = false;
  // The launcher's desktop-focus CommonEvent subscriber.
  private focusSubscriber: commonEventManager.CommonEventSubscriber | null = null;

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
    this.backController = new BackPanelController(
      {
        vpToPx: this.vpToPx,
        screenWidthPx: this.screenWidthPx,
        screenHeightPx: this.screenHeightPx,
      },
      { triggerBack: () => this.triggerBack() },
    );
    this.initBackWindow();
    this.initNavModeSubscription();
    this.initForegroundTracking();
  }

  onDestroy(): void {
    Log.showInfo(TAG, 'onDestroy');
    this.stopMonitor();
    this.dataShareHelper?.off('dataChange', NAV_MODE_URI);
    this.dataShareHelper = null;
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
      if (this.focusSubscriber) {
        commonEventManager.unsubscribe(this.focusSubscriber);
        this.focusSubscriber = null;
      }
    } catch (e) {
      Log.showWarn(TAG, `desktop-focus unsubscribe failed: ${JSON.stringify(e)}`);
    }
  }

  onRequest(_want, startId): void {
    Log.showInfo(TAG, `onRequest startId=${startId}`);
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
    // The side-edge BACK gesture is only active in gesture-nav mode; in
    // 3-button mode the nav bar's own BACK button handles it.
    if (this.navMode === NAV_MODE_GESTURE) {
      this.startMonitor();
    } else {
      this.stopMonitor();
    }
  }

  // ---- Foreground-app (launcher) tracking ------------------------------

  /**
   * Subscribe to the launcher's desktop-focus PUSH. The launcher is the
   * authority on its own focus and publishes WINDOW_ACTIVE/INACTIVE as a
   * sticky CommonEvent, so we never run a sync binder (the ~1.2s stall) and
   * never infer "home" from an app backgrounding (which stuck the flag true
   * inside apps). Default foregroundIsLauncher=false (BACK enabled) holds
   * until the first push — the safe bias. STICKY delivery gives us the
   * current focus the moment we subscribe, even after the boot-time publish.
   */
  private initForegroundTracking(): void {
    try {
      commonEventManager.createSubscriber({ events: [DESKTOP_FOCUS_EVENT] })
        .then((subscriber) => {
          this.focusSubscriber = subscriber;
          commonEventManager.subscribe(subscriber, (err, data) => {
            if (err) {
              Log.showWarn(TAG, `desktop-focus cb err: ${JSON.stringify(err)}`);
              return;
            }
            this.setForegroundIsLauncher(data?.code === 1, `desktop-push code=${data?.code}`);
          });
          Log.showInfo(TAG, 'desktop-focus CommonEvent subscriber registered');
        })
        .catch((e) => {
          Log.showError(TAG, `createSubscriber(desktop-focus) failed: ${JSON.stringify(e)}`);
        });
    } catch (e) {
      Log.showError(TAG, `initForegroundTracking failed: ${JSON.stringify(e)}`);
    }
  }

  private setForegroundIsLauncher(isLauncher: boolean, why: string): void {
    if (isLauncher !== this.foregroundIsLauncher) {
      this.foregroundIsLauncher = isLauncher;
      Log.showInfo(TAG, `foregroundIsLauncher -> ${isLauncher} (${why})`);
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
    if (this.checkAndSetPerationType() === PanGestureType.GAME_OPERATE) return false;

    if (action === TOUCH_DOWN) {
      // Side-edge BACK on the left/right edge strips, but only ABOVE the
      // bottom hot zone (the launcher owns the bottom-edge HOME/RECENTS
      // gesture) and NOT while the launcher (home screen) is foreground —
      // there's nothing to go back to there, and the swipe should reach the
      // launcher untouched. A DOWN here only TRACKS the pointer; consuming is
      // deferred until the swipe is confirmed (see backPilfered / TOUCH_MOVE
      // below), so a tap on an edge-anchored target like a keyboard key still
      // reaches the app. foregroundIsLauncher is kept fresh by the launcher's
      // desktop-focus PUSH — no getTopAbility sync binder here.
      const inBottomHotZone =
        this.screenHeightPx > 0 && y >= this.screenHeightPx - HOT_ZONE_VP * this.vpToPx;
      if (!inBottomHotZone && !this.foregroundIsLauncher && this.backController &&
          this.backPointerId === null) {
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
      return false;
    }

    if (action === TOUCH_UP || action === TOUCH_CANCEL) {
      if (this.backPointerId === id && this.backController) {
        this.backController.onPointerEnd(
          x / this.vpToPx, y / this.vpToPx, timeMs, action === TOUCH_CANCEL);
        const consumed = this.backPilfered;
        this.backPointerId = null;
        this.backPilfered = false;
        // A tap (never pilfered) returns false so the app sees the UP and the
        // key registers; a confirmed swipe returns true (we owned it).
        return consumed;
      }
      return false;
    }

    return false;
  }

  // Inject a BACK key down+up — the same mechanism the 3-button nav bar uses
  // (features/navigationservice/.../KeyCodeEvent.ts). Called by the
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
  // GAME_OPERATE for apps that opt out of nav gestures. Stub for now — hook
  // point for future IME-active / game-mode / anti-touch rules.
  private checkAndSetPerationType(): PanGestureType {
    return PanGestureType.DEFAULT;
  }

  // ---- Back window plumbing -------------------------------------------

  /**
   * Fullscreen overlay window hosting the back-arrow Canvas (pages/BackPanel).
   * A TYPE_VOLUME_OVERLAY that floats above the foreground app, non-touchable
   * (touches are read off inputMonitor) and pre-shown permanently — the
   * BackPanel page paints a fully transparent surface until the controller
   * flips the frame to visible, so there's no per-gesture showWindow()
   * cold-path cost.
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
}

export default GestureNavigationServiceExtAbility;
