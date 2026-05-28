/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Bottom home-indicator bar — a static iOS/Android-style pill at the
 * bottom of the screen. Visibility is gated on `OniroDockVisible`,
 * which the parent service sets true while gesture nav is the active
 * nav mode and false in 3-button mode. The bar itself does not react
 * to drag progress; per-frame drag feedback is provided by the
 * DragOverlay snapshot transform.
 */

@Entry
@Component
struct GestureDock {
  @StorageLink('OniroDockVisible') visible: boolean = false;

  build() {
    Stack() {
      Column()
        .width(108)
        .height(5)
        .borderRadius(2.5)
        .backgroundColor('#E6FFFFFF')
        .shadow({
          radius: 6,
          color: '#40000000',
          offsetX: 0,
          offsetY: 1,
        })
        .opacity(this.visible ? 1 : 0);
    }
    .width('100%')
    .height('100%')
    .alignContent(Alignment.Center);
  }
}
