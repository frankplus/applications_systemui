/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import curves from '@ohos.curves';

@Entry
@Component
struct GestureDock {
  @StorageLink('OniroDockVisible') visible: boolean = false;
  @StorageLink('OniroDockProgress') progress: number = 0;
  @StorageLink('OniroDockMode') mode: string = 'home';

  // GESTURE_NAV_AI_BAR_EFFECT_COLOR (#33ffffff) per FINDINGS.md §C.
  private readonly tint: string = '#33FFFFFF';

  build() {
    Stack() {
      Column()
        .width(this.barWidthVp())
        .height(this.barHeightVp())
        .borderRadius(this.barCornerVp())
        .backgroundColor(this.tint)
        .shadow({
          radius: 24,
          color: '#33000000',
          offsetX: 0,
          offsetY: 4,
        })
        .opacity(this.visible ? Math.min(0.25 + this.progress, 1) : 0)
        .scale({ x: this.visible ? 1 : 0.8, y: this.visible ? 1 : 0.8 })
        .animation({
          curve: curves.springMotion(0.34, 0.82),
        });
    }
    .width('100%')
    .height('100%')
    .alignContent(Alignment.Center);
  }

  private barWidthVp(): number {
    const min = 56;
    const max = 96;
    return min + (max - min) * Math.min(this.progress, 1);
  }

  private barHeightVp(): number {
    const min = 5;
    const max = 24;
    return min + (max - min) * Math.min(this.progress, 1);
  }

  private barCornerVp(): number {
    return this.barHeightVp() / 2;
  }
}
