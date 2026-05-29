/*
 * Copyright (C) 2022 The Android Open Source Project
 * Copyright (c) 2026 Francesco Pham
 *
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
 *
 * Derivative work: the arrow drawing is ported from AOSP SystemUI
 * BackPanel.kt's onDraw (Copyright (C) 2022 The Android Open Source
 * Project); translated from Kotlin to an ArkTS Canvas and modified.
 *
 * Side-edge back indicator — the Canvas half of AOSP BackPanel.kt.
 * Reads the packed OniroBackFrame object the BackPanelController writes
 * each spring tick and repaints the chevron arrow + rounded-rect pill.
 *
 * The controller runs in the service and owns all the spring physics;
 * this page is a thin, stateless painter. The window is a fullscreen,
 * non-touchable, pre-shown overlay (see ServiceExtAbility.initBackWindow),
 * so the arrow is drawn at absolute screen-vp coordinates. Left/right
 * edge mirroring is folded into the canvas transform here (AOSP did it
 * via the panel window's gravity + a canvas flip); everything after the
 * mirror matches BackPanel.onDraw 1:1.
 */

interface BackFrame {
  seq: number;
  visible: boolean;
  isLeftPanel: boolean;
  arrowsPointLeft: boolean;
  centerYVp: number;
  arrowLength: number;
  arrowHeight: number;
  backgroundWidth: number;
  backgroundHeight: number;
  edgeCornerRadius: number;
  farCornerRadius: number;
  scale: number;
  scalePivotX: number;
  horizontalTranslation: number;
  arrowAlpha: number;
  backgroundAlpha: number;
  arrowThickness: number;
}

const EMPTY_FRAME: BackFrame = {
  seq: 0, visible: false, isLeftPanel: true, arrowsPointLeft: false,
  centerYVp: 0, arrowLength: 0, arrowHeight: 0, backgroundWidth: 0,
  backgroundHeight: 0, edgeCornerRadius: 0, farCornerRadius: 0,
  scale: 1, scalePivotX: 0, horizontalTranslation: 0, arrowAlpha: 0,
  backgroundAlpha: 0, arrowThickness: 4,
};

// Light pill, dark chevron — clearly visible on any wallpaper/app.
const BG_COLOR = '#F2F2F2';
const ARROW_COLOR = '#1A1A1A';

@Entry
@Component
struct BackPanel {
  @StorageLink('OniroBackFrame') @Watch('onFrame') frame: BackFrame = EMPTY_FRAME;

  private settings: RenderingContextSettings = new RenderingContextSettings(true);
  private ctx: CanvasRenderingContext2D = new CanvasRenderingContext2D(this.settings);
  private ready: boolean = false;

  onFrame(): void {
    if (this.ready) this.draw();
  }

  build() {
    Stack() {
      Canvas(this.ctx)
        .width('100%')
        .height('100%')
        .onReady(() => {
          this.ready = true;
          this.draw();
        });
    }
    .width('100%')
    .height('100%');
  }

  private draw(): void {
    const ctx: CanvasRenderingContext2D = this.ctx;
    const w: number = ctx.width;
    ctx.clearRect(0, 0, ctx.width, ctx.height);

    const f: BackFrame = this.frame;
    if (!f || !f.visible) {
      return;
    }

    const halfH: number = f.backgroundHeight / 2;
    const dx: number = f.arrowLength;
    const dy: number = f.arrowHeight;

    ctx.save();

    // Edge-anchor + mirror. Left edge: origin at x=0. Right edge: origin
    // at the right screen edge with x flipped, so the same "grows into
    // the screen" drawing code below works for both sides.
    if (f.isLeftPanel) {
      ctx.translate(0, f.centerYVp);
    } else {
      ctx.translate(w, f.centerYVp);
      ctx.scale(-1, 1);
    }

    // canvas.translate(horizontalTranslation, 0)  (verticalTranslation
    // already folded into centerYVp).
    ctx.translate(f.horizontalTranslation, 0);

    // canvas.scale(scale, scale, scalePivotX, 0)
    ctx.translate(f.scalePivotX, 0);
    ctx.scale(f.scale, f.scale);
    ctx.translate(-f.scalePivotX, 0);

    // Background pill: rect [0, -halfH] .. [bgWidth, halfH]; edge corners
    // (near the screen edge) on the left, far corners on the right.
    if (f.backgroundWidth > 0.5 && f.backgroundAlpha > 0.001) {
      this.roundRectPath(ctx, 0, -halfH, f.backgroundWidth, f.backgroundHeight,
        /* tl */ f.edgeCornerRadius, /* tr */ f.farCornerRadius,
        /* br */ f.farCornerRadius, /* bl */ f.edgeCornerRadius);
      ctx.globalAlpha = f.backgroundAlpha;
      ctx.fillStyle = BG_COLOR;
      ctx.fill();
    }

    // Arrow chevron, centred within the pill.
    const arrowOffset: number = (f.backgroundWidth - dx) / 2;
    ctx.translate(arrowOffset, 0);

    const arrowPointsAwayFromEdge: boolean = !(f.arrowsPointLeft !== f.isLeftPanel);
    if (arrowPointsAwayFromEdge) {
      ctx.scale(-1, 1);
      ctx.translate(-dx, 0);
    }

    const arrowAlpha: number = Math.min(f.arrowAlpha, f.backgroundAlpha);
    if (arrowAlpha > 0.001 && (dx > 0.01 || dy > 0.01)) {
      ctx.beginPath();
      ctx.moveTo(dx, -dy);
      ctx.lineTo(0, 0);
      ctx.lineTo(dx, dy);
      ctx.globalAlpha = arrowAlpha;
      ctx.strokeStyle = ARROW_COLOR;
      ctx.lineWidth = f.arrowThickness;
      ctx.lineCap = 'square';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  private roundRectPath(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, width: number, height: number,
    tl: number, tr: number, br: number, bl: number,
  ): void {
    const maxR: number = Math.min(width, height) / 2;
    const rtl: number = Math.max(0, Math.min(tl, maxR));
    const rtr: number = Math.max(0, Math.min(tr, maxR));
    const rbr: number = Math.max(0, Math.min(br, maxR));
    const rbl: number = Math.max(0, Math.min(bl, maxR));
    ctx.beginPath();
    ctx.moveTo(x + rtl, y);
    ctx.lineTo(x + width - rtr, y);
    ctx.arcTo(x + width, y, x + width, y + rtr, rtr);
    ctx.lineTo(x + width, y + height - rbr);
    ctx.arcTo(x + width, y + height, x + width - rbr, y + height, rbr);
    ctx.lineTo(x + rbl, y + height);
    ctx.arcTo(x, y + height, x, y + height - rbl, rbl);
    ctx.lineTo(x, y + rtl);
    ctx.arcTo(x, y, x + rtl, y, rtl);
    ctx.closePath();
  }
}
