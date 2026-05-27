/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0.
 *
 * Foreground-app drag overlay. Stacks (bottom → top):
 *   1. Wallpaper Image — AOSP-style spatial backdrop. Falls back to
 *      solid black if WallpaperCache hasn't populated the AppStorage
 *      key (e.g. permission denied at boot).
 *   2. Dim Column — caps at 0.4 alpha for "darkened wallpaper",
 *      driven by OniroDragBackdropAlpha so we can ramp it down at
 *      CANCEL / HOME commit.
 *   3. Snapshot Image — transformed per-frame from AppStorage
 *      (translate/scale/opacity/cornerRadius), springMotion via the
 *      `.animation()` modifier.
 *
 * The owning window is TYPE_VOLUME_OVERLAY + setWindowTouchable(false)
 * so touches reach the foreground app underneath while the overlay
 * is visible.
 */

import { image } from '@kit.ImageKit';
import curves from '@ohos.curves';

@Entry
@Component
struct DragOverlay {
  @StorageLink('OniroDragVisible') visible: boolean = false;
  @StorageLink('OniroDragSnap') snap: image.PixelMap | null = null;
  @StorageLink('OniroDragWallpaper') wallpaper: image.PixelMap | null = null;
  @StorageLink('OniroDragX') tx: number = 0;
  @StorageLink('OniroDragY') ty: number = 0;
  @StorageLink('OniroDragScale') sc: number = 1;
  @StorageLink('OniroDragAlpha') al: number = 1;
  @StorageLink('OniroDragRadius') rad: number = 0;
  @StorageLink('OniroDragBackdropAlpha') backdropAlpha: number = 0;

  // Maximum dim that sits on top of the wallpaper. AOSP Launcher3
  // uses ~0.35-0.45 of black; 0.4 matches well at our density.
  private readonly maxDim: number = 0.4;

  build() {
    Stack() {
      // Wallpaper backdrop — always rendered while visible. If the
      // PixelMap is still null (cache miss / permission denied),
      // the Stack's parent black fills the space instead.
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(Color.Black);

      if (this.visible && this.wallpaper) {
        Image(this.wallpaper)
          .width('100%')
          .height('100%')
          .objectFit(ImageFit.Cover);
      }

      // Dim layer — 0.4 max, scales with backdropAlpha so CANCEL /
      // HOME end-states can ramp it down before the structural
      // commit takes over visually.
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(Color.Black)
        .opacity(this.visible ? this.backdropAlpha * this.maxDim : 0)
        .animation({ curve: curves.springMotion(0.34, 0.82) });

      if (this.visible && this.snap) {
        Image(this.snap)
          .width('100%')
          .height('100%')
          .objectFit(ImageFit.Cover)
          .borderRadius(this.rad)
          .clip(true)
          .opacity(this.al)
          .scale({ x: this.sc, y: this.sc })
          .translate({ x: this.tx, y: this.ty })
          .animation({ curve: curves.springMotion(0.34, 0.82) });
      }
    }
    .width('100%')
    .height('100%');
  }
}
