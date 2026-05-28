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
import Log from '../../../../../../../common/src/main/ets/default/Log'
import Trace from '../../../../../../../common/src/main/ets/default/Trace'
import WindowManager, { WindowType, WINDOW_SHOW_HIDE_EVENT
} from '../../../../../../../common/src/main/ets/default/WindowManager'
import EventManager, { unsubscribe } from "../../../../../../../common/src/main/ets/default/event/EventManager"
import { START_ABILITY_EVENT } from "../../../../../../../common/src/main/ets/default/event/EventUtil"
import CommonStyleManager from '../../../../../../../common/src/main/ets/default/CommonStyleManager'
import MultimodalInputManager from '../../../../../../../common/src/main/ets/default/MultimodalInputManager'
import HeightConfigUtils from '../../../../../../../common/src/main/ets/default/heightcofigUtils/HeightConfigUtils'
import StatusBarVM from '../../../../../../../features/statusbarcomponent/src/main/ets/com/ohos/viewmodel/StatusBarVM'
import NavigationEvent, { NavigationCallBack } from './common/navigationEvent'
import Notification from './notification'
import ControlCenterComponent from './control'
import StyleManager from './common/StyleManager'
import dataShare from '@ohos.data.dataShare';
import settings from '@ohos.settings';
import curves from '@ohos.curves';
import Constants from "../../../../../../../common/src/main/ets/default/Constants";
import { TouchMoveData, Rect, ConfigInfo } from '@ohos/common';
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

  onBackPress(): boolean {
    return true
  }

  aboutToAppear() {
    Log.showInfo(TAG, `aboutToAppear, start`);
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

    this.componentOptAreaTranslateY = (-this.componentOptAreaHeightPX) + 'px';

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
    StatusBarVM.setUseInWindowName(WindowType.DROPDOWN_PANEL)
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

  showSelf(showComponentName: DropdownPanelComponentName) {
    Log.showInfo(TAG, `showSelf, showComponentName: ${showComponentName}, currentY=${this.componentOptAreaTranslateY}`)
    // Force the panel off-screen BEFORE the window paints so animateTo has a
    // valid "from" state to animate from.
    this.componentOptAreaTranslateY = (-this.componentOptAreaHeightPX) + 'px'
    this.backgroundOpacity = 0
    this.showComponentName = showComponentName
    publishDropdownOpen(true)
    WindowManager.showWindow(WindowType.DROPDOWN_PANEL)
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
    const H = this.componentOptAreaHeightPX
    const dy = args.dy ?? 0
    // Open the window if not already, render content at finger-tracked offset.
    this.dragActive = true
    this.componentOptAreaTranslateY = (-H + Math.min(dy, H)) + 'px'
    this.backgroundOpacity = Math.min(dy / H, 1)
    this.showComponentName = area
    publishDropdownOpen(true)
    WindowManager.showWindow(WindowType.DROPDOWN_PANEL)
  }

  onPanelDragUpdate(args: DragArg) {
    if (!this.dragActive) return
    const H = this.componentOptAreaHeightPX
    const dy = Math.max(0, Math.min(args.dy ?? 0, H))
    this.componentOptAreaTranslateY = (-H + dy) + 'px'
    this.backgroundOpacity = dy / H
  }

  onPanelDragEnd(args: DragArg) {
    if (!this.dragActive) return
    this.dragActive = false
    const H = this.componentOptAreaHeightPX
    const dy = args.dy ?? 0
    const vy = args.velocityY ?? 0
    // Commit threshold: 40% open OR moving fast enough downward.
    const shouldOpen = (dy > H * 0.4) || (vy > 800)
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
    // longer the user's intent target the moment hideSelf is called,
    // even though the slide-out animation still has ~450 ms to play.
    publishDropdownOpen(false)
    this._animateTo(SHOW_ANIM_CONFIG, () => {
      this.componentOptAreaTranslateY = (-this.componentOptAreaHeightPX) + 'px'
      this.backgroundOpacity = 0
      this.showComponentName = DropdownPanelComponentName.NONE
    }, true)
  }

  _animateTo(config: AnimateParam, callback: () => void, ishideWindow: boolean = false) {
    Log.showDebug(TAG, `_animateTo, config: ${JSON.stringify(config)}`)
    animateTo(config, callback)
    if (ishideWindow) {
      const delay = Number(config.duration) + Number(config.delay)
      setTimeout(() => WindowManager.hideWindow(WindowType.DROPDOWN_PANEL), delay)
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
      // Dim overlay over the content below. Opacity tracks pull progress
      // (backgroundOpacity is 0..1, driven by onPanelDragUpdate/showSelf).
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(`rgba(0,0,0,${0.45 * this.backgroundOpacity})`)
      // Panel container — the bg image is INSIDE so it slides with the panel
      // instead of appearing as a full-screen flash.
      Stack({ alignContent: Alignment.TopStart }) {
        Image($r("app.media.dropdownpanel_bgc"))
          .width('100%')
          .height('100%')
          .objectFit(ImageFit.Fill)
          .blur(25)
        Column() {
          if (this.showComponentName === DropdownPanelComponentName.NOTIFICATION) {
            Notification({ touchMoveCallback: (data: TouchMoveData): void => this.onTouchMove(data) })
              .transition(this.mNotificationInsert)
              .transition(this.mNotificationDelete)
          }
          if (this.showComponentName === DropdownPanelComponentName.CONTROL_CENTER) {
            ControlCenterComponent({
              touchMoveCallback: (data: TouchMoveData): void => this.onTouchMove(data)
            })
              .transition(this.mControlCenterInsert)
              .transition(this.mControlCenterDelete)
          }
        }
        .width('100%')
        .height('100%')
      }
      .width('100%')
      .height(this.componentOptAreaHeightPX + 'px')
      .translate({ y: this.componentOptAreaTranslateY })
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
          this.closeDragStartY = e.fingerList[0]?.localY ?? 0
          this.closeDragLastY = this.closeDragStartY
          this.closeDragLastT = Date.now()
          this.closeDragVelocityY = 0
        })
        .onActionUpdate((e: GestureEvent) => {
          if (!this.closeDragActive) return
          const curY = e.fingerList[0]?.localY ?? this.closeDragLastY
          const dyTotal = curY - this.closeDragStartY  // negative when pulling up
          const now = Date.now()
          const dt = Math.max(now - this.closeDragLastT, 1)
          this.closeDragVelocityY = ((curY - this.closeDragLastY) / dt) * 1000
          this.closeDragLastY = curY
          this.closeDragLastT = now
          const H = this.componentOptAreaHeightPX
          // dyTotal is negative; translateY ranges from -H (closed) to 0 (open)
          const ty = Math.max(-H, Math.min(0, dyTotal))
          this.componentOptAreaTranslateY = ty + 'px'
          this.backgroundOpacity = 1 + (ty / H) // 1 at open (ty=0), 0 at closed (ty=-H)
        })
        .onActionEnd((e: GestureEvent) => {
          if (!this.closeDragActive) return
          this.closeDragActive = false
          const H = this.componentOptAreaHeightPX
          const curY = e.fingerList[0]?.localY ?? this.closeDragLastY
          const dyTotal = curY - this.closeDragStartY  // negative
          const vy = this.closeDragVelocityY            // negative = up
          // Close only if (a) pulled up past 50% of panel height, OR
          // (b) pulled past 15% AND released with a clear upward flick.
          // The 1500 px/s velocity gate filters out release-jitter; the 15%
          // minimum displacement keeps small drags that just release from
          // being interpreted as a flick.
          const shouldClose = (dyTotal < -H * 0.5)
            || ((dyTotal < -H * 0.15) && (vy < -1500))
          Log.showInfo(TAG, `closeDrag end dy=${dyTotal} vy=${vy} → ${shouldClose ? 'CLOSE' : 'STAY_OPEN'}`)
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
