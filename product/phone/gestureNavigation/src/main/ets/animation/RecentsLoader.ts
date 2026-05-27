//@ts-nocheck
/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0.
 *
 * Loads the recent-missions list + their snapshots in parallel at
 * gesture start, so the DragOverlay can render adjacent app cards to
 * the LEFT of the captured foreground snapshot as the user drags.
 *
 * Mirrors RecentsOverlay's filter (drop launcher + systemui), and also
 * drops the first entry returned by missionManager — that's the
 * foreground mission, already covered by SnapshotCapture's live
 * screenshot. Caps the result at MAX_RECENTS to keep both the snapshot
 * batch latency and the Row's pixel footprint bounded.
 */

import missionManager from '@ohos.app.ability.missionManager';
import { image } from '@kit.ImageKit';
import Log from '../../../../../../../common/src/main/ets/default/Log';

const TAG = 'GestureNavigation_RecentsLoader';

export const APP_KEY_DRAG_RECENTS = 'OniroDragRecents';

const MAX_RECENTS = 5;
const EXCLUDED_BUNDLES = new Set<string>([
  'com.ohos.launcher',
  'com.ohos.systemui',
]);

export interface RecentsCardData {
  missionId: number;
  label: string;
  snap: image.PixelMap | null;
}

export class RecentsLoader {
  private inFlight = false;
  private cached: RecentsCardData[] = [];

  /**
   * Fetch mission list and per-mission snapshots in parallel. Writes
   * the result into AppStorage as an array of RecentsCardData. The
   * Overlay's ForEach picks it up via @StorageLink.
   *
   * The first item from missionManager is the current foreground (we
   * dropped it). The rest are returned in MRU order — index 0 in the
   * resulting array is the most-recent BACKGROUND app, rendered
   * closest to the foreground card in the row.
   */
  async load(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const t0 = Date.now();
    try {
      const missions = await missionManager.getMissionInfos('', MAX_RECENTS + 4);
      // Drop foreground (first non-launcher entry) + excluded bundles.
      let foregroundSeen = false;
      const candidates: missionManager.MissionInfo[] = [];
      for (const m of missions) {
        const b: string = m.want?.bundleName ?? '';
        if (EXCLUDED_BUNDLES.has(b)) continue;
        if (!foregroundSeen) {
          foregroundSeen = true;
          continue;
        }
        candidates.push(m);
        if (candidates.length >= MAX_RECENTS) break;
      }
      const snaps = await Promise.all(candidates.map(async (m): Promise<RecentsCardData> => {
        let snap: image.PixelMap | null = null;
        try {
          const s = await missionManager.getMissionSnapShot('', m.missionId);
          snap = s.snapshot;
        } catch (e) {
          Log.showWarn(TAG, `snap failed mid=${m.missionId}: ${JSON.stringify(e)}`);
        }
        return {
          missionId: m.missionId,
          label: m.label || m.want?.bundleName || `#${m.missionId}`,
          snap,
        };
      }));
      this.cached = snaps;
      AppStorage.SetOrCreate(APP_KEY_DRAG_RECENTS, snaps);
      Log.showInfo(TAG, `loaded ${snaps.length} recents in ${Date.now() - t0} ms`);
    } catch (e) {
      Log.showWarn(TAG, `load failed: ${JSON.stringify(e)}`);
      AppStorage.SetOrCreate(APP_KEY_DRAG_RECENTS, [] as RecentsCardData[]);
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Most recent count (synchronous read of cached state). Used by
   * DragController to compute row geometry without having to subscribe
   * to AppStorage.
   */
  count(): number {
    return this.cached.length;
  }

  /**
   * Release any PixelMaps we're holding and clear the storage key.
   */
  clear(): void {
    for (const c of this.cached) {
      c.snap?.release().catch(() => {});
    }
    this.cached = [];
    AppStorage.SetOrCreate(APP_KEY_DRAG_RECENTS, [] as RecentsCardData[]);
  }
}
