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
import Constants from './common/constants'
import ControlCenterConfig from './common/ControlCenterConfig';
import { TouchMoveData } from '@ohos/common';
import display from '@ohos.display';

const TAG = 'DropdownPanel-Control';

// ───────────────────── Shared frosted-card geometry ─────────────────────
// The control & notification panels render as a frosted, rounded card over a
// dimmed tap-to-close backdrop on BOTH form factors (index.ets owns the dim).
// Only the geometry adapts to screen size:
//   • Tablet (isWide): a fixed-width card hugging a top corner. The phone-derived
//     content is laid out OVERSIZED (1/scale) then shrunk by `scale` so its icons
//     and fonts look right on the big screen.
//   • Phone: a near-full-width INSET card (margin on every side, fully rounded,
//     centered by index.ets) with content at NATIVE scale (1.0) — the control
//     center was already designed for the phone width, so no oversize trick.
// The card width/height/scale flow through these helpers so the SAME card build
// serves both; with scale 1.0 the inner (pre-scale) box equals the visual box.
export const CARD_RADIUS_VP = 24;
export const CARD_EDGE_MARGIN_VP = 12;   // gap from the screen edge(s)

const TABLET_CARD_WIDTH_VP = 460;        // fixed tablet card width
const TABLET_CARD_SCALE = 0.5;           // tablet oversize-and-shrink factor
const TABLET_CTRL_NATURAL_H_VP = 900;    // tablet pre-scale content height (measured)
const PHONE_CTRL_NATURAL_H_VP = 470;     // phone control-center content height (native)

// Down-scale applied to the (oversized) card content. 1.0 on phone = native size.
export function cardScale(isWide: boolean): number {
  return isWide ? TABLET_CARD_SCALE : 1.0;
}
// Visual card width (vp). Phone = full display width minus a margin on each side.
export function cardWidthVp(isWide: boolean, displayWidthVp: number): number {
  return isWide ? TABLET_CARD_WIDTH_VP : Math.round(displayWidthVp - 2 * CARD_EDGE_MARGIN_VP);
}
// Pre-scale (natural) height of the control-center content.
export function ctrlNaturalHVp(isWide: boolean): number {
  return isWide ? TABLET_CTRL_NATURAL_H_VP : PHONE_CTRL_NATURAL_H_VP;
}
// Vertical space left below the card (status strip + visible dim), so the card
// never fills the whole screen — otherwise the tap-to-close dim is never seen.
export function bottomReserveVp(isWide: boolean): number {
  return isWide ? 96 : 120;
}
// Visual control-card height (vp) = scaled content height, capped to the display.
// Exported so index.ets can make the open/close finger-drag travel exactly the
// card's visual height.
export function cardVisualHeightVp(isWide: boolean, displayHeightVp: number): number {
  return Math.min(Math.round(ctrlNaturalHVp(isWide) * cardScale(isWide)),
    Math.floor(displayHeightVp - bottomReserveVp(isWide)));
}

@Component
export default struct Control {
  private touchMoveCallback: Function = () => {}
  startX: number = 0
  startY: number = 0
  @State moveX: number = 0
  @State moveY: number = 0
  // Set by index.ets: tablet-width → corner card + oversize-and-shrink; else the
  // phone inset card at native scale. Drives every responsive dimension below.
  isWide: boolean = false
  @State cardScaleV: number = 1.0
  @State cardWidthV: number = 336
  @State cardHeightV: number = 470
  @State cardInnerWVp: number = 336
  @State cardInnerHVp: number = 470

  aboutToAppear() {
    Log.showInfo(TAG, `aboutToAppear Start`)
    AbilityManager.setContextName(AbilityManager.ABILITY_NAME_CONTROL_PANEL,AbilityManager.ABILITY_NAME_DROPDOWN_PANEL);
    // Resolve the responsive card box once (the display is fixed for this window).
    // Inner box = visual box / scale, so after the scale-down it exactly fills the
    // visual card (no empty border, no clipping). On phone scale=1 → inner=visual.
    try {
      let dis = display.getDefaultDisplaySync()
      let wVp = dis.width / dis.densityPixels
      let hVp = dis.height / dis.densityPixels
      this.cardScaleV = cardScale(this.isWide)
      this.cardWidthV = cardWidthVp(this.isWide, wVp)
      this.cardHeightV = cardVisualHeightVp(this.isWide, hVp)
      this.cardInnerWVp = this.cardWidthV / this.cardScaleV
      this.cardInnerHVp = this.cardHeightV / this.cardScaleV
      Log.showInfo(TAG, `aboutToAppear card wVp=${wVp} hVp=${hVp} scale=${this.cardScaleV} ` +
        `W=${this.cardWidthV} H=${this.cardHeightV} innerW=${this.cardInnerWVp} innerH=${this.cardInnerHVp}`)
    } catch (e) {
      Log.showWarn(TAG, `aboutToAppear, display query failed: ${JSON.stringify(e)}`)
    }
  }

  aboutToDisappear() {
    Log.showInfo(TAG, `aboutToDisAppear`)
  }

  build() {
    // Frosted control-center card. The parent (index.ets) positions it: a top
    // corner on tablet, centered (inset by CARD_EDGE_MARGIN_VP each side) on
    // phone, and dims + tap-closes the rest of the screen. No custom status
    // header here — the card floats below the real system status bar, which
    // stays visible above it (matching the tablet / iPad Control Center).
    Column() {
      // Content box: oversized (1/scale) then scaled down on tablet so icons,
      // fonts and spacing match the big screen; native (scale 1) on phone.
      Column() {
        ControlCenterComponent({
          touchMoveCallback: (data: TouchMoveData): void => this.controlCenterTouchMoveCallback(data),
          mControlCenterComponentConfig: ControlCenterConfig,
          moduleName: 'phone_dropdownpanel',
        })
      }
      .width(this.cardInnerWVp)
      .height(this.cardInnerHVp)
      .scale({ x: this.cardScaleV, y: this.cardScaleV, centerX: '0%', centerY: '0%' })
    }
    .width(this.cardWidthV)
    .height(this.cardHeightV)
    .alignItems(HorizontalAlign.Start)
    .borderRadius(CARD_RADIUS_VP)
    .clip(true)
    .backgroundBlurStyle(BlurStyle.Regular)
    .backgroundColor('#4D000000')
    // Tablet hugs the right edge; phone is centered by index.ets so it needs no
    // right margin (the side insets come from being narrower than the screen).
    .margin({ top: CARD_EDGE_MARGIN_VP, right: this.isWide ? CARD_EDGE_MARGIN_VP : 0 })
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
