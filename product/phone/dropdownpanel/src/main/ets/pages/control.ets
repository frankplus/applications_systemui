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

import AbilityManager from '../../../../../../../common/src/main/ets/default/abilitymanager/abilityManager';
import ControlCenterComponent from '../../../../../../../features/controlcentercomponent/src/main/ets/com/ohos/pages/ControlCenterComponent'
import Log from '../../../../../../../common/src/main/ets/default/Log'
import TimeManager, { TimeEventArgs, TIME_CHANGE_EVENT
} from '../../../../../../../common/src/main/ets/default/TimeManager'
import EventManager, { unsubscribe } from '../../../../../../../common/src/main/ets/default/event/EventManager'
import Constants from './common/constants'
import StyleConfiguration, { ControlStyle } from './common/StyleConfiguration'
import ControlCenterConfig from './common/ControlCenterConfig';
import { TouchMoveData } from '@ohos/common';

const TAG = 'DropdownPanel-Control';

@Component
export default struct Control {
  private touchMoveCallback: Function = () => {}
  startX: number = 0
  startY: number = 0
  @State moveX: number = 0
  @State moveY: number = 0
  @State style: ControlStyle = StyleConfiguration.getControlStyle()

  aboutToAppear() {
    Log.showInfo(TAG, `aboutToAppear Start`)
    AbilityManager.setContextName(AbilityManager.ABILITY_NAME_CONTROL_PANEL,AbilityManager.ABILITY_NAME_DROPDOWN_PANEL);
  }

  aboutToDisappear() {
    Log.showInfo(TAG, `aboutToDisAppear`)
  }

  build() {
    Column() {
      Column() {
        statusBar({ touchMoveCallback: (data: TouchMoveData): void => this.touchMoveCallback(data) })
      }
      .width('100%')
      .height(this.style.statusBarHeight)
      .padding({
        top: $r("app.float.status_bar_padding_top_bottom"),
        bottom: $r("app.float.status_bar_padding_top_bottom"),
        left: $r("sys.float.ohos_id_max_padding_start"),
        right: $r("sys.float.ohos_id_max_padding_end")
      })
      .layoutWeight(0)

      Scroll(new Scroller()) {
        Column() {
          ControlCenterComponent({
            touchMoveCallback: (data: TouchMoveData): void => this.controlCenterTouchMoveCallback(data),
            mControlCenterComponentConfig: ControlCenterConfig,
            moduleName: 'phone_dropdownpanel',
          })
        }
        .width('100%')
      }
      .width('100%')
      .scrollBarColor(Color.Gray).scrollBarWidth(10)
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    .onTouch(this.controlTouch.bind(this))
  }

  controlTouch(event: TouchEvent) {
    Log.showDebug(TAG, `controlTouch================ event: ${event}`)
    if (event.type == Constants.TOUCHTYPE_DOWN) {
      this.startX = event.touches[0].screenX
      this.startY = event.touches[0].screenY
      Log.showInfo(TAG, `controlTouch=======startX: ${this.startX}, startY: ${this.startY}`)
    } else if (event.type == Constants.TOUCHTYPE_MOVE) {
      this.moveX = event.touches[0].screenX - this.startX
      this.moveY = event.touches[0].screenY - this.startY
    } else if (event.type == Constants.TOUCHTYPE_UP) {
      Log.showInfo(TAG, `controlTouch, moveX: ${this.moveX}, moveY: ${this.moveY}`)
      if (this.moveY < -30) {
        if (this.touchMoveCallback) {
          this.touchMoveCallback({ 'direction': 'top', 'touchComponent': 'control' })
          this.moveY = 0
        }
      }
    }
  }

  controlCenterTouchMoveCallback(data: TouchMoveData) {
    Log.showDebug(TAG, `controlCenterTouchMoveCallback data: ${JSON.stringify(data)}`)
    data.touchComponent = 'control'
    if (this.touchMoveCallback) {
      this.touchMoveCallback(data)
    }
  }
}

// Panel's own status header. It does NOT reuse the shared status-bar icon
// components (SignalIcon/WifiIcon/BatteryIcon/ClockIcon…): those reference
// `app.*` resources (icon_component_opacity, glyph media) defined in their own
// feature modules, which DON'T resolve when the structs are compiled into this
// HAP via relative import → the icons render blank. Instead we draw a custom row
// from process-wide shared data — the clock from TimeManager's TIME_CHANGE_EVENT
// and the battery from AppStorage('batterySoc'), both populated by the real
// status bar's models in the same systemui process — using only sys.*/explicit
// resources. This is the single visible bar (the real one is suppressed by the
// panel's setWindowSystemBarEnable([])). Clock/battery sit on the RIGHT to match
// the real bar's cluster so there's no jump when the panel opens over it.
@Component
struct statusBar {
  private touchMoveCallback: Function = () => {}
  startX: number = 0
  startY: number = 0
  @State moveX: number = 0
  @State moveY: number = 0
  @State mTime: string = ''
  @StorageLink('batterySoc') batterySoc: number = 100
  unSubscriber?: unsubscribe

  aboutToAppear() {
    this.unSubscriber = EventManager.subscribe(TIME_CHANGE_EVENT, (args: TimeEventArgs) => {
      this.mTime = TimeManager.formatTime(args.date)
    })
    this.mTime = TimeManager.formatTime(new Date())
  }

  aboutToDisappear() {
    this.unSubscriber && this.unSubscriber()
    this.unSubscriber = undefined
  }

  build() {
    Stack(){
      // Content layer (rendered): right-aligned battery% + clock, matching the
      // real status bar's right cluster.
      Flex({ direction: FlexDirection.Row, alignItems: ItemAlign.Center, justifyContent: FlexAlign.End }) {
        Text(this.batterySoc + '%')
          .fontColor('#FFFFFF')
          .fontSize('16fp')
          .fontWeight(FontWeight.Medium)
          .margin({ right: 8 })
        Text(this.mTime)
          .fontColor('#FFFFFF')
          .fontSize('16fp')
          .fontWeight(FontWeight.Medium)
      }
      .width('100%')
      .height('100%')
      .padding({ left: 16, right: 16 })
      // Touch layer on top (transparent): left/right swipe-down switches panel.
      Row(){
        Row(){}.width('50%').height('100%').onTouch((touchEvent) => {this.touchEvent(touchEvent, 'left')})
        Row(){}.width('50%').height('100%').onTouch((touchEvent) => {this.touchEvent(touchEvent, 'right')})
      }.width('100%').height('100%')
    }
    .width('100%')
    .height('100%')
  }

  touchEvent(event: TouchEvent, touchLocation: string) {
    if (event.type == Constants.TOUCHTYPE_DOWN) {
      this.startX = event.touches[0].screenX
      this.startY = event.touches[0].screenY
      Log.showInfo(TAG, `statusBar startX: ${this.startX}, startY: ${this.startY}`)
    } else if (event.type == Constants.TOUCHTYPE_MOVE) {
      this.moveX = event.touches[0].screenX - this.startX
      this.moveY = event.touches[0].screenY - this.startY
    } else if (event.type == Constants.TOUCHTYPE_UP) {
      Log.showInfo(TAG, `statusBar, moveX: ${this.moveX}, moveY: ${this.moveY}`)
      if (this.moveY > 15) {
        if (this.touchMoveCallback) {
          if(touchLocation == 'left'){
            this.touchMoveCallback({ 'direction': 'drop_left', 'touchComponent': 'control' })
          }else if(touchLocation == 'right'){
            this.touchMoveCallback({ 'direction': 'drop_right', 'touchComponent': 'notification' })
          }

        }
      }
    }
  }
}
