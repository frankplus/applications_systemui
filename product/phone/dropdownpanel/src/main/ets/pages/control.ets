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
import display from '@ohos.display';

const TAG = 'DropdownPanel-Control';

// iPad-style tablet control-center card geometry (vp). On tablet-width displays
// the control center renders as a fixed-width frosted card in the top-right
// (index.ets right-aligns it and dims the rest); phone keeps the full-screen panel.
export const CARD_WIDTH_VP = 460;        // visual card width
export const CARD_RADIUS_VP = 24;
export const CARD_EDGE_MARGIN_VP = 12;   // gap from the top/right screen edge
// The phone-derived control center (big toggle tiles, icons and labels) is too
// large on a tablet, so the whole card content is rendered oversized and scaled
// down: icons, fonts and spacing all shrink uniformly to CARD_SCALE. The inner
// content box is sized 1/CARD_SCALE so that after the scale it exactly fills the
// visual card (no empty border, no clipping). ArkUI hit-tests through the scale
// transform, so the toggles still tap correctly.
export const CARD_SCALE = 0.5;
// Intrinsic (pre-scale) height of the control content: UpTitle (≈132) + one
// complex-toggle row (132) + the simple-toggle area (two 162vp rows + brightness
// + paddings). Measured ≈850 on device (the brightness row clipped at 800), so
// sized to 900 with a little slack so the brightness slider is never cut off.
export const CARD_NATURAL_H_VP = 900;
// Visual card height = scaled content height, capped to the display (room for the
// status strip + bottom edge). Exported so index.ets can make the open/close
// finger-drag travel exactly the card's visual height.
export function cardVisualHeightVp(displayHeightVp: number): number {
  return Math.min(Math.round(CARD_NATURAL_H_VP * CARD_SCALE), Math.floor(displayHeightVp - 96));
}

@Component
export default struct Control {
  private touchMoveCallback: Function = () => {}
  startX: number = 0
  startY: number = 0
  @State moveX: number = 0
  @State moveY: number = 0
  @State style: ControlStyle = StyleConfiguration.getControlStyle()
  // Set by index.ets: tablet-width → render as a top-right floating card.
  isWide: boolean = false
  @State cardHeightVp: number = Math.round(CARD_NATURAL_H_VP * CARD_SCALE)
  @State cardInnerWVp: number = CARD_WIDTH_VP / CARD_SCALE
  @State cardInnerHVp: number = CARD_NATURAL_H_VP

  aboutToAppear() {
    Log.showInfo(TAG, `aboutToAppear Start`)
    AbilityManager.setContextName(AbilityManager.ABILITY_NAME_CONTROL_PANEL,AbilityManager.ABILITY_NAME_DROPDOWN_PANEL);
    if (this.isWide) {
      // Cap the (visual) card height to the display so it can't exceed the screen
      // on a shorter tablet; the inner content box is 1/scale so it fills the card
      // after the scale-down.
      try {
        let dis = display.getDefaultDisplaySync()
        let hVp = dis.height / dis.densityPixels
        this.cardHeightVp = cardVisualHeightVp(hVp)
        this.cardInnerHVp = this.cardHeightVp / CARD_SCALE
        this.cardInnerWVp = CARD_WIDTH_VP / CARD_SCALE
        Log.showInfo(TAG, `aboutToAppear card hVp=${hVp} visualH=${this.cardHeightVp} innerW=${this.cardInnerWVp} innerH=${this.cardInnerHVp}`)
      } catch (e) {
        Log.showWarn(TAG, `aboutToAppear, display query failed: ${JSON.stringify(e)}`)
      }
    }
  }

  aboutToDisappear() {
    Log.showInfo(TAG, `aboutToDisAppear`)
  }

  build() {
    if (this.isWide) {
      // iPad-style tablet control center: a fixed-width frosted card that hugs
      // the control content. The parent (index.ets) right-aligns it near the top
      // edge and dims + tap-closes the rest of the screen. No custom status
      // header here — the card floats below the status strip like iPad's CC.
      Column() {
        // Oversized content (1/scale) scaled down from the top-left so icons,
        // fonts and spacing match a tablet and exactly fill the visual card.
        Column() {
          ControlCenterComponent({
            touchMoveCallback: (data: TouchMoveData): void => this.controlCenterTouchMoveCallback(data),
            mControlCenterComponentConfig: ControlCenterConfig,
            moduleName: 'phone_dropdownpanel',
          })
        }
        .width(this.cardInnerWVp)
        .height(this.cardInnerHVp)
        .scale({ x: CARD_SCALE, y: CARD_SCALE, centerX: '0%', centerY: '0%' })
      }
      .width(CARD_WIDTH_VP)
      .height(this.cardHeightVp)
      .alignItems(HorizontalAlign.Start)
      .borderRadius(CARD_RADIUS_VP)
      .clip(true)
      .backgroundBlurStyle(BlurStyle.Regular)
      .backgroundColor('#4D000000')
      .margin({ top: CARD_EDGE_MARGIN_VP, right: CARD_EDGE_MARGIN_VP })
      .onTouch(this.controlTouch.bind(this))
    } else {
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
