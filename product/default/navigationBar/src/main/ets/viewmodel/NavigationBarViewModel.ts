//@ts-nocheck
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

import Log from '../../../../../../../common/src/main/ets/default/Log';
import WindowManager, { WindowType } from '../../../../../../../common/src/main/ets/default/WindowManager';
import getSingleInstance from '../../../../../../../common/src/main/ets/default/SingleInstanceHelper';
import TintStateManager, { TintState, TintStateListener
} from '../../../../../../../common/src/main/ets/default/TintStateManager';
import { NavigationBarComponentData, NAVIGATIONBAR_HIDE_EVENT, NAVIGATIONBAR_SHOW_EVENT } from '../common/constants';
import dataShare from '@ohos.data.dataShare';
import settings from '@ohos.settings';
import commonEvent from '@ohos.commonEvent';
import display from '@ohos.display';
import AbilityManager from '../../../../../../../common/src/main/ets/default/abilitymanager/abilityManager';
import Constants from '../../../../../../../common/src/main/ets/default/Constants';

const TAG = 'NavigationBarViewModel';

const NAVIGATION_BAE_VIEW_MODEL_KEY = 'AppStorage_NavigationBarViewModel';

const NAVIGATION_BAR_COMPONENT_DATA_KEY = 'AppStorage_NavigationBarComponentData';

const RETRY_INTERVAL_MS = 1500;

const MAX_RETRY_TIME = 5;

export default class NavigationBarViewModel {
  private readonly settingDataKey = 'settings.display.navigationbar_status';
  private readonly urivar: string;
  private readonly helper: dataShare.DataShareHelper;
  private readonly navigationBarStatusDefaultValue = '1';
  private isDisplay = true;
  // Gesture-navigation mode keeps the nav-bar window shown as a thin
  // home-indicator strip (instead of hiding it), so the window manager still
  // reports a bottom avoid area / safe-area inset to apps and the indicator
  // pill doesn't overlap app content. 24vp ≈ the home-indicator zone.
  private readonly gestureIndicatorVp = 24;
  private gestureMode = false;
  mNavigationBarComponentData: NavigationBarComponentData  = {
    ...new NavigationBarComponentData()
  };
  mUseCount = 0;

  static getInstance(): NavigationBarViewModel {
    return getSingleInstance(NavigationBarViewModel, NAVIGATION_BAE_VIEW_MODEL_KEY);
  }

  constructor() {
    Log.showInfo(TAG, 'constructor');
    this.mNavigationBarComponentData =
    AppStorage.SetAndLink(NAVIGATION_BAR_COMPONENT_DATA_KEY, this.mNavigationBarComponentData).get()
    if (AbilityManager.getContext(AbilityManager.ABILITY_NAME_NAVIGATION_BAR) == null) {
      Log.showError(TAG, 'AbilityManager.getContext() is null');
    } else {
      Log.showInfo(TAG, 'context: ' + AbilityManager.getContext(AbilityManager.ABILITY_NAME_NAVIGATION_BAR));
    }
    this.initNavigationBarStatus();
    this.initHelper(this.dataChangesCallback.bind(this), MAX_RETRY_TIME);
  }

  private async initHelper(callback: () => void, retryTimes: number): Promise<void> {
    if (retryTimes < 1) {
      Log.showInfo(TAG, 'initHelper, retry too many times');
      return;
    }
    Log.showInfo(TAG, 'initHelper in, retry times: %{public}d', MAX_RETRY_TIME - retryTimes + 1);
    this.urivar = Constants.getUriSync(Constants.KEY_NAVIGATIONBAR_STATUS);
    try {
      this.helper = await dataShare.createDataShareHelper(AbilityManager.getContext(AbilityManager.ABILITY_NAME_NAVIGATION_BAR), this.urivar);
      Log.showInfo(TAG, 'initHelper, helper: ' + this.helper + ', uri: ' + this.urivar);
      this.helper.on('dataChange', this.urivar, () => {
        Log.showInfo(TAG, 'onDataChange.');
        callback();
      });
    } catch (err) {
      Log.showError(TAG, 'initHelper error, code: ' + err?.code + ', message: ' + err?.message);
      await this.sleep(RETRY_INTERVAL_MS);
      this.initHelper(this.dataChangesCallback.bind(this), retryTimes - 1);
    }
  }

  private sleep (time: number) {
    return new Promise(resolve => {
      setTimeout(resolve, time);
    })
  }

  install(): void {
    Log.showDebug(TAG, `install, useCount: ${this.mUseCount}`);
    if (!this.mUseCount) {
      TintStateManager.getInstance().registerListener('navigation', this as TintStateListener);
    }
    this.mUseCount++;
  }

  uninstall(): void {
    Log.showDebug(TAG, `uninstall, useCount: ${this.mUseCount}`);
    this.mUseCount--;
    if (this.mUseCount) {
      TintStateManager.getInstance().unregisterListener('navigation');
    }
  }

  getNavigationBarComponentData(): NavigationBarComponentData {
    Log.showDebug(TAG, 'getNavigationBarComponentData');
    return this.mNavigationBarComponentData;
  }

  onTintStateChange(tintState: TintState): void {
    Log.showDebug(TAG, `onTintStateChange, tintState: ${JSON.stringify(tintState)}`);
    if (typeof (tintState.isEnable) == 'boolean') {
      this.setWindowEnable(tintState.isEnable);
    }
    if (tintState.backgroundColor) {
      this.mNavigationBarComponentData.backgroundColor = tintState.backgroundColor;
    }
    if (tintState.contentColor) {
      this.mNavigationBarComponentData.contentColor = tintState.contentColor;
    }
    Log.showDebug(TAG, `onTintStateChange, backgroundColor ${this.mNavigationBarComponentData.backgroundColor},
      contentColor ${this.mNavigationBarComponentData.contentColor}`);
  }

  setWindowEnable(isEnable: boolean): void {
    Log.showDebug(TAG, `setWindowEnable, isEnable ${String(isEnable)}`);
    if (this.mNavigationBarComponentData.isEnable == isEnable) {
      return;
    }
    this.mNavigationBarComponentData.isEnable = isEnable;
    if (isEnable && this.isDisplay) {
      WindowManager.showWindow(WindowType.NAVIGATION_BAR).then(() => {
      }).catch((err) => {
      });
    } else {
      WindowManager.hideWindow(WindowType.NAVIGATION_BAR).then(() => {
      }).catch((err) => {
      });
    }
  }

  private setValue(value: string): void {
    let context = AbilityManager.getContext(AbilityManager.ABILITY_NAME_NAVIGATION_BAR);
    if (context == undefined || context == null) {
      Log.showInfo(TAG, `setValue: ${context}`);
      return;
    }
    try {
      settings.setValueSync(context, this.settingDataKey, value);
    } catch (err) {
      Log.showError(TAG, `setValue: ${context}, ${JSON.stringify(err)}`);
    }
  }

  private getValue(defaultValue?: string): string {
    let context = AbilityManager.getContext(AbilityManager.ABILITY_NAME_NAVIGATION_BAR);
    if (context == undefined || context == null) {
      Log.showInfo(TAG, `getValue: ${context}`);
      return defaultValue ? defaultValue : this.navigationBarStatusDefaultValue;
    }
    try {
      return settings.getValueSync(
        context, this.settingDataKey, defaultValue ? defaultValue : this.navigationBarStatusDefaultValue
      );
    } catch (err) {
      Log.showError(TAG, `getValue: ${context}, ${JSON.stringify(err)}`);
      return defaultValue ? defaultValue : this.navigationBarStatusDefaultValue;
    }
  }

  /**
   * Initialize the NavigationBar status.
   */
  initNavigationBarStatus(): void {
    try {
      let initValue = this.getValue();
      Log.showInfo(TAG, `initNavigationBarStatus initValue ${initValue}`);
      this.windowSwitches(initValue);
    } catch (e) {
      Log.showError(TAG, `initNavigationBarStatus error:  ${e.toString()}`);
    }
  }

  /**
   * Get NavigationBar status data.
   * @return
   */
  dataChangesCallback(): void {
    let getRetValue = this.getValue();
    Log.showInfo(TAG, `dataChangesCallback initValue ${getRetValue}`);
    this.windowSwitches(getRetValue);
  }

  /**
   * Geometry of the nav-bar window for the active mode.
   * - 3-button mode: the full button bar (rect from NavBarConfiguration).
   * - gesture mode: a thin home-indicator strip pinned to the bottom edge,
   *   as wide as the screen. Keeping a real TYPE_NAVIGATION_BAR window shown
   *   (rather than hiding it) is what makes the window manager report a
   *   bottom avoid area to apps in gesture mode.
   */
  private getNavBarRect(gesture: boolean): { left: number, top: number, width: number, height: number } {
    let config = AbilityManager.getAbilityData(AbilityManager.ABILITY_NAME_NAVIGATION_BAR, 'config');
    let maxWidth = config?.maxWidth ?? 0;
    let maxHeight = config?.maxHeight ?? 0;
    if (!gesture) {
      return {
        left: config?.xCoordinate ?? 0,
        top: config?.yCoordinate ?? 0,
        width: config?.realWidth ?? maxWidth,
        height: config?.realHeight ?? 0
      };
    }
    let density = 2;
    try {
      density = display.getDefaultDisplaySync().densityPixels;
    } catch (err) {
      Log.showError(TAG, `getDefaultDisplaySync failed: ${JSON.stringify(err)}`);
    }
    let height = Math.round(this.gestureIndicatorVp * density);
    return { left: 0, top: maxHeight - height, width: maxWidth, height: height };
  }

  private windowSwitches(navigationBarStatusValue: string): void {
    let gesture = navigationBarStatusValue == '0';
    this.gestureMode = gesture;
    // The nav-bar window is shown in BOTH modes now. Surface the mode to the
    // window's UI (pages/index) so it draws the home-indicator pill in gesture
    // mode and the 3 buttons otherwise.
    AppStorage.SetOrCreate('navBarGestureMode', gesture);
    // The window participates in both modes; only its size differs. It is only
    // hidden when an app opts out of the nav bar (isEnable=false, e.g. an
    // immersive/full-screen surface).
    this.isDisplay = true;
    let rect = this.getNavBarRect(gesture);
    WindowManager.resetSizeWindow(WindowType.NAVIGATION_BAR, rect).then(() => {
      // In gesture mode the strip is a passive indicator: make it
      // non-touchable so the bottom-edge swipe reaches the gesture recogniser
      // (which reads raw touches off inputMonitor) instead of being consumed
      // by this window. In 3-button mode the buttons must stay tappable.
      WindowManager.setWindowTouchable(WindowType.NAVIGATION_BAR, !gesture);
      if (this.mNavigationBarComponentData.isEnable) {
        WindowManager.showWindow(WindowType.NAVIGATION_BAR).catch((err) => {
          Log.showError(TAG, `showWindow err: ${JSON.stringify(err)}`);
        });
      } else {
        WindowManager.hideWindow(WindowType.NAVIGATION_BAR).catch((err) => {
          Log.showError(TAG, `hideWindow err: ${JSON.stringify(err)}`);
        });
      }
      // Tell the launcher about the mode change. HIDE (gesture) makes it reserve
      // the indicator-strip inset and start its swipe monitor; SHOW (3-button)
      // makes it stop that monitor — otherwise the monitor keeps pilfering the
      // nav bar's button taps (delivering a CANCEL instead of an UP), so the
      // buttons appear dead until a reboot. The launcher can't read this setting
      // itself reliably, so this push is its only dependable signal.
      const navEvent = gesture ? NAVIGATIONBAR_HIDE_EVENT : NAVIGATIONBAR_SHOW_EVENT;
      commonEvent.publish(navEvent, (err) => {
        if (err.code) {
          Log.showError(TAG, `${navEvent} PublishCallBack err: ${JSON.stringify(err)}`);
        } else {
          Log.showInfo(TAG, `${navEvent} Publish sucess`);
        }
      });
    }).catch((err) => {
      Log.showError(TAG, `resetSizeWindow err: ${JSON.stringify(err)}`);
    });
  }
}