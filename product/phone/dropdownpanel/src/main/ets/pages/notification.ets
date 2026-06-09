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
import Log from '../../../../../../../common/src/main/ets/default/Log';
import EventManager, { unsubscribe }  from "../../../../../../../common/src/main/ets/default/event/EventManager";
import { obtainStartAbility } from "../../../../../../../common/src/main/ets/default/event/EventUtil";
import Constants from './common/constants';
import NotificationListComponent from '../../../../../../../features/noticeitem/src/main/ets/com/ohos/noticeItem/view/NotificationListComponent';
import NotificationViewModel from '../../../../../../../features/noticeitem/src/main/ets/com/ohos/noticeItem/viewmodel/NotificationViewModel';
import ResourceUtil from '../../../../../../../common/src/main/ets/default/ResourceUtil';
import TimeManager, { TimeEventArgs, TIME_CHANGE_EVENT
} from '../../../../../../../common/src/main/ets/default/TimeManager';
import display from '@ohos.display';
import { NotificationItemData, TouchMoveData } from '@ohos/common';
import { cardScale, cardWidthVp, ctrlNaturalHVp, bottomReserveVp,
  CARD_RADIUS_VP, CARD_EDGE_MARGIN_VP } from './control';

const TAG = 'DropdownPanel-notification';
const IMAGE_SIZE_L = 24;
const BGC_SIZE_L = 40;
const TIME_TEXT_MARGIN = 4;
const CENTER_TITLE_MARGIN_TOP = 12;
const TIME_BOTTOM_OFFSET = 7;
const CENTER_MARGIN = 12;

// The notification card adapts its height to content: compact when empty (just the
// date + "No Notification") so it isn't a big empty glass slab, tall when there are
// notifications. Shared with index.ets so the open/close finger-drag travels the
// right distance. Pre-scale (natural) heights; scaled by cardScale() like control.
const TABLET_NOTIF_EMPTY_H_VP = 360;
const PHONE_NOTIF_EMPTY_H_VP = 220;
export function notifVisualHeightVp(isWide: boolean, displayHeightVp: number, count: number): number {
  const natural = (count === 0)
    ? (isWide ? TABLET_NOTIF_EMPTY_H_VP : PHONE_NOTIF_EMPTY_H_VP)
    : ctrlNaturalHVp(isWide);
  return Math.min(Math.round(natural * cardScale(isWide)),
    Math.floor(displayHeightVp - bottomReserveVp(isWide)));
}

@Component
export default struct Notification {
  private touchMoveCallback: Function = () => {}
  startX: number = 0
  startY: number = 0
  @State moveX: number = 0
  @State moveY: number = 0
  @State isEnd: boolean = true
  @StorageLink('notificationList') notificationList: NotificationItemData[][] = []
  // Set by index.ets: tablet-width → top-left corner card (mirror of the control
  // card on the right); else the phone inset card at native scale. Height adapts
  // to notificationList (reactive) on both.
  isWide: boolean = false
  @State cardScaleV: number = 1.0
  @State cardWidthV: number = 336
  @State cardInnerWVp: number = 336
  @State dispHvp: number = 1280   // display height (vp); 1280 fallback if query fails

  aboutToAppear() {
    Log.showInfo(TAG, `aboutToAppear Start`);
    AbilityManager.setContextName(AbilityManager.ABILITY_NAME_NOTIFICATION_PANEL,AbilityManager.ABILITY_NAME_DROPDOWN_PANEL);
    // Resolve the responsive card box once. Inner width = visual / scale so the
    // content exactly fills the card after the scale-down; height is dynamic
    // (notification count) and computed in build(). On phone scale=1 → inner=visual.
    try {
      let dis = display.getDefaultDisplaySync()
      let wVp = dis.width / dis.densityPixels
      this.dispHvp = dis.height / dis.densityPixels
      this.cardScaleV = cardScale(this.isWide)
      this.cardWidthV = cardWidthVp(this.isWide, wVp)
      this.cardInnerWVp = this.cardWidthV / this.cardScaleV
      Log.showInfo(TAG, `aboutToAppear wVp=${wVp} dispHvp=${this.dispHvp} scale=${this.cardScaleV} ` +
        `W=${this.cardWidthV} innerW=${this.cardInnerWVp}`)
    } catch (e) {
      Log.showWarn(TAG, `aboutToAppear, display query failed: ${JSON.stringify(e)}`)
    }
  }

  build() {
    // Frosted notification card. The parent (index.ets) positions it (top-left
    // corner on tablet, centered inset on phone) and dims + tap-closes the rest.
    // No custom status header — the real system status bar shows above the card.
    Column() {
      Column() {
        Stack({ alignContent: Alignment.Bottom }) {
          Column() {
            CenterTitle({
              touchMoveCallback: (data: TouchMoveData):void => this.CenterTitleTouchMoveCallback(data),
              isWide: this.isWide
            })
            if (this.notificationList.length == 0) {
              // Center "No Notification" in the compact card body below the date.
              Column() {
                Text($r("app.string.no_notification"))
                  .fontColor($r("sys.color.ohos_id_color_text_primary_contrary"))
                  .fontSize(this.isWide ? '28fp' : '20fp')
                  .fontWeight(FontWeight.Medium)
              }
              .layoutWeight(1)
              .width('100%')
              .justifyContent(FlexAlign.Center)
            } else {
              NotificationListComponent({listIsEnd:$isEnd})
            }
          }
          .width('100%')
          .height('100%')
          .justifyContent(FlexAlign.Start)
          .padding({
            left: $r("sys.float.ohos_id_notification_margin_start"),
            right: $r("sys.float.ohos_id_notification_margin_end")
          })

          if (this.notificationList.length > 0) {
            Flex({ justifyContent: FlexAlign.Center, alignItems: ItemAlign.Center }) {
              Image($r('app.media.ic_public_delete_filled'))
                .fillColor("#FFFFFF")
                .width(IMAGE_SIZE_L)
                .height(IMAGE_SIZE_L)
            }
            .width(BGC_SIZE_L)
            .height(BGC_SIZE_L)
            .margin({ bottom: $r('app.float.notification_delete_all') })
            .borderRadius(BGC_SIZE_L)
            .backgroundColor($r('app.color.notification_delete_all_background'))
            .onClick(() => {
              NotificationViewModel.removeAllNotifications();
            })
          }
        }
        .width('100%')
        .height('100%')
      }
      .width(this.cardInnerWVp)
      .height(notifVisualHeightVp(this.isWide, this.dispHvp, this.notificationList.length) / this.cardScaleV)
      .scale({ x: this.cardScaleV, y: this.cardScaleV, centerX: '0%', centerY: '0%' })
    }
    .width(this.cardWidthV)
    .height(notifVisualHeightVp(this.isWide, this.dispHvp, this.notificationList.length))
    .alignItems(HorizontalAlign.Start)
    .borderRadius(CARD_RADIUS_VP)
    .clip(true)
    .backgroundBlurStyle(BlurStyle.Regular)
    .backgroundColor('#4D000000')
    // Tablet hugs the left edge; phone is centered by index.ets so it needs no
    // left margin (the side insets come from being narrower than the screen).
    .margin({ top: CARD_EDGE_MARGIN_VP, left: this.isWide ? CARD_EDGE_MARGIN_VP : 0 })
    .onTouch(this.touchEvent.bind(this))
  }

  touchEvent(event: TouchEvent) {
    if (this.notificationList.length == 0) {
      this.isEnd = true;
    }
    if (event.type == Constants.TOUCHTYPE_DOWN) {
      this.startX = event.touches[0].screenX
      this.startY = event.touches[0].screenY
      Log.showInfo(TAG, `touchStart2=======startX: ${this.startX}, startY: ${this.startY}`)
    } else if (event.type == Constants.TOUCHTYPE_MOVE) {
      this.moveX = event.touches[0].screenX - this.startX
      this.moveY = event.touches[0].screenY - this.startY
    } else if (event.type == Constants.TOUCHTYPE_UP) {
      Log.showInfo(TAG, `touchEnd2, moveX: ${this.moveX}, moveY: ${this.moveY}`)
      if (this.moveY < -30 && this.isEnd) {
        if (this.touchMoveCallback) {
          this.touchMoveCallback({ 'direction': 'top', 'touchComponent': 'notification' })
          this.moveY = 0;
          this.isEnd = false;
        }
      }
    }
  }

  CenterTitleTouchMoveCallback(data: TouchMoveData) {
    Log.showDebug(TAG, `CenterTitleTouchMoveCallback, data: ${JSON.stringify(data)}`)
    data.touchComponent = 'notification'
    if (this.touchMoveCallback) {
      this.touchMoveCallback(data)
    }
  }
}

@Component
struct CenterTitle {
  private touchMoveCallback: Function = () => {};
  // Tablet card mode → larger fonts matching the control card (clock = control
  // title 40fp, date = control toggle label 24fp). Phone keeps its sys sizes.
  isWide: boolean = false;
  startX: number = 0;
  startY: number = 0;
  @State moveX: number = 0;
  @State moveY: number = 0;
  @State mTimeString: string = '';
  @State mTime: string = '01:01'
  unSubscriber?: unsubscribe;

  aboutToAppear() {
    Log.showInfo(TAG, `CenterTitle, aboutToAppear`)
    this.unSubscriber = EventManager.subscribe(TIME_CHANGE_EVENT, (args: TimeEventArgs) => {
      this.updateTimeString(args.date)
    });
    this.updateTimeString(new Date())
  }

  aboutToDisappear() {
    Log.showInfo(TAG, 'CenterTitle aboutToDisappear');
    this.unSubscriber && this.unSubscriber();
    this.unSubscriber = undefined;
  }

  build() {
    Flex({ direction: FlexDirection.Row, alignItems: ItemAlign.End, justifyContent: FlexAlign.Start }) {
      Text(this.mTime)
        .fontColor($r("sys.color.ohos_id_color_text_primary_contrary"))
        .fontSize(this.isWide ? '40fp' : '36fp')
        .fontWeight(FontWeight.Medium)
        .margin({ left: CENTER_MARGIN })
      Text(this.mTimeString)
        .fontColor($r("sys.color.ohos_id_color_text_primary_contrary"))
        .fontSize(this.isWide ? '24fp' : $r("sys.float.ohos_id_text_size_sub_title3"))
        .fontWeight(FontWeight.Medium)
        .margin({ left: TIME_TEXT_MARGIN, bottom: TIME_BOTTOM_OFFSET })
        .flexGrow(1)
        .align(Alignment.Center)
      Image($r("app.media.ic_public_settings"))
        .objectFit(ImageFit.Contain)
        .width($r("app.float.notification_title_setting_icon_width"))
        .height($r("app.float.notification_title_setting_icon_height"))
        .fillColor("#FFFFFF")
        .margin({ right: CENTER_MARGIN, bottom: TIME_BOTTOM_OFFSET })
        .onClick(this.settingClick.bind(this))
    }
    .margin({ top: CENTER_TITLE_MARGIN_TOP, bottom: TIME_TEXT_MARGIN })
    .onTouch(this.touchEvent.bind(this))
  }

  async updateTimeString(date: Date) {
    this.mTime = TimeManager.formatTime(date);
    Log.showDebug(TAG, ` month is ${date.getMonth() + 1} , day is ${date.getDate()} , week is ${Constants.WEEKDAY_LIST[date.getDay() - 1]}`);
    await ResourceUtil.initResourceManager(AbilityManager.ABILITY_NAME_DROPDOWN_PANEL);
    let timeString = (date.getMonth() + 1) + (await ResourceUtil.getString($r('app.string.month')));
    timeString += date.getDate() + (await ResourceUtil.getString($r('app.string.day')));
    timeString += await ResourceUtil.getString(Constants.WEEKDAY_LIST[date.getDay()]);
    this.mTimeString = timeString;
  }

  settingClick() {
    Log.showDebug(TAG, ` settingClick `)
    EventManager.publish(obtainStartAbility('com.ohos.systemui', 'com.ohos.systemui.notificationmanagement.MainAbility'))
  }

  touchEvent(event: TouchEvent) {
    if (event.type == Constants.TOUCHTYPE_DOWN) {
      this.startX = event.touches[0].screenX
      this.startY = event.touches[0].screenY
      Log.showInfo(TAG, `CenterTitle touchStart2=======startX: ${this.startX}, startY: ${this.startY}`)
    } else if (event.type == Constants.TOUCHTYPE_MOVE) {
      this.moveX = event.touches[0].screenX - this.startX
      this.moveY = event.touches[0].screenY - this.startY
    } else if (event.type == Constants.TOUCHTYPE_UP) {
      Log.showInfo(TAG, `CenterTitle touchEnd2, moveX: ${this.moveX}, moveY: ${this.moveY}`)
      if (this.moveX < -30) {
        if (this.touchMoveCallback) {
          this.touchMoveCallback({ 'direction': 'left' })
        }
      } else if (this.moveX > 30) {
        if (this.touchMoveCallback) {
          this.touchMoveCallback({ 'direction': 'right' })
        }
      }
    }
  }
}
