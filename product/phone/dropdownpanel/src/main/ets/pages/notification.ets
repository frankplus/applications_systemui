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
import deviceInfo from '@ohos.deviceInfo';
import display from '@ohos.display';
import { NotificationItemData, TouchMoveData } from '@ohos/common';
import { CARD_WIDTH_VP, CARD_SCALE, CARD_NATURAL_H_VP, CARD_RADIUS_VP,
  CARD_EDGE_MARGIN_VP } from './control';

const TAG = 'DropdownPanel-notification';
const IMAGE_SIZE_L = 24;
const BGC_SIZE_L = 40;
const NO_NOTIFICATION_TOP_MARGIN = 40;
const TIME_TEXT_MARGIN = 4;
const CENTER_TITLE_MARGIN_TOP = 12;
const TIME_BOTTOM_OFFSET = 7;
const CENTER_MARGIN = 12;
const deviceTypeInfo = deviceInfo.deviceType;

// The notification card adapts its height to content: compact when empty (just the
// date + "No Notification") so it isn't a big empty glass slab, tall when there are
// notifications. Shared with index.ets so the open/close finger-drag travels the
// right distance. Pre-scale (natural) heights; scaled down by CARD_SCALE like control.
export const NOTIF_EMPTY_NATURAL_H_VP = 360;
export function notifVisualHeightVp(displayHeightVp: number, count: number): number {
  const natural = (count === 0) ? NOTIF_EMPTY_NATURAL_H_VP : CARD_NATURAL_H_VP;
  return Math.min(Math.round(natural * CARD_SCALE), Math.floor(displayHeightVp - 96));
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
  // Set by index.ets: tablet-width → render as a top-left floating card (mirrors
  // the control card on the right). Height adapts to notificationList (reactive).
  isWide: boolean = false
  cardInnerWVp: number = CARD_WIDTH_VP / CARD_SCALE
  @State dispHvp: number = 1280   // display height (vp); 1280 fallback if query fails

  aboutToAppear() {
    Log.showInfo(TAG, `aboutToAppear Start`);
    AbilityManager.setContextName(AbilityManager.ABILITY_NAME_NOTIFICATION_PANEL,AbilityManager.ABILITY_NAME_DROPDOWN_PANEL);
    if (this.isWide) {
      try {
        let dis = display.getDefaultDisplaySync()
        this.dispHvp = dis.height / dis.densityPixels
        Log.showInfo(TAG, `aboutToAppear dispHvp=${this.dispHvp}`)
      } catch (e) {
        Log.showWarn(TAG, `aboutToAppear, display query failed: ${JSON.stringify(e)}`)
      }
    }
  }

  build() {
    if (this.isWide) {
      // iPad-style tablet notification center: a top-left frosted card (mirror of
      // the control card on the right). The parent (index.ets) left-aligns it and
      // dims + tap-closes the rest. Oversized content scaled down (same trick as
      // control) so the big clock/notification items match a tablet.
      Column() {
        Column() {
          Stack({ alignContent: Alignment.Bottom }) {
            Column() {
              CenterTitle({
                touchMoveCallback: (data: TouchMoveData):void => this.CenterTitleTouchMoveCallback(data),
                isWide: true
              })
              if (this.notificationList.length == 0) {
                // Center "No Notification" in the compact card body below the date.
                Column() {
                  Text($r("app.string.no_notification"))
                    .fontColor($r("sys.color.ohos_id_color_text_primary_contrary"))
                    .fontSize('28fp')
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
        .height(notifVisualHeightVp(this.dispHvp, this.notificationList.length) / CARD_SCALE)
        .scale({ x: CARD_SCALE, y: CARD_SCALE, centerX: '0%', centerY: '0%' })
      }
      .width(CARD_WIDTH_VP)
      .height(notifVisualHeightVp(this.dispHvp, this.notificationList.length))
      .alignItems(HorizontalAlign.Start)
      .borderRadius(CARD_RADIUS_VP)
      .clip(true)
      .backgroundBlurStyle(BlurStyle.Regular)
      .backgroundColor('#4D000000')
      .margin({ top: CARD_EDGE_MARGIN_VP, left: CARD_EDGE_MARGIN_VP })
      .onTouch(this.touchEvent.bind(this))
    } else {
      Stack({ alignContent: Alignment.Bottom }) {
        Column() {
          Row()
            .height(24)
            .width('100%')
            .backgroundColor($r("app.color.statusbar_background_color"))
        }.height('100%')

        Flex({ direction: FlexDirection.Row, alignItems: ItemAlign.Center, justifyContent: FlexAlign.Center }) {
          Flex({ direction: FlexDirection.Column, alignItems: ItemAlign.Start, justifyContent: FlexAlign.Start }) {
            statusBar({ touchMoveCallback: (data: TouchMoveData): void => this.touchMoveCallback(data) })
            CenterTitle({
              touchMoveCallback: (data: TouchMoveData):void => this.CenterTitleTouchMoveCallback(data)
            })
            if (this.notificationList.length == 0) {
              Text($r("app.string.no_notification"))
                .fontColor($r("sys.color.ohos_id_color_text_primary_contrary"))
                .fontSize($r("sys.float.ohos_id_text_size_sub_title2"))
                .fontWeight(FontWeight.Medium)
                .alignSelf(ItemAlign.Center)
                .margin({ top: NO_NOTIFICATION_TOP_MARGIN })
            } else {
              NotificationListComponent({listIsEnd:$isEnd})
            }
          }.padding({
            left: $r("sys.float.ohos_id_notification_margin_start"),
            right: $r("sys.float.ohos_id_notification_margin_end")
          })
          .height('100%')
        }

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
      .onTouch(this.touchEvent.bind(this))
    }
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

// Panel's own status header — see the note on control.ets's statusBar struct.
// Custom row (battery% + clock, white, sys.* resources only) drawn from
// process-wide shared data; the shared icon components render blank in this HAP
// because their `app.*` resources don't resolve here.
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
    Column(){
      Stack(){
        // Content layer (rendered): right-aligned battery% + clock.
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
    .height(deviceTypeInfo === 'phone' ? $r("app.float.phone_status_bar_height") : $r("app.float.status_bar_height"))
    .width('100%')
    .padding({
      top: $r("app.float.status_bar_padding_top_bottom"),
      bottom: $r("app.float.status_bar_padding_top_bottom"),
      left: $r("app.float.status_bar_padding_left_right"),
      right: $r("app.float.status_bar_padding_left_right")
    })
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
          if(touchLocation === 'left'){
            this.touchMoveCallback({ 'direction': 'drop_left', 'touchComponent': 'control' })
          }else if(touchLocation === 'right'){
            this.touchMoveCallback({ 'direction': 'drop_right', 'touchComponent': 'notification' })
          }
        }
      }
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