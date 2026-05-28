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

  /**
   * Final teardown: clear visible+recentsMode flags so the page
   * stops rendering content. We do NOT call `win.hide()` here: the
   * drag window stays permanently shown (see ServiceExtAbility.
   * initDragWindow) to avoid the ~1s cold-path cost of `showWindow`
   * after every foreground transition. The page's conditional
   * `if (this.visible)` branches make the perma-shown window paint
   * a fully-transparent surface when content is cleared, so the
   * user sees the foreground app immediately.
   */
  private hideWindow(): void {
    AppStorage.SetOrCreate('OniroDragVisible', false);
    AppStorage.SetOrCreate('OniroDragRecentsMode', false);
  }

  /**
   * Spring the row so card at `cardIndex` (0 = oldest recent, N =
   * foreground) ends up filling the screen at scale=1. Used by both
   * activation (recent card → that card grows to fullscreen, then
   * moveMissionToFront) and return-to-foreground (tap foreground or
   * backdrop → foreground card grows back, then hide).
   *
   * Math: at scale=1, scrolloffset+posX places the row in raw px. To
   * land card K at screen origin we need:
   *   scrollOffsetVp + posX_target + K*(cardW + spacing) = 0
   * Keep scrollOffsetVp at its current value (avoid a visual jump on
   * the wrapper which has no spring animation) and solve for posX.
   *
   * The scale anchor stays at the foreground card's bottom-center —
   * not switched to the tapped card — because changing the anchor
   * mid-spring would jump the visual. With this anchor the foreground
   * card "grows in place" from screen bottom-center; a tapped recent
   * card combines growth with a slide toward the centre as scale
   * approaches 1. Both feel natural and the row arrives at the
   * fullscreen pose deterministically.
   */
  private expandToCard(cardIndex: number, onDone: () => void): void {
    const cardW = this.cardWidthVp;
    const sCurrent = this.scrollOffsetVp;
    const posXTarget = -sCurrent - cardIndex * (cardW + this.spacingVp);
    const posYTarget = 0;
    // Don't touch OniroDragAlpha or OniroDragRecentsAlpha: the
    // foreground and recents Image components bind their .opacity()
    // to those keys WITHOUT a .animation() modifier of their own
    // (only the parent Row's .position/.scale spring), so any write
    // is an instant snap. Fading recents to 0 here would make the
    // tapped recent vanish before the grow-spring became visible.
    // Adjacent cards slide off-screen naturally as the row scales
    // and shifts, so no fade is needed.
    AppStorage.SetOrCreate('OniroDragScale', 1.0);
    AppStorage.SetOrCreate('OniroDragRadius', 0);
    AppStorage.SetOrCreate('OniroDragBackdropAlpha', 0);
    AppStorage.SetOrCreate('OniroDragRowLeftVp', posXTarget);
    AppStorage.SetOrCreate('OniroDragRowTopVp', posYTarget);
    // 320ms matches COMMIT_SPRING_MS in DragController.
    setTimeout(onDone, 320);
  }

  private returnToForeground(): void {
    console.log(`${TAG} returnToForeground`);
    this.expandToCard(this.recents.length, (): void => this.hideWindow());
  }

  private activateMission(missionId: number): void {
    const idx = this.recents.findIndex(
      (x: RecentsCardData): boolean => x.missionId === missionId);
    if (idx < 0) {
      // Card not in our list (shouldn't happen) — skip the expand
      // animation and fall back to the bare structural commit.
      console.warn(`${TAG} activate mid=${missionId} not in recents`);
      missionManager.moveMissionToFront(missionId)
        .then((): void => this.hideWindow())
        .catch((e: object): void => {
          console.error(`${TAG} moveToFront failed: ${JSON.stringify(e)}`);
          this.hideWindow();
        });
      return;
    }
    console.log(`${TAG} activate mid=${missionId} idx=${idx}`);
    // Kick off moveMissionToFront IN PARALLEL with our expand spring.
    // The system's "window appearing" animation on the target app
    // runs HIDDEN behind our growing snapshot (which already shows
    // that exact app), and by the time our spring settles the
    // foreground swap is fully done — we hide and the user just sees
    // the now-foreground app at rest, no duplicate animation.
    //
    // Why not sequential (spring-then-move): OHOS's WMS window-show
    // animation isn't suppressible by a non-system-bundle caller —
    // StartOptions.withAnimation is gated to same-bundle launches at
    // window_options_utils.cpp:55, and windowAnimationManager.
    // setController crashes inside libace_napi on every OnScreenUnlock
    // on this build. So we can't *stop* the system animation; the
    // best we can do is *cover* it during the time it'd be visible.
    missionManager.moveMissionToFront(missionId)
      .catch((e: object): void => {
        console.error(`${TAG} moveToFront failed: ${JSON.stringify(e)}`);
      });
    this.expandToCard(idx, (): void => this.hideWindow());
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
      // Gated on `visible` because the drag window is permanently
      // shown (see ServiceExtAbility.initDragWindow) to dodge the
      // ~1s cold-path cost of `window.showWindow()` after every
      // foreground transition. Without this gate the perma-shown
      // overlay would paint full-screen black on top of every app.
      if (this.visible) {
        Column()
          .width('100%').height('100%')
          .backgroundColor(Color.Black);
      }

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
          .onClick(() => this.returnToForeground());
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
            // opaque during drag; tap (in recents mode only) springs
            // the row back to fullscreen, then hides — gives a
            // smooth card-grows-back-into-app transition since the
            // snapshot already shows that exact foreground app.
            //
            // .animation() AFTER .opacity() so the commit-spring
            // (HOME → al=0, CANCEL → al=1) animates instead of
            // snapping. Without this, alpha jumps instantly to the
            // target and the user sees the card vanish at gesture-
            // release instead of fading with the scale animation.
            Image(this.snap)
              .width(this.cardWidthVp)
              .height(this.cardHeightVp)
              .borderRadius(this.rad)
              .clip(true)
              .objectFit(ImageFit.Cover)
              .opacity(this.al)
              .animation({ curve: curves.springMotion(0.34, 0.82) })
              .onClick(() => {
                if (this.recentsMode) this.returnToForeground();
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
