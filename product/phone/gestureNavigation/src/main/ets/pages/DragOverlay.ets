/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0.
 *
 * Foreground-app drag overlay. Renders a half-res PixelMap snapshot
 * of the foreground display and transforms it per-frame from
 * AppStorage values that DragController writes. A semi-opaque dim
 * Column behind the snapshot masks the live foreground app so the
 * scaled snapshot doesn't double-render against its source.
 *
 * `.animation()` modifiers wrap each transformed property: during
 * the active drag DragController writes values that match the
 * finger so the spring is essentially a no-op (target = current).
 * At commit, DragController writes the end-state values for the
 * spring to settle into (e.g. scale 0.12 + alpha 0 for HOME).
 *
 * Owning window is TYPE_VOLUME_OVERLAY with setWindowTouchable(false)
 * so touches pass through to the foreground app — the recognizer
 * keeps reading them off inputMonitor.
 */

import { image } from '@kit.ImageKit';
import curves from '@ohos.curves';

@Entry
@Component
struct DragOverlay {
  @StorageLink('OniroDragVisible') visible: boolean = false;
  @StorageLink('OniroDragSnap') snap: image.PixelMap | null = null;
  @StorageLink('OniroDragX') tx: number = 0;
  @StorageLink('OniroDragY') ty: number = 0;
  @StorageLink('OniroDragScale') sc: number = 1;
  @StorageLink('OniroDragAlpha') al: number = 1;
  @StorageLink('OniroDragRadius') rad: number = 0;
  @StorageLink('OniroDragBackdropAlpha') backdropAlpha: number = 0;

  // Quickstep's RectFSpringAnim uses stiffness 380 + damping ratio
  // 0.85; OHOS springMotion's (response, dampingFraction) signature
  // maps to roughly response=0.34s, damping=0.82 for the same feel.
  // Inlined at each .animation() site below — keeping a field of
  // type ICurve trips a "type object" inference error at build.

  build() {
    Stack() {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(Color.Black)
        .opacity(this.visible ? this.backdropAlpha : 0)
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
