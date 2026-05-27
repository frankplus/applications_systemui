//@ts-nocheck
/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import ServiceExtension from '@ohos.app.ability.ServiceExtensionAbility';
import inputMonitor from '@ohos.multimodalInput.inputMonitor';
import display from '@ohos.display';
import window from '@ohos.window';
import settings from '@ohos.settings';
import data_dataShare from '@ohos.data.dataShare';
import Log from '../../../../../../../common/src/main/ets/default/Log';
import Constants from '../../../../../../../common/src/main/ets/default/Constants';

const TAG = 'GestureNavigation_ServiceExtAbility';

// Lifted from sceneboard_disasm/FINDINGS.md §C and harmony-port-work/PLAN.md §4.
// HarmonyOS resolves these at runtime from StyleConstants; the disasm has only
// the references, not the literals, so we use the documented starting values.
const HOT_ZONE_VP = 32;
const MIN_DELTA_VP = 120;        // commit-home distance
const HOLD_DELTA_VP = 200;       // commit-recents distance
const MIN_VELOCITY_VP_PER_S = 800;
const HOLD_MS = 250;             // held pull commits to recents
const DOCK_SHOW_AFTER_VP = 16;   // dock peek-in distance; smaller than commit
const DOCK_WIDTH_VP = 112;       // GESTURE_NAV_AI_BAR_WIDTH_DEFAULT
const DOCK_HEIGHT_VP = 40;
const DOCK_BOTTOM_INSET_VP = 12;

const NAV_MODE_GESTURE = '0';
const NAV_MODE_URI =
  'datashare:///com.ohos.settingsdata/entry/settingsdata/SETTINGSDATA?Proxy=true&key=' +
  Constants.KEY_NAVIGATIONBAR_STATUS;

const APP_KEY_DOCK_VISIBLE = 'OniroDockVisible';
const APP_KEY_DOCK_PROGRESS = 'OniroDockProgress';   // 0..1 toward HOLD_DELTA_VP
const APP_KEY_DOCK_MODE = 'OniroDockMode';           // 'home' | 'recents'

// Loosely mirrors SCBGestureNavBarViewModel's enums. We don't yet need the
// full set of fail reasons; one CANCELED state is enough.
enum RecognizeState {
  IDLE = 0,
  TRACKING = 1,
  CANCELED = 2,
  COMMITTING_HOME = 3,
  COMMITTING_RECENTS = 4,
}

enum PanGestureType {
  DEFAULT = 0,
  GAME_OPERATE = 1,
}

enum ActionType {
  NONE = 0,
  HOME = 1,
  RECENTS = 2,
}

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

interface Tracking {
  startY: number;
  startTimeUs: number;
  lastY: number;
  lastTimeUs: number;
  source: 'touch' | 'mouse';
}

class GestureNavigationServiceExtAbility extends ServiceExtension {
  private state: RecognizeState = RecognizeState.IDLE;
  private tracking: Tracking | null = null;
  private screenHeightPx = 0;
  private screenWidthPx = 0;
  private vpToPx = 1;

  private touchReceiver = (ev) => this.handleTouch(ev);
  private mouseReceiver = (ev) => this.handleMouse(ev);
  private monitorActive = false;
  private mouseButtonDown = false;

  private dockWindow: window.Window | null = null;
  private dockShown = false;
  private holdTimerId: number | null = null;

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
    this.initDockWindow();
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
    this.tracking = null;
    this.state = RecognizeState.IDLE;
    this.mouseButtonDown = false;
    this.clearHoldTimer();
  }

  // ---- Touch handling --------------------------------------------------

  private handleTouch(ev): boolean {
    const t = ev?.touch;
    if (!t) return false;
    return this.dispatchPointer(ev.action, t.screenY, ev.actionTime, 'touch');
  }

  // Mouse drag mapped to a touch-like gesture: BUTTON_DOWN starts tracking,
  // MOVE while button is held updates, BUTTON_UP / CANCEL ends.
  private handleMouse(ev): boolean {
    const action = ev?.action;
    const y = ev?.screenY;
    const t = ev?.actionTime;
    if (action === undefined || y === undefined) return false;
    if (action === MOUSE_BUTTON_DOWN) {
      if ((ev.button ?? MOUSE_BUTTON_LEFT) !== MOUSE_BUTTON_LEFT) return false;
      this.mouseButtonDown = true;
      return this.dispatchPointer(TOUCH_DOWN, y, t, 'mouse');
    }
    if (action === MOUSE_MOVE && this.mouseButtonDown) {
      return this.dispatchPointer(TOUCH_MOVE, y, t, 'mouse');
    }
    if (action === MOUSE_BUTTON_UP || action === MOUSE_CANCEL) {
      if (!this.mouseButtonDown) return false;
      this.mouseButtonDown = false;
      const mapped = action === MOUSE_CANCEL ? TOUCH_CANCEL : TOUCH_UP;
      return this.dispatchPointer(mapped, y, t, 'mouse');
    }
    return false;
  }

  // ---- State machine ---------------------------------------------------

  private dispatchPointer(action: number, y: number, timeUs: number, source: 'touch' | 'mouse'): boolean {
    if (action === TOUCH_DOWN) {
      return this.onPointerDown(y, timeUs, source);
    }
    if (this.state !== RecognizeState.TRACKING || !this.tracking) return false;
    // Lock to whichever pointer source claimed the gesture, in case both fire.
    if (this.tracking.source !== source) return false;
    if (action === TOUCH_MOVE) {
      return this.onPointerMove(y, timeUs);
    }
    if (action === TOUCH_UP || action === TOUCH_CANCEL) {
      return this.onPointerEnd(y, timeUs, action === TOUCH_CANCEL);
    }
    return false;
  }

  private onPointerDown(y: number, timeUs: number, source: 'touch' | 'mouse'): boolean {
    const hotZonePx = HOT_ZONE_VP * this.vpToPx;
    if (this.screenHeightPx <= 0 || y < this.screenHeightPx - hotZonePx) {
      return false;
    }
    const panType = this.checkAndSetPerationType();
    if (panType === PanGestureType.GAME_OPERATE) {
      return false;
    }
    this.tracking = {
      startY: y,
      startTimeUs: timeUs,
      lastY: y,
      lastTimeUs: timeUs,
      source,
    };
    this.state = RecognizeState.TRACKING;
    Log.showDebug(TAG, `DOWN(${source}) inside hot zone y=${y}`);
    return false;
  }

  private onPointerMove(y: number, timeUs: number): boolean {
    if (!this.tracking) return false;
    this.tracking.lastY = y;
    this.tracking.lastTimeUs = timeUs;

    const deltaPx = this.tracking.startY - y;
    if (deltaPx <= 0) return false;
    const deltaVp = deltaPx / this.vpToPx;

    if (deltaVp >= DOCK_SHOW_AFTER_VP) {
      this.showDock();
      const progress = Math.min(deltaVp / HOLD_DELTA_VP, 1);
      AppStorage.SetOrCreate(APP_KEY_DOCK_PROGRESS, progress);
      AppStorage.SetOrCreate(APP_KEY_DOCK_MODE, deltaVp >= HOLD_DELTA_VP ? 'recents' : 'home');
    }

    if (deltaVp >= HOLD_DELTA_VP && this.holdTimerId === null) {
      const armedAtY = y;
      this.holdTimerId = setTimeout(() => {
        this.holdTimerId = null;
        if (!this.tracking) return;
        const drift = Math.abs(this.tracking.lastY - armedAtY) / this.vpToPx;
        if (drift < 24) {
          this.commit(ActionType.RECENTS);
        }
      }, HOLD_MS);
    }
    return false;
  }

  private onPointerEnd(y: number, timeUs: number, canceled: boolean): boolean {
    if (!this.tracking) {
      this.state = RecognizeState.IDLE;
      return false;
    }
    const startY = this.tracking.startY;
    const startTimeUs = this.tracking.startTimeUs;
    this.tracking = null;
    this.clearHoldTimer();

    if (canceled) {
      this.state = RecognizeState.CANCELED;
      this.hideDock();
      this.state = RecognizeState.IDLE;
      return false;
    }

    const deltaPx = startY - y;
    if (deltaPx <= 0) {
      this.hideDock();
      this.state = RecognizeState.IDLE;
      return false;
    }
    const deltaVp = deltaPx / this.vpToPx;
    const elapsedMs = Math.max((timeUs - startTimeUs) / 1000, 1);
    const velocityVpS = (deltaVp / elapsedMs) * 1000;

    Log.showInfo(TAG,
      `UP deltaVp=${deltaVp.toFixed(1)} elapsedMs=${elapsedMs.toFixed(0)} vpS=${velocityVpS.toFixed(0)}`);

    let action = ActionType.NONE;
    if (deltaVp >= HOLD_DELTA_VP && elapsedMs >= HOLD_MS) {
      action = ActionType.RECENTS;
    } else if (deltaVp >= MIN_DELTA_VP && velocityVpS >= MIN_VELOCITY_VP_PER_S) {
      action = ActionType.HOME;
    }
    this.commit(action);
    return action !== ActionType.NONE;
  }

  private commit(action: ActionType): void {
    if (action === ActionType.HOME) {
      this.state = RecognizeState.COMMITTING_HOME;
      this.goHome();
    } else if (action === ActionType.RECENTS) {
      this.state = RecognizeState.COMMITTING_RECENTS;
      this.openRecents();
    }
    this.hideDock();
    this.state = RecognizeState.IDLE;
  }

  // Mirror of SCBGestureNavBarViewModel.checkAndSetPerationType: returns
  // GAME_OPERATE for apps that opt out of nav gestures. Stub for now —
  // hook point for future IME-active / game-mode / anti-touch rules.
  private checkAndSetPerationType(): PanGestureType {
    return PanGestureType.DEFAULT;
  }

  // ---- Action dispatch -------------------------------------------------

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
        // Already gone — proceed.
        this.createRecentsWindow();
      });
    } catch (_e) {
      this.createRecentsWindow();
    }
  }

  // ---- Dock window -----------------------------------------------------

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

  private clearHoldTimer(): void {
    if (this.holdTimerId !== null) {
      clearTimeout(this.holdTimerId);
      this.holdTimerId = null;
    }
  }
}

export default GestureNavigationServiceExtAbility;
