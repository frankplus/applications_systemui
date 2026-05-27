/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import missionManager from '@ohos.app.ability.missionManager';
import curves from '@ohos.curves';
import window from '@ohos.window';
import { image } from '@kit.ImageKit';

const TAG = 'GestureNavigation_RecentsOverlay';
const MAX_MISSIONS = 16;

@Component
struct MissionCard {
  @Prop label: string;
  @Prop missionId: number;
  snap: image.PixelMap | null = null;
  onActivate: (mid: number) => void = () => {};
  onDismiss: (mid: number) => void = () => {};

  build() {
    // Stack so the × is a SIBLING of the activatable column, not a
    // descendant — otherwise its onClick bubbles up to the activate handler.
    Stack({ alignContent: Alignment.TopEnd }) {
      Column() {
        if (this.snap) {
          Image(this.snap).width(200).height(360).borderRadius(16).objectFit(ImageFit.Cover);
        } else {
          Column()
            .width(200).height(360).borderRadius(16).backgroundColor('#444444');
        }
        Text(this.label || `#${this.missionId}`)
          .fontSize(14)
          .fontColor(Color.White)
          .margin({ top: 8 })
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis });
      }
      .onClick(() => this.onActivate(this.missionId));

      Text('×')
        .fontSize(20)
        .fontColor(Color.White)
        .fontWeight(FontWeight.Bold)
        .textAlign(TextAlign.Center)
        .width(28).height(28)
        .borderRadius(14)
        .backgroundColor('#88000000')
        .margin({ top: 8, right: 8 })
        .onClick(() => this.onDismiss(this.missionId));
    }
    .width(200);
  }
}

interface MissionEntry {
  missionId: number;
  label: string;
  snap: image.PixelMap | null;
}

@Entry
@Component
struct RecentsOverlay {
  @State entries: MissionEntry[] = [];
  @State ready: boolean = false;

  // Bundles we never show in recents: the launcher is "home", and our own
  // overlay shouldn't list itself.
  private static readonly EXCLUDED_BUNDLES = new Set<string>([
    'com.ohos.launcher',
    'com.ohos.systemui',
  ]);

  async aboutToAppear() {
    console.log(`${TAG} aboutToAppear`);
    try {
      const missions = await missionManager.getMissionInfos('', MAX_MISSIONS);
      const bundleNames = missions.map((m) => m.want?.bundleName ?? '?').join(',');
      console.log(`${TAG} got ${missions.length} missions: [${bundleNames}]`);
      const entries: MissionEntry[] = [];
      for (const m of missions) {
        const bundleName: string = m.want?.bundleName ?? '';
        if (RecentsOverlay.EXCLUDED_BUNDLES.has(bundleName)) {
          continue;
        }
        let snap: image.PixelMap | null = null;
        try {
          const s = await missionManager.getMissionSnapShot('', m.missionId);
          snap = s.snapshot;
        } catch (e) {
          console.warn(`${TAG} snap failed mid=${m.missionId}: ${JSON.stringify(e)}`);
        }
        entries.push({
          missionId: m.missionId,
          label: m.label || bundleName,
          snap,
        });
      }
      this.entries = entries;
      this.ready = true;
    } catch (e) {
      console.error(`${TAG} getMissionInfos failed: ${JSON.stringify(e)}`);
      this.ready = true;
    }
  }

  private activate(mid: number): void {
    console.log(`${TAG} activate mid=${mid}`);
    missionManager.moveMissionToFront(mid).then((): void => this.dismiss())
      .catch((e: object): void => {
        console.error(`${TAG} moveToFront failed: ${JSON.stringify(e)}`);
      });
  }

  private dismissMission(mid: number): void {
    console.log(`${TAG} clear mid=${mid}`);
    missionManager.clearMission(mid).then((): void => {
      this.entries = this.entries.filter((x: MissionEntry): boolean => x.missionId !== mid);
    }).catch((e: object): void => {
      console.error(`${TAG} clearMission failed: ${JSON.stringify(e)}`);
    });
  }

  private dismiss() {
    console.log(`${TAG} dismiss`);
    AppStorage.SetOrCreate('OniroRecentsOpen', false);
    try {
      const win = window.findWindow('OniroRecentsOverlay');
      // destroy (not hide) — service treats a fresh open as a clean create,
      // so the mission list re-fetches on the next swipe.
      win.destroyWindow().catch((e: Error) => {
        console.warn(`${TAG} destroy failed: ${JSON.stringify(e)}`);
      });
    } catch (e) {
      console.warn(`${TAG} findWindow failed: ${JSON.stringify(e)}`);
    }
  }

  build() {
    Stack() {
      // Backdrop intentionally has its own onClick on a transparent Column
      // so the launcher / focused app beneath us doesn't eat the tap.
      Column()
        .width('100%').height('100%')
        .backgroundColor('rgba(0,0,0,0.55)')
        .onClick(() => this.dismiss());

      if (this.ready && this.entries.length === 0) {
        Text('No recent apps')
          .fontSize(18).fontColor(Color.White);
      } else {
        Scroll() {
          Row({ space: 16 }) {
            ForEach(this.entries, (m: MissionEntry) => {
              MissionCard({
                label: m.label,
                missionId: m.missionId,
                snap: m.snap,
                onActivate: (mid: number) => this.activate(mid),
                onDismiss: (mid: number) => this.dismissMission(mid),
              })
            }, (m: MissionEntry) => `${m.missionId}`)
          }
          .padding(24);
        }
        .scrollable(ScrollDirection.Horizontal)
        .scrollBar(BarState.Off);
      }
    }
    .width('100%').height('100%')
    .transition(TransitionEffect.move(TransitionEdge.BOTTOM)
      .animation({ curve: curves.springMotion(0.34, 0.82) }));
  }
}
