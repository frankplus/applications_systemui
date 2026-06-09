/*
 * Copyright (c) 2021-2022 Huawei Device Co., Ltd.
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
 */

import BatteryIcon from '../../../../../../../features/batterycomponent/src/main/ets/default/pages/batteryIcon'
import ClockIcon from '../../../../../../../features/clockcomponent/src/main/ets/default/pages/clockIcon'
import WifiIcon from '../../../../../../../features/wificomponent/src/main/ets/default/pages/wifiIcon'
import BluetoothIcon from '../../../../../../../features/bluetoothcomponent/src/main/ets/com/ohos/pages/StatusBarIconItemBluetoothComponent'
import SignalIcon from '../../../../../../../features/signalcomponent/src/main/ets/default/pages/signalIcon'
import LocationIcon from '../../../../../../../features/locationcomponent/src/main/ets/com/ohos/pages/StatusBarIconItemLocationComponent'
import RingModeIcon from '../../../../../../../features/ringmodecomponent/src/main/ets/com/ohos/pages/StatusBarIconItemRingModeComponent'

import AbilityManager from '../../../../../../../common/src/main/ets/default/abilitymanager/abilityManager';
import image from "@ohos.multimedia.image"
import window from '@ohos.window'
import display from '@ohos.display'
import Log from '../../../../../../../common/src/main/ets/default/Log'
import Trace from '../../../../../../../common/src/main/ets/default/Trace'
import WindowManager, { WindowType, WINDOW_SHOW_HIDE_EVENT
} from '../../../../../../../common/src/main/ets/default/WindowManager'
import EventManager, { unsubscribe } from "../../../../../../../common/src/main/ets/default/event/EventManager"
import { START_ABILITY_EVENT } from "../../../../../../../common/src/main/ets/default/event/EventUtil"
import CommonStyleManager from '../../../../../../../common/src/main/ets/default/CommonStyleManager'
import MultimodalInputManager from '../../../../../../../common/src/main/ets/default/MultimodalInputManager'
import HeightConfigUtils from '../../../../../../../common/src/main/ets/default/heightcofigUtils/HeightConfigUtils'
import NavigationEvent, { NavigationCallBack } from './common/navigationEvent'
import Notification, { notifVisualHeightVp } from './notification'
import ControlCenterComponent, { CARD_EDGE_MARGIN_VP, cardVisualHeightVp } from './control'
import StyleManager from './common/StyleManager'
import dataShare from '@ohos.data.dataShare';
import settings from '@ohos.settings';
import curves from '@ohos.curves';
import Constants from "../../../../../../../common/src/main/ets/default/Constants";
import { TouchMoveData, Rect, ConfigInfo, NotificationItemData } from '@ohos/common';
import { Context } from '@kit.AbilityKit';
import { inputConsumer } from '@kit.InputKit';

const TAG = 'DropdownPanel-Index'

interface IArg {
  dropdownArea?: string
}

interface DragArg {
  area?: string      // 'left' = notification, 'right' = control
  dy?: number        // total finger displacement in px since drag start
  velocityY?: number // px/s in last update window
}

let mHeightConfigUtils: HeightConfigUtils

// Spring curve sourced from Huawei SceneBoard ControlCenterComponent disasm
// (response=0.34s, dampingFraction=0.82). Spring curves ignore duration; the
// duration field is kept only as a hide-window fallback timer in _animateTo.
const SHOW_ANIM_CONFIG: AnimateParam = {
  duration: 450,
  tempo: 1.0,
  curve: curves.springMotion(0.34, 0.82),
  delay: 0,
  iterations: 1,
  playMode: PlayMode.Normal
};

// How long to keep the (off-screen) panel rendering after a close commits,
// before tearing it down (panelActive=false). Must exceed the spring's visual
// settle time so the panel slides ALL the way off the top edge instead of
// vanishing ~one status-bar-height short. The spring (response 0.34s,
// damping 0.82) settles well within this; the panel is already off-screen +
// non-touchable for most of it, so an over-estimate is harmless.
const PANEL_SETTLE_MS: number = 1200;

enum DropdownPanelComponentName {
  NONE = 'None',
  CONTROL_CENTER = 'ControlCenter',
  NOTIFICATION = 'Notification'
}

// Cross-module flag read by phone_gestureNavigation's bottom-edge
// recogniser: while true, gesture-nav suppresses HOME/RECENTS commits so
// the panel's own swipe-up-to-close PanGesture wins on dismiss. Stays
// process-local (systemui HAPs share a process).
const APP_KEY_DROPDOWN_PANEL_OPEN = 'OniroDropdownPanelOpen'

// Width breakpoint (vp) at/above which the device is treated as a tablet: the
// frosted control/notification card then hugs a top corner with its content
// scaled down, instead of the phone's near-full-width inset card. 600vp is the
// standard OHOS large-width breakpoint (the 1600x2560@2.0 tablet is 800vp wide;
// the phone is 360vp).
const TABLET_MIN_WIDTH_VP = 600

function publishDropdownOpen(open: boolean): void {
  AppStorage.SetOrCreate(APP_KEY_DROPDOWN_PANEL_OPEN, open)
}

@Entry
@Component
struct Index {
  @State showComponentName: DropdownPanelComponentName = DropdownPanelComponentName.NONE;
  @State componentOptAreaHeightPX: number = 0;
  @StorageLink('StatusCoefficient') StatusCoefficient: number = 1.0;
  private mCallback?: NavigationCallBack;
  private mClearCallbacks?: unsubscribe[];
  settingDataKey = 'settings.display.navigationbar_status';
  private urivar?: string;
  private helper?: dataShare.DataShareHelper;
  mNavigationBarStatusDefaultValue: string = '1';
  navigationBarWidth: number = 0;
  mNeedUpdate: boolean = false;
  @State mWidthPx: number = 0;
  @State mNotificationInsert: TransitionOptions = {};
  @State mNotificationDelete: TransitionOptions = {};
  @State mControlCenterInsert: TransitionOptions = {};
  @State mControlCenterDelete: TransitionOptions = {};
  @State componentOptAreaTranslateY: string = '0px';
  @State backgroundOpacity: number = 0;
  // Drives whether the panel paints ANYTHING. The window is permanently shown
  // (pre-shown in ServiceExtAbility to kill the cold-path open lag), so when the
  // panel is closed it must render a fully-transparent surface — otherwise the
  // always-present window would cover the screen. False at startup + after a
  // close settles; true from open until the slide-out completes.
  @State panelActive: boolean = false;
  // Status-bar (top) and nav-bar (bottom) insets in px this window is laid out
  // within. The legacy WMS lays the page content into the safe area (origin at
  // y=topInset). We offset the panel up by topInset so its own header lands at
  // screen y=0 (covers/substitutes the system status bar) and a full close
  // translate (-H) carries the panel fully off the top edge; bottomInset grows
  // the dim so it also covers the nav-bar strip. 0 until queried.
  @State topInsetPx: number = 0;
  @State bottomInsetPx: number = 0;
  // True on tablet-width displays (see TABLET_MIN_WIDTH_VP). The panel is a
  // frosted card over a tap-to-close dim on BOTH form factors; isWide only picks
  // the card GEOMETRY: tablet → fixed-width card hugging a top corner with the
  // phone-derived content scaled down; phone → near-full-width inset card at
  // native scale (centered). Computed once in aboutToAppear (width is fixed here).
  @State isWide: boolean = false;
  // Display height (vp) + the live notification list, used to size the per-panel
  // card travel: the card is short and anchored at the top, so a top-drag must
  // travel ITS height (control vs. the adaptive notification card) — not the full
  // panel height — to track the finger 1:1. 1280 fallback if the display query fails.
  private dispHvp: number = 1280;
  @StorageLink('notificationList') notificationList: NotificationItemData[][] = [];
  // Handle for the pending "deactivate after slide-out" timer (see _animateTo).
  // Cleared on any reopen so a stale close can't tear down a freshly-opened
  // panel. -1 means no timer pending.
  private closeTimer: number = -1;

  onBackPress(): boolean {
    return true
  }

  aboutToAppear() {
    Log.showInfo(TAG, `aboutToAppear, start`);
    // Measure the system avoid insets so we can offset the panel up by the top
    // inset (so its header lands at screen y=0) and grow the dim by both insets.
    // Synchronous findWindow + avoid-area query — the window already exists
    // (this page is loaded into it).
    try {
      let win = window.findWindow(WindowType.DROPDOWN_PANEL)
      let area = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM)
      this.topInsetPx = area.topRect.height
      this.bottomInsetPx = area.bottomRect.height
      Log.showInfo(TAG, `aboutToAppear, insets top=${this.topInsetPx} bottom=${this.bottomInsetPx}`)
    } catch (e) {
      Log.showWarn(TAG, `aboutToAppear, inset query failed: ${JSON.stringify(e)}`)
    }
    // Decide form factor once: tablet-width → iPad-style control card.
    try {
      let dis = display.getDefaultDisplaySync()
      let widthVp = dis.width / dis.densityPixels
      this.isWide = widthVp >= TABLET_MIN_WIDTH_VP
      // Needed on BOTH form factors now: the phone panel is also a card whose
      // open/close finger-drag travels its visual height (see cardTravelPx).
      this.dispHvp = dis.height / dis.densityPixels
      Log.showInfo(TAG, `aboutToAppear, widthVp=${widthVp} isWide=${this.isWide} dispHvp=${this.dispHvp}`)
    } catch (e) {
      Log.showWarn(TAG, `aboutToAppear, display query failed: ${JSON.stringify(e)}`)
    }
    // Establish a clean default for gesture-nav: the panel exists in the
    // tree but is not yet shown to the user.
    publishDropdownOpen(false)
    WindowManager.setWindowBgColor(WindowType.DROPDOWN_PANEL,'#00000000')
    CommonStyleManager.setAbilityPageName(TAG);
    StyleManager.setStyle();

    let dropdownRect: Rect = AbilityManager.getAbilityData(AbilityManager.ABILITY_NAME_DROPDOWN_PANEL, 'rect');
    let navigationBarRect: ConfigInfo = AbilityManager.getAbilityData(AbilityManager.ABILITY_NAME_NAVIGATION_BAR, 'config');
    this.initHelper(dropdownRect, navigationBarRect);
    this.resizeDropdownPanelAndNavigationBar(dropdownRect, navigationBarRect);
    Log.showDebug(TAG, `getValueSync componentOptAreaHeightPX: ${this.componentOptAreaHeightPX}`);

    // Initial state: fully off the top edge (H + topInset; see showSelf/hideSelf).
    this.componentOptAreaTranslateY = (-(this.componentOptAreaHeightPX + this.topInsetPx)) + 'px';

    this.mClearCallbacks = [];
    this.mClearCallbacks.push(
    EventManager.subscribe('DropdownEvent', (args: IArg) => this.onDropdownEvent(args)),
    EventManager.subscribe('DropdownDragStart', (args: DragArg) => this.onPanelDragStart(args)),
    EventManager.subscribe('DropdownDragUpdate', (args: DragArg) => this.onPanelDragUpdate(args)),
    EventManager.subscribe('DropdownDragEnd', (args: DragArg) => this.onPanelDragEnd(args)),
    EventManager.subscribe(START_ABILITY_EVENT, (args: IArg) => this.onStartAbility(args)),
    EventManager.subscribe('hideNotificationWindowEvent', (args: IArg) => this.onHideNotificationWindowEvent(args)));

    mHeightConfigUtils = new HeightConfigUtils();

    let StatusCoefficient = AppStorage.SetAndLink("StatusCoefficient", 1.0);
    StatusCoefficient.set(mHeightConfigUtils.getStatusCoefficient());

    let signalObserved = AppStorage.SetAndLink("signalObserved", false);
    signalObserved.set(false);

    this.mCallback = {
      "onStateChange": (data) => this.onStateChange(data),
      "onNotificationShowOrHide": (data) => this.onNotificationShowOrHide(data),
      "onControlShowOrHide": (data) => this.onControlShowOrHide(data)
    };
    NavigationEvent.registerCallback(this.mCallback);
    MultimodalInputManager.registerControlListener(this.mCallback);
    MultimodalInputManager.registerNotificationListener(this.mCallback);
    Log.showDebug(TAG, `aboutToAppear, end`);
  }

  private async initHelper(dropdownRect: Rect, navigationBarRect: ConfigInfo): Promise<void> {
    this.urivar = Constants.getUriSync(Constants.KEY_NAVIGATIONBAR_STATUS);
    this.helper = await dataShare.createDataShareHelper(AbilityManager.getContext(AbilityManager.ABILITY_NAME_DROPDOWN_PANEL), this.urivar);
    Log.showDebug(TAG, `initHelper ${this.helper}, uri: ${JSON.stringify(this.urivar)}`);
    this.helper?.on("dataChange", this.urivar, () => {
      this.resizeDropdownPanelAndNavigationBar(dropdownRect, navigationBarRect);
      Log.showInfo(TAG, `NavigationBar status change, componentOptAreaHeightPX: ${this.componentOptAreaHeightPX}`);
    });
  }

  onPageShow() {
    Log.showInfo(TAG, `onPageShow, start`)
    if (this.showComponentName === DropdownPanelComponentName.NONE) {
      return
    }
    // NOTE: do NOT call StatusBarVM.setUseInWindowName(DROPDOWN_PANEL) here.
    // There is one StatusBarVM singleton for the whole systemui process and that
    // call forces every status-bar icon's tint to #FFFFFFFF globally
    // (changeComponentContent gate). The panel renders its OWN status header
    // (control.ets/notification.ets) with explicit colours, so it doesn't need
    // the shared tint, and leaving the owner as STATUS_BAR keeps the real bar
    // tinted correctly.
    Trace.end(Trace.CORE_METHOD_START_DROPDOWNPANEL)
  }

  aboutToDisappear() {
    Log.showInfo(TAG, `aboutToDisappear`)
    this.mClearCallbacks&&this.mClearCallbacks.forEach((mClearCallback: Function | undefined) => {
      mClearCallback&&mClearCallback()
      mClearCallback = undefined
    })
    this.mClearCallbacks = undefined
  }

  resizeDropdownPanelAndNavigationBar(dropdownRect: Rect, navigationBarRect: ConfigInfo) {
    Log.showDebug(TAG, `resizeDropdownPanelAndNavigationBar, dropdownRect: ${JSON.stringify(dropdownRect)} navigationBarRect: ${JSON.stringify(navigationBarRect)}`)
    let context: Context = AbilityManager.getContext(AbilityManager.ABILITY_NAME_DROPDOWN_PANEL);
    if (context == undefined || context == null) {
      Log.showInfo(TAG, `resizeDropdownPanelAndNavigationBar: ${context}`);
      return;
    }
    try {
      this.mNavigationBarStatusDefaultValue = settings.getValueSync(context, this.settingDataKey, '1');
      this.componentOptAreaHeightPX = this.mNavigationBarStatusDefaultValue == '1' ? dropdownRect.height - navigationBarRect.realHeight : dropdownRect.height;
      this.navigationBarWidth = this.mNavigationBarStatusDefaultValue == '1' ? navigationBarRect.realHeight : 0;
    } catch (err) {
      Log.showError(TAG, `resizeDropdownPanelAndNavigationBar: ${context}, ${JSON.stringify(err)}`);
    }
    const currRect: Rect = {
      left: 0,
      top: 0,
      width: 0,
      height: this.navigationBarWidth
    };
    dropdownRect.height = this.componentOptAreaHeightPX;
    WindowManager.resetSizeWindow(WindowType.NAVIGATION_BAR, currRect);
    WindowManager.resetSizeWindow(WindowType.DROPDOWN_PANEL, dropdownRect );
  }

  onNotificationShowOrHide(data: inputConsumer.KeyOptions) {
    Log.showDebug(TAG, `mNotificationAsyncCallback preKeys: ${data.preKeys}, finalKey: ${data.finalKey}`);
    Log.showDebug(TAG, `this.showComponentName: ${this.showComponentName}`);
    if (this.showComponentName === DropdownPanelComponentName.NOTIFICATION) {
      this.hideSelf();
    } else {
      this.showSelf(DropdownPanelComponentName.NOTIFICATION);
    }
    Log.showDebug(TAG, `mNotificationAsyncCallback end`);
  }

  onControlShowOrHide(data: inputConsumer.KeyOptions) {
    Log.showDebug(TAG, `mControlAsyncCallback preKeys: ${data.preKeys}, finalKey: ${data.finalKey}`);
    Log.showDebug(TAG, `this.showComponentName: ${this.showComponentName}`);
    if (this.showComponentName === DropdownPanelComponentName.CONTROL_CENTER) {
      this.hideSelf();
    } else {
      this.showSelf(DropdownPanelComponentName.CONTROL_CENTER);
    }
    Log.showDebug(TAG, `mControlAsyncCallback end`);
  }

  onStateChange(data: string) {
    Log.showDebug(TAG, `onStateChange, data: ${JSON.stringify(data)}`)
    Log.showDebug(TAG, `onStateChange, showComponentName: ${this.showComponentName}`)
    if (this.showComponentName !== DropdownPanelComponentName.NONE) {
      this.hideSelf()
    }
  }

  onDropdownEvent(args: IArg) {
    Log.showDebug(TAG, `onDropdownEvent, args: ${JSON.stringify(args)}`)
    this.showSelf(args.dropdownArea == 'left' ? DropdownPanelComponentName.NOTIFICATION : DropdownPanelComponentName.CONTROL_CENTER)
  }

  onStartAbility(args: IArg) {
    Log.showDebug(TAG, `onStartAbility, args: ${args}`)
    this.hideSelf()
  }

  onHideNotificationWindowEvent(args: IArg) {
    Log.showDebug(TAG, `onHideNotificationWindowEvent, args: ${args}`)
    this.hideSelf()
  }

  onTouchMove(data: TouchMoveData) {
    Log.showDebug(TAG, `onTouchMove, data: ${JSON.stringify(data)}`)
    // 'top' direction handling lives in the root parallelGesture in
    // build() — Control's inner Scroll no longer preempts it.
    if (data.direction == 'top') {
      return
    } else if (data.direction == 'left' && data.touchComponent == 'notification') {
      this.switchNotificationOrControlCenter(DropdownPanelComponentName.CONTROL_CENTER)
    } else if (data.direction == 'right' && data.touchComponent == 'control') {
      this.switchNotificationOrControlCenter(DropdownPanelComponentName.NOTIFICATION)
    } else if (data.direction == 'drop_left' && data.touchComponent == 'control') {
      this.showComponentName = DropdownPanelComponentName.NOTIFICATION
    } else if (data.direction == 'drop_right' && data.touchComponent == 'notification') {
      this.showComponentName = DropdownPanelComponentName.CONTROL_CENTER
    }
  }

  switchNotificationOrControlCenter(showComponentName: DropdownPanelComponentName) {
    Log.showDebug(TAG, `switchNotificationOrControlCenter, showComponentName: ${showComponentName}`)
    this.mNotificationInsert = { type: TransitionType.Insert, opacity: 0, translate: { x: (-this.mWidthPx) + 'px' } }
    this.mControlCenterInsert = { type: TransitionType.Insert, opacity: 0, translate: { x: (this.mWidthPx) + 'px' } }
    let transitionDelete: TransitionOptions = {
      type: TransitionType.Delete,
      opacity: 0,
      scale: { x: 0.8, y: 0.8, centerX: '50%', centerY: '50%' }
    }
    this.mNotificationDelete = transitionDelete
    this.mControlCenterDelete = transitionDelete
    SHOW_ANIM_CONFIG.onFinish = () => {
      Log.showInfo(TAG, `switchNotificationOrControlCenter, show anim finish.`);
    }
    this._animateTo(SHOW_ANIM_CONFIG, () => {
      this.showComponentName = showComponentName
    })
  }

  // ----- Perma-shown window helpers -----
  // The panel window is shown ONCE at init (ServiceExtAbility pre-shows it) and
  // never hidden again. Opening just makes it touchable + starts rendering;
  // closing makes it non-touchable + stops rendering. This dodges (a) the ~1 s
  // cold-path lag of showWindow() after a foreground transition, and (b) the
  // RenderService surface teardown on hide() that tripped the Mali NULL+0x1d8
  // crash in RSRenderThread on every close. The real STATUS_BAR window is left
  // untouched — setWindowSystemBarEnable([]) (ServiceExtAbility) suppresses it
  // while the panel is foreground, so no expensive STATUS_BAR show/hide.
  private activatePanelWindow() {
    this.panelActive = true
    WindowManager.setWindowTouchable(WindowType.DROPDOWN_PANEL, true)
  }

  private cancelPendingClose() {
    if (this.closeTimer >= 0) {
      clearTimeout(this.closeTimer)
      this.closeTimer = -1
    }
  }

  // ----- Slide geometry (card travel) -----
  // The control / notification card is short and anchored near the top on BOTH
  // form factors, so its open/close slide travels only its own height
  // (cardTravelPx) rather than the full window height; this makes a top-drag
  // track the finger. True whenever a panel is shown.
  private isCardMode(): boolean {
    return this.showComponentName === DropdownPanelComponentName.CONTROL_CENTER
      || this.showComponentName === DropdownPanelComponentName.NOTIFICATION
  }
  // Distance (px) the CURRENT card slides between fully-closed (off the top) and
  // open: its visual height + top inset + edge margin. Control is fixed; the
  // notification card adapts to the live notification count, so this is per-panel.
  private cardTravelPx(): number {
    const visualVp = (this.showComponentName === DropdownPanelComponentName.NOTIFICATION)
      ? notifVisualHeightVp(this.isWide, this.dispHvp, this.notificationList.length)
      : cardVisualHeightVp(this.isWide, this.dispHvp)
    return this.topInsetPx + vp2px(visualVp + CARD_EDGE_MARGIN_VP)
  }
  // Distance over which finger displacement maps closed→open.
  private dragSpanPx(): number {
    return this.isCardMode() ? this.cardTravelPx() : this.componentOptAreaHeightPX
  }
  // translateY (px, negative) when fully closed, during a finger drag.
  private dragClosedPx(): number {
    return this.isCardMode() ? -this.cardTravelPx() : -this.componentOptAreaHeightPX
  }
  // translateY (px, negative) when fully closed, for show/hide spring animations.
  private showHideClosedPx(): number {
    return this.isCardMode()
      ? -this.cardTravelPx()
      : -(this.componentOptAreaHeightPX + this.topInsetPx)
  }

  showSelf(showComponentName: DropdownPanelComponentName) {
    Log.showInfo(TAG, `showSelf, showComponentName: ${showComponentName}, currentY=${this.componentOptAreaTranslateY}`)
    this.cancelPendingClose()
    // Set which component shows FIRST so isCardMode()/showHideClosedPx() pick the
    // right slide geometry, then force it fully off the top edge BEFORE it paints
    // so animateTo has a valid "from" state. Off-screen distance is the card's
    // travel on tablet, else H + topInset (the panel is topInset taller than the
    // body and offset up by topInset) so it doesn't pop in a status-bar-height short.
    this.showComponentName = showComponentName
    this.componentOptAreaTranslateY = this.showHideClosedPx() + 'px'
    this.backgroundOpacity = 0
    publishDropdownOpen(true)
    this.activatePanelWindow()
    Trace.start(Trace.CORE_METHOD_START_DROPDOWNPANEL)
    // Defer to next tick so the window finishes its first paint at -H before
    // the spring animation kicks the translate to 0.
    setTimeout(() => {
      Log.showInfo(TAG, `showSelf animateTo, fromY=${this.componentOptAreaTranslateY}`)
      this._animateTo(SHOW_ANIM_CONFIG, () => {
        this.componentOptAreaTranslateY = '0px'
        this.backgroundOpacity = 1
      })
    }, 150)
  }

  // ----- Finger-tracking drag from status bar -----
  // Status bar publishes DropdownDragStart on threshold cross, DropdownDragUpdate
  // on every subsequent move, DropdownDragEnd on touch up. We mirror the finger
  // position into componentOptAreaTranslateY in real time; on end we commit with
  // a spring snap to the closer endpoint (weighted by velocity).

  private dragActive: boolean = false

  onPanelDragStart(args: DragArg) {
    Log.showInfo(TAG, `onDragStart area=${args.area} dy=${args.dy}`)
    const area = args.area === 'left'
      ? DropdownPanelComponentName.NOTIFICATION
      : DropdownPanelComponentName.CONTROL_CENTER
    // Set the area FIRST so dragSpanPx()/dragClosedPx() pick the card geometry.
    this.showComponentName = area
    const span = this.dragSpanPx()
    const closed = this.dragClosedPx()
    const dy = Math.max(0, Math.min(args.dy ?? 0, span))
    // Render content at finger-tracked offset.
    this.cancelPendingClose()
    this.dragActive = true
    this.componentOptAreaTranslateY = (closed + dy) + 'px'
    this.backgroundOpacity = Math.min(dy / span, 1)
    publishDropdownOpen(true)
    // Perma-shown window: activate (touchable + start rendering) instead of
    // showWindow(). A mid-drag show used to steal the status bar's in-flight
    // touch and strand the pull halfway down (the "stuck in the middle" bug).
    this.activatePanelWindow()
  }

  onPanelDragUpdate(args: DragArg) {
    if (!this.dragActive) return
    const span = this.dragSpanPx()
    const closed = this.dragClosedPx()
    const dy = Math.max(0, Math.min(args.dy ?? 0, span))
    this.componentOptAreaTranslateY = (closed + dy) + 'px'
    this.backgroundOpacity = dy / span
  }

  onPanelDragEnd(args: DragArg) {
    if (!this.dragActive) return
    this.dragActive = false
    const span = this.dragSpanPx()
    const dy = args.dy ?? 0
    const vy = args.velocityY ?? 0
    // Commit threshold: 40% open OR moving fast enough downward.
    const shouldOpen = (dy > span * 0.4) || (vy > 800)
    Log.showInfo(TAG, `onDragEnd dy=${dy} vy=${vy} → ${shouldOpen ? 'OPEN' : 'CLOSE'}`)
    if (shouldOpen) {
      this._animateTo(SHOW_ANIM_CONFIG, () => {
        this.componentOptAreaTranslateY = '0px'
        this.backgroundOpacity = 1
      })
    } else {
      this.hideSelf()
    }
  }

  hideSelf() {
    Log.showDebug(TAG, `hideSelf`)
    SHOW_ANIM_CONFIG.onFinish = () => {
      Log.showInfo(TAG, `hideSelf, hide anim finish.`);
    };
    // Clear the gesture-nav suspend flag synchronously: the panel is no
    // longer the user's intent target the moment hideSelf is called.
    publishDropdownOpen(false)
    // Stop capturing touches immediately — the panel is closing, so taps should
    // fall through to the app during the slide-out. panelActive stays true so
    // the panel keeps RENDERING as it slides all the way off the top edge; it's
    // torn down only after the spring settles (see _animateTo).
    WindowManager.setWindowTouchable(WindowType.DROPDOWN_PANEL, false)
    // Clear the dim SYNCHRONOUSLY (outside any animateTo) so it disappears at
    // once — no spring tail. The dim is EXPOSED around the card on both form
    // factors, so a spring-animated fade would leave a faint full-screen dim
    // darkening the home screen for ~1s after the card has already slid away.
    this.backgroundOpacity = 0
    this._animateTo(SHOW_ANIM_CONFIG, () => {
      // Slide the panel/card FULLY off the top edge so its bottom clears y=0 —
      // otherwise it stops ~one status-bar-height short, leaving a strip that
      // lingers until panelActive flips. showHideClosedPx() is read here (before
      // showComponentName flips to NONE below) so the card still uses card travel.
      this.componentOptAreaTranslateY = this.showHideClosedPx() + 'px'
      this.showComponentName = DropdownPanelComponentName.NONE
    }, true)
  }

  _animateTo(config: AnimateParam, callback: () => void, ishideWindow: boolean = false) {
    Log.showDebug(TAG, `_animateTo, config: ${JSON.stringify(config)}`)
    animateTo(config, callback)
    if (ishideWindow) {
      // Tear the panel down (stop rendering) only AFTER the close spring has
      // fully settled, so it slides ALL the way off the top edge instead of
      // vanishing ~one status-bar-height short. The window stays shown (no
      // hide() → no cold-path reopen lag, no Mali RSRenderThread teardown crash,
      // Bug 8.17); panelActive=false just makes the off-screen surface paint
      // nothing. Cancelable so a reopen mid-slide doesn't tear down the reopened
      // panel. Touchability was already dropped in hideSelf.
      this.cancelPendingClose()
      this.closeTimer = setTimeout(() => {
        this.closeTimer = -1
        this.panelActive = false
      }, PANEL_SETTLE_MS)
    }
  }

  // Close-drag tracking — when the user pulls upward on the open panel we
  // mirror the finger pull into translateY, then commit on release.
  private closeDragActive: boolean = false
  private closeDragStartY: number = 0
  private closeDragLastY: number = 0
  private closeDragLastT: number = 0
  private closeDragVelocityY: number = 0

  build() {
    Stack({ alignContent: Alignment.Top }) {
      // Everything inside is gated on `panelActive`: the window is permanently
      // shown, so when the panel is closed it must paint a fully-transparent
      // surface (render nothing) — otherwise the always-present window would
      // cover the screen below.
      if (this.panelActive) {
        // Dim overlay over the content below. Opacity tracks pull progress
        // (backgroundOpacity is 0..1, driven by onPanelDragUpdate/showSelf).
        // Grown by both insets and lifted by the top inset so it dims the whole
        // screen including the status-bar strip above the safe area.
        Column()
          .width('100%')
          .height(`calc(100% + ${this.topInsetPx + this.bottomInsetPx}px)`)
          .offset({ y: -this.topInsetPx })
          // Gate the dim on there being a component to dim FOR: when the panel is
          // closed (showComponentName === NONE) the dim must be fully transparent
          // regardless of backgroundOpacity. panelActive lingers ~1.2s after a
          // close so the card can finish sliding off; without this gate a stray
          // re-dim (e.g. a snap-back-open firing after the close already
          // committed) could raise backgroundOpacity back to 1 over a card-less
          // panel, darkening the whole home screen until panelActive tears down
          // ("panel disappears but the home screen stays dimmed for a second").
          .backgroundColor(this.showComponentName === DropdownPanelComponentName.NONE
            ? 'rgba(0,0,0,0)'
            : `rgba(0,0,0,${0.45 * this.backgroundOpacity})`)
          // Both form factors float a card over the dim, so the dim is exposed
          // around it: a tap outside the card dismisses (iPad / iOS behaviour).
          .onClick(() => {
            this.hideSelf()
          })
        // Panel container — the bg image is INSIDE so it slides with the panel
        // instead of appearing as a full-screen flash.
        Stack({ alignContent: Alignment.TopStart }) {
          // No full-bleed panel background on either form factor: the control /
          // notification cards (control.ets / notification.ets) bring their OWN
          // frosted-glass background, and what shows around them is the dim layer
          // above. A full-screen image here would cover that tap-to-close dim.
          Column() {
            if (this.showComponentName === DropdownPanelComponentName.NOTIFICATION) {
              Notification({
                touchMoveCallback: (data: TouchMoveData): void => this.onTouchMove(data),
                isWide: this.isWide
              })
                .transition(this.mNotificationInsert)
                .transition(this.mNotificationDelete)
            }
            if (this.showComponentName === DropdownPanelComponentName.CONTROL_CENTER) {
              ControlCenterComponent({
                touchMoveCallback: (data: TouchMoveData): void => this.onTouchMove(data),
                isWide: this.isWide
              })
                .transition(this.mControlCenterInsert)
                .transition(this.mControlCenterDelete)
            }
          }
          .width('100%')
          .height('100%')
          // Tablet cards: control hugs the RIGHT edge, notification the LEFT; touches
          // outside the card fall through to the dim below (tap-to-close).
          // HitTestMode.None keeps the card itself (a child) interactive while not
          // blocking the dim.
          .alignItems(this.isWide && this.showComponentName === DropdownPanelComponentName.CONTROL_CENTER
            ? HorizontalAlign.End
            : (this.isWide && this.showComponentName === DropdownPanelComponentName.NOTIFICATION
              ? HorizontalAlign.Start : HorizontalAlign.Center))
          .hitTestBehavior(this.isCardMode() ? HitTestMode.None : HitTestMode.Default)
          // Push the panel CONTENT (the card) down so it clears the status-bar
          // avoid line and floats just below the real system status bar (which
          // stays visible above it). The legacy WMS clips panel foreground content
          // to the safe area (origin at the status-bar inset), and the matching
          // .offset({y:-topInset}) below lifts the whole container up so the dim
          // reaches y=0 and a full close-translate carries the card off the top
          // edge; this padding compensates so the card itself lands below the line.
          .padding({ top: this.topInsetPx - 12 })
        }
        .width('100%')
        // Height = body height + top inset: the extra topInset compensates for
        // the -topInset offset below so the panel's bottom still meets the nav
        // bar (no gap), while its top reaches screen y=0.
        .height((this.componentOptAreaHeightPX + this.topInsetPx) + 'px')
        .translate({ y: this.componentOptAreaTranslateY })
        // Lift the whole panel up by the top inset so its background reaches
        // screen y=0 (covering the system status bar) and a full close-translate
        // (translateY = -H) carries it fully off the top edge. The content's
        // matching top padding keeps the header on-screen at y=0.
        .offset({ y: -this.topInsetPx })
        // Tablet cards: the full-size sliding container must not eat taps outside
        // the card — pass them through to the dim (tap-to-close).
        .hitTestBehavior(this.isCardMode() ? HitTestMode.None : HitTestMode.Default)
      }
    }
    .width('100%')
    .height('100%')
    // parallelGesture (vs .gesture) so the close-PanGesture also fires
    // when the Control center is shown — Control wraps its content in
    // a Scroll (control.ets:69) which would otherwise grab the vertical
    // pan and preempt the parent. parallelGesture lets both compete:
    // the Scroll handles its own overflow (none today, but defensive),
    // and the close-PanGesture also tracks the finger so the panel
    // slides up under the finger. Notification has no inner Scroll so
    // it was already working via .gesture; parallelGesture is a strict
    // superset of that behaviour.
    .parallelGesture(
      PanGesture({ direction: PanDirection.Up, distance: 5 })
        .onActionStart((e: GestureEvent) => {
          if (this.showComponentName === DropdownPanelComponentName.NONE) return
          this.closeDragActive = true
          // GestureEvent.localY is in vp; translateY / dragSpanPx() are in px, so
          // convert to px here to keep finger displacement, the slide travel and
          // the dim ratio in the SAME unit (a vp/px mix made dyTotal ~half its
          // true px value: thresholds never tripped and the dim never reached 0).
          const startVp = e.fingerList[0]?.localY
          this.closeDragStartY = (startVp === undefined) ? 0 : vp2px(startVp)
          this.closeDragLastY = this.closeDragStartY
          this.closeDragLastT = Date.now()
          this.closeDragVelocityY = 0
        })
        .onActionUpdate((e: GestureEvent) => {
          if (!this.closeDragActive) return
          // Panel closed mid-drag — stop mirroring the finger (don't re-dim a
          // card-less panel).
          if (this.showComponentName === DropdownPanelComponentName.NONE) return
          const curVp = e.fingerList[0]?.localY
          const curY = (curVp === undefined) ? this.closeDragLastY : vp2px(curVp)  // px
          const dyTotal = curY - this.closeDragStartY  // negative when pulling up
          const now = Date.now()
          const dt = Math.max(now - this.closeDragLastT, 1)
          this.closeDragVelocityY = ((curY - this.closeDragLastY) / dt) * 1000
          this.closeDragLastY = curY
          this.closeDragLastT = now
          const span = this.dragSpanPx()
          // dyTotal is negative; translateY ranges from -span (closed) to 0 (open)
          const ty = Math.max(-span, Math.min(0, dyTotal))
          this.componentOptAreaTranslateY = ty + 'px'
          this.backgroundOpacity = 1 + (ty / span) // 1 at open (ty=0), 0 at closed (ty=-span)
        })
        .onActionEnd((e: GestureEvent) => {
          if (!this.closeDragActive) return
          this.closeDragActive = false
          // If the panel was already closed out from under this gesture (another
          // close path committed mid-drag, flipping showComponentName to NONE),
          // do NOT snap it back open — that re-raises the dim over a card-less
          // panel and leaves the home screen dimmed until panelActive tears down.
          if (this.showComponentName === DropdownPanelComponentName.NONE) return
          const span = this.dragSpanPx()
          const curVp = e.fingerList[0]?.localY
          const curY = (curVp === undefined) ? this.closeDragLastY : vp2px(curVp)  // px
          const dyTotal = curY - this.closeDragStartY  // negative
          const vy = this.closeDragVelocityY            // negative = up
          // Close only if (a) pulled up past 50% of the slide span, OR
          // (b) pulled past 15% AND released with a clear upward flick.
          // The 1500 px/s velocity gate filters out release-jitter; the 15%
          // minimum displacement keeps small drags that just release from
          // being interpreted as a flick.
          const shouldClose = (dyTotal < -span * 0.5)
            || ((dyTotal < -span * 0.15) && (vy < -1500))
          Log.showInfo(TAG, `closeDrag end dy=${dyTotal} vy=${vy} span=${span} → ${shouldClose ? 'CLOSE' : 'STAY_OPEN'}`)
          if (shouldClose) {
            this.hideSelf()
          } else {
            this._animateTo(SHOW_ANIM_CONFIG, () => {
              this.componentOptAreaTranslateY = '0px'
              this.backgroundOpacity = 1
            })
          }
        })
        .onActionCancel(() => {
          if (!this.closeDragActive) return
          this.closeDragActive = false
          // Don't snap back open if the panel already closed mid-gesture (would
          // re-dim a card-less panel).
          if (this.showComponentName === DropdownPanelComponentName.NONE) return
          // Snap back to open
          this._animateTo(SHOW_ANIM_CONFIG, () => {
            this.componentOptAreaTranslateY = '0px'
            this.backgroundOpacity = 1
          })
        })
    )
    .onAreaChange((e, e2) => {
      Log.showInfo(TAG, `onAreaChange, e: ${JSON.stringify(e)} e2: ${JSON.stringify(e2)}`);
      this.mWidthPx = vp2px(Number(e2.width))
    })
  }
}
