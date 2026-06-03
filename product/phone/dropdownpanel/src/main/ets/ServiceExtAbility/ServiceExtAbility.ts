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

import ServiceExtension from '@ohos.app.ability.ServiceExtensionAbility';
import display from '@ohos.display';
import Log from '../../../../../../../common/src/main/ets/default/Log';
import WindowManager, { WindowType } from '../../../../../../../common/src/main/ets/default/WindowManager';
import AbilityManager from '../../../../../../../common/src/main/ets/default/abilitymanager/abilityManager';
import NavBarConfiguration from '../../../../../../../features/navigationservice/src/main/ets/com/ohos/navigationservice/common/NavBarConfiguration';
import { Want } from '@kit.AbilityKit';


const TAG = 'DropdownPanel_ServiceExtAbility';

class ServiceExtAbility extends ServiceExtension {
  async onCreate(want: Want): Promise<void> {
    Log.showInfo(TAG, `onCreate, want: ${JSON.stringify(want)}`);
    AbilityManager.setContext(AbilityManager.ABILITY_NAME_DROPDOWN_PANEL, this.context);
    AbilityManager.setContext(AbilityManager.ABILITY_NAME_NAVIGATION_BAR, this.context);
    let defaultConfigInfo = await NavBarConfiguration.getConfiguration();
    let configInfo = NavBarConfiguration.setCustomConfiguration(defaultConfigInfo);
    AbilityManager.setAbilityData(AbilityManager.ABILITY_NAME_NAVIGATION_BAR, 'config', configInfo);
    Log.showDebug(TAG, `onCreate, configInfo: ${JSON.stringify(configInfo)}`);
    globalThis[AbilityManager.ABILITY_NAME_OWNER_WANT] = want;

    display.getDefaultDisplay().then((dis) => {
      let rect = {
        left: 0,
        top: 0,
        width: dis.width,
        height: dis.height,
      };
      AbilityManager.setAbilityData(AbilityManager.ABILITY_NAME_DROPDOWN_PANEL, 'rect', rect);
      WindowManager.createWindow(this.context, WindowType.DROPDOWN_PANEL, rect, 'pages/index').then( async (win) => {
        // Let the panel draw to the very top edge (y=0) over the system status
        // bar so its OWN status-bar header is the single visible bar and the
        // close animation can slide the whole panel off the top edge. Two steps,
        // both required on the legacy WMS:
        //   - setWindowLayoutFullScreen(true): full-screen ArkUI viewport.
        //   - setWindowSystemBarEnable([]): drops the status-bar avoid area —
        //     WITHOUT it the page content is clipped at the status-bar line
        //     (expandSafeArea is not honoured here). It also suppresses the
        //     system STATUS_BAR window while the panel is foreground, so the
        //     panel's own header is the single bar (no double bar, and no
        //     explicit STATUS_BAR show/hide which would cost ~1 s per toggle).
        try {
          await win.setWindowLayoutFullScreen(true);
          await win.setWindowSystemBarEnable([]);
        } catch (e) {
          Log.showWarn(TAG, `dropdown immersive setup failed: ${JSON.stringify(e)}`);
        }
        // Pre-show the panel ONCE and keep it shown for the process lifetime.
        // Toggling showWindow()/hide() per open/close paid a ~1 s cold-path lag
        // on reopen and churned the RenderService surface — the surface teardown
        // on hide() is what tripped the Mali NULL+0x1d8 crash in RSRenderThread
        // on close. While "closed" the page renders nothing (panelActive=false →
        // transparent) and the window is non-touchable, so it neither covers the
        // screen nor captures touches. index.ets flips touchability + rendering.
        try {
          await win.setWindowTouchable(false);
        } catch (e) {
          Log.showWarn(TAG, `dropdown pre-show setTouchable failed: ${JSON.stringify(e)}`);
        }
        win.showWindow().catch((e: Error) => {
          Log.showWarn(TAG, `dropdown pre-show failed: ${JSON.stringify(e)}`);
        });
        Log.showInfo(TAG, 'onCreate, createWindow callback (pre-shown, fullscreen, non-touchable)');
      }).catch((err) => {
      });

      let bannerRect = {
        left: 0,
        top: dis.height / 20,
        width: dis.width,
        height: dis.height / 10
      };
      AbilityManager.setAbilityData(AbilityManager.ABILITY_NAME_BANNER_NOTICE, 'bannerRect', bannerRect);
      WindowManager.createWindow(this.context, WindowType.BANNER_NOTICE, bannerRect, 'pages/bannerNotification')
        .then((win) => {
          Log.showInfo(TAG, 'onCreate, createWindow callback');
        })
        .catch((err) => Log.showError(TAG, `Can't create window, err:${JSON.stringify(err)}`));
    }).then(() => {
    }).catch((err) => {
    });
  }

  onDestroy(): void {
    Log.showInfo(TAG, 'onDestroy');
  }
}

export default ServiceExtAbility;
