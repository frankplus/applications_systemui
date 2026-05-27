/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0.
 *
 * Drag overlay = AOSP Quickstep "Overview" surface. Renders a
 * horizontal Row of cards (background recents on the LEFT, captured
 * foreground snapshot on the RIGHT) on top of the live wallpaper.
 *
 * During the drag itself the Row's scale + position track the finger;
 * the Row scales around the foreground card's BOTTOM-CENTER so that
 * the foreground card's bottom stays "attached" to the finger Y as
 * the row shrinks (AOSP behaviour).
 *
 * On RECENTS commit, the controller springs the Row to the Overview
 * pose (foreground card centered, scale 0.65, recents visible). The
 * service then flips the window touchable/focusable so the user can
 * tap a card to activate, or tap the backdrop / foreground card to
 * return to the current app. Both paths dismiss the overlay.
 *
 *   Stack (bottom → top):
 *     1. Black fill                 (fallback if wallpaper missing)
 *     2. Wallpaper Image            (PixelMap from @ohos.wallpaper)
 *     3. Dim Column                 (alpha = backdropAlpha * 0.4)
 *     4. Backdrop tap-zone          (only in recents-mode)
 *     5. The Row of cards           (transformed)
 */

import curves from '@ohos.curves';
import missionManager from '@ohos.app.ability.missionManager';
import window from '@ohos.window';
import { image } from '@kit.ImageKit';

const TAG = 'GestureNavigation_DragOverlay';

interface RecentsCardData {
  missionId: number;
  label: string;
  snap: image.PixelMap | null;
}

@Entry
@Component
struct DragOverlay {
  // Visibility + content.
  @StorageLink('OniroDragVisible') visible: boolean = false;
  @StorageLink('OniroDragSnap') snap: image.PixelMap | null = null;
  @StorageLink('OniroDragWallpaper') wallpaper: image.PixelMap | null = null;
  @StorageLink('OniroDragRecents') recents: RecentsCardData[] = [];

  // Per-frame transforms.
  @StorageLink('OniroDragRowLeftVp') rowLeftVp: number = 0;
  @StorageLink('OniroDragRowTopVp') rowTopVp: number = 0;
  @StorageLink('OniroDragRowWidthVp') rowWidthVp: number = 0;
  @StorageLink('OniroDragRowHeightVp') rowHeightVp: number = 0;
  @StorageLink('OniroDragCardWidthVp') cardWidthVp: number = 0;
  @StorageLink('OniroDragCardHeightVp') cardHeightVp: number = 0;
  @StorageLink('OniroDragAnchorXVp') anchorXVp: number = 0;
  @StorageLink('OniroDragAnchorYVp') anchorYVp: number = 0;
  @StorageLink('OniroDragCardSpacingVp') spacingVp: number = 40;
  @StorageLink('OniroDragScale') sc: number = 1;
  @StorageLink('OniroDragAlpha') al: number = 1;
  @StorageLink('OniroDragRecentsAlpha') recentsAl: number = 0;
  @StorageLink('OniroDragRadius') rad: number = 0;
  @StorageLink('OniroDragBackdropAlpha') backdropAlpha: number = 0;
  @StorageLink('OniroDragRecentsMode') recentsMode: boolean = false;

  private readonly maxDim: number = 0.4;

  private dismissOverlay(): void {
    console.log(`${TAG} dismissOverlay`);
    AppStorage.SetOrCreate('OniroDragVisible', false);
    AppStorage.SetOrCreate('OniroDragRecentsMode', false);
    try {
      const win = window.findWindow('OniroDragOverlay');
      win.hide().catch((e: Error) => {
        console.warn(`${TAG} hide failed: ${JSON.stringify(e)}`);
      });
    } catch (e) {
      console.warn(`${TAG} findWindow failed: ${JSON.stringify(e)}`);
    }
  }

  private activateMission(missionId: number): void {
    console.log(`${TAG} activate mid=${missionId}`);
    missionManager.moveMissionToFront(missionId)
      .then((): void => this.dismissOverlay())
      .catch((e: object): void => {
        console.error(`${TAG} moveToFront failed: ${JSON.stringify(e)}`);
        this.dismissOverlay();
      });
  }

  private clearMission(missionId: number): void {
    console.log(`${TAG} clear mid=${missionId}`);
    missionManager.clearMission(missionId)
      .then((): void => {
        const newList = this.recents.filter(
          (x: RecentsCardData): boolean => x.missionId !== missionId);
        AppStorage.SetOrCreate('OniroDragRecents', newList);
      })
      .catch((e: object): void => {
        console.error(`${TAG} clearMission failed: ${JSON.stringify(e)}`);
      });
  }

  build() {
    Stack() {
      // 1. Black backdrop fill — only fallback if wallpaper missing.
      Column()
        .width('100%').height('100%')
        .backgroundColor(Color.Black);

      // 2. Wallpaper.
      if (this.visible && this.wallpaper) {
        Image(this.wallpaper)
          .width('100%').height('100%')
          .objectFit(ImageFit.Cover);
      }

      // 3. Dim layer over wallpaper.
      Column()
        .width('100%').height('100%')
        .backgroundColor(Color.Black)
        .opacity(this.visible ? this.backdropAlpha * this.maxDim : 0)
        .animation({ curve: curves.springMotion(0.34, 0.82) });

      // 4. Tap-to-dismiss zone — only present in recents mode so a
      // mid-drag tap (which can't reach here anyway because the
      // window is non-touchable) can't accidentally dismiss.
      if (this.visible && this.recentsMode) {
        Column()
          .width('100%').height('100%')
          .backgroundColor('#00000000')
          .onClick(() => this.dismissOverlay());
      }

      // 5. The Row of cards.
      if (this.visible && this.snap) {
        Row({ space: this.spacingVp }) {
          // Background recents on the left.
          ForEach(this.recents, (m: RecentsCardData) => {
            Stack({ alignContent: Alignment.TopEnd }) {
              if (m.snap) {
                Image(m.snap)
                  .width(this.cardWidthVp)
                  .height(this.cardHeightVp)
                  .borderRadius(this.rad)
                  .clip(true)
                  .objectFit(ImageFit.Cover)
                  .onClick(() => {
                    if (this.recentsMode) this.activateMission(m.missionId);
                  });
              } else {
                Column()
                  .width(this.cardWidthVp)
                  .height(this.cardHeightVp)
                  .borderRadius(this.rad)
                  .backgroundColor('#444444');
              }
              if (this.recentsMode) {
                Text('×')
                  .fontSize(28).fontColor(Color.White).fontWeight(FontWeight.Bold)
                  .textAlign(TextAlign.Center)
                  .width(40).height(40).borderRadius(20)
                  .backgroundColor('#88000000')
                  .margin({ top: 16, right: 16 })
                  .onClick(() => this.clearMission(m.missionId));
              }
            }
            .width(this.cardWidthVp)
            .height(this.cardHeightVp)
            .opacity(this.recentsAl);
          }, (m: RecentsCardData) => `${m.missionId}`)

          // Foreground (captured snapshot) — rightmost, always opaque
          // during drag; tap (in recents mode only) dismisses.
          Image(this.snap)
            .width(this.cardWidthVp)
            .height(this.cardHeightVp)
            .borderRadius(this.rad)
            .clip(true)
            .objectFit(ImageFit.Cover)
            .opacity(this.al)
            .onClick(() => {
              if (this.recentsMode) this.dismissOverlay();
            });
        }
        .width(this.rowWidthVp)
        .height(this.rowHeightVp)
        .position({ x: this.rowLeftVp, y: this.rowTopVp })
        .scale({
          x: this.sc,
          y: this.sc,
          centerX: this.anchorXVp,
          centerY: this.anchorYVp,
        })
        .animation({ curve: curves.springMotion(0.34, 0.82) });
      }
    }
    .width('100%').height('100%');
  }
}
