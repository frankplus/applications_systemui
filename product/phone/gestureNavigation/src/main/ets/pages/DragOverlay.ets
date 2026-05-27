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
 * tap a card to activate, tap the backdrop / foreground card to
 * return to the current app, or PAN HORIZONTALLY to bring older
 * recents into the centered slot (snap-to-card on release).
 *
 *   Stack (bottom → top):
 *     1. Black fill                 (fallback if wallpaper missing)
 *     2. Wallpaper Image            (PixelMap from @ohos.wallpaper)
 *     3. Dim Column                 (alpha = backdropAlpha * 0.4)
 *     4. Backdrop tap-zone          (only in recents-mode)
 *     5. Row of cards (wrapped)     (transformed; wrapper handles pan)
 *
 * The Row sits inside a wrapper Column that owns the pan-driven
 * horizontal translate. The Row itself keeps its springMotion
 * .animation() for the commit-spring, but the wrapper has no
 * .animation() so finger-tracking during pan is instant; the
 * snap-on-release uses an explicit animateTo() with a short EaseOut
 * so the lag-free pan doesn't fight the snap.
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
  @StorageLink('OniroDragVisible') @Watch('onVisibleChange') visible: boolean = false;
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
  @StorageLink('OniroDragRecentsMode') @Watch('onRecentsModeChange') recentsMode: boolean = false;

  // Pan-scroll state. Local @State so the wrapper Column's translate
  // updates without going through AppStorage (which would induce a
  // spring lag we don't want during direct manipulation).
  @State scrollOffsetVp: number = 0;
  @State panStartOffset: number = 0;

  private readonly maxDim: number = 0.4;

  onRecentsModeChange(): void {
    // Entering recents-mode (after the commit spring settles) → start
    // with the foreground card centered. Leaving it → just reset so
    // the next gesture's mode-flip starts clean.
    this.scrollOffsetVp = 0;
    this.panStartOffset = 0;
  }

  onVisibleChange(): void {
    if (!this.visible) {
      this.scrollOffsetVp = 0;
      this.panStartOffset = 0;
    }
  }

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

  // Card width on screen (post-scale) + spacing between adjacent
  // cards. One "step" advances the row by exactly one card slot.
  private cardStepVp(): number {
    return (this.cardWidthVp + this.spacingVp) * this.sc;
  }

  // Maximum positive offset = bring the oldest recent to center.
  // Negative offsets are clamped to zero (foreground is already at
  // the right end of the row; there's no card to the right of it).
  private maxScrollVp(): number {
    return this.recents.length * this.cardStepVp();
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

      // 5. The Row of cards, wrapped so the pan-driven horizontal
      // translate is applied OUTSIDE the .animation() boundary —
      // otherwise the spring catches up to the finger lazily and
      // direct manipulation feels mushy.
      if (this.visible && this.snap) {
        Column() {
          Row({ space: this.spacingVp }) {
            // Background recents on the left. RecentsLoader returns
            // them in oldest→newest order so the rightmost recent is
            // adjacent to the foreground card.
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

            // Foreground (captured snapshot) — rightmost, always
            // opaque during drag; tap (in recents mode only)
            // dismisses back to the original foreground app.
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
        .width('100%').height('100%')
        .translate({ x: this.scrollOffsetVp, y: 0 });
      }
    }
    .width('100%').height('100%')
    .gesture(
      // Horizontal pan to scroll through recents in Overview mode.
      // Distance 8vp filters out taps and tiny jitter; tap handlers
      // on cards/backdrop still fire because they need zero motion.
      // Inactive outside recents mode (touchable=false during drag,
      // and we also gate on recentsMode for safety).
      PanGesture({ direction: PanDirection.Horizontal, distance: 8 })
        .onActionStart((_e: GestureEvent) => {
          if (!this.recentsMode) return;
          this.panStartOffset = this.scrollOffsetVp;
        })
        .onActionUpdate((e: GestureEvent) => {
          if (!this.recentsMode) return;
          const max = this.maxScrollVp();
          const target = Math.max(0, Math.min(max, this.panStartOffset + e.offsetX));
          this.scrollOffsetVp = target;
        })
        .onActionEnd((_e: GestureEvent) => {
          if (!this.recentsMode) return;
          const step = this.cardStepVp();
          const max = this.maxScrollVp();
          const snapIdx = step > 0 ? Math.round(this.scrollOffsetVp / step) : 0;
          const clamped = Math.max(0, Math.min(this.recents.length, snapIdx));
          const snapTo = Math.max(0, Math.min(max, clamped * step));
          animateTo({ duration: 240, curve: Curve.EaseOut }, () => {
            this.scrollOffsetVp = snapTo;
          });
        })
        .onActionCancel(() => {
          if (!this.recentsMode) return;
          const step = this.cardStepVp();
          const snapIdx = step > 0 ? Math.round(this.scrollOffsetVp / step) : 0;
          const snapTo = Math.max(0, Math.min(this.recents.length, snapIdx)) * step;
          animateTo({ duration: 240, curve: Curve.EaseOut }, () => {
            this.scrollOffsetVp = snapTo;
          });
        })
    );
  }
}
