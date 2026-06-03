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
// Mission id of the current foreground app (the one the live snapshot
// shows). -1 when the foreground is the launcher/systemui — i.e. there's
// nothing the user should be able to kill from the foreground card.
export const APP_KEY_DRAG_FOREGROUND_MID = 'OniroDragForegroundMid';

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
  async load(foregroundIsLauncher: boolean = false): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const t0 = Date.now();
    try {
      const missions = await missionManager.getMissionInfos('', MAX_RECENTS + 4);
      // Normally the first non-excluded mission is the current foreground
      // app — its live screenshot is the foreground card, so drop it from
      // the recents row and record its id so the overlay can offer a close
      // (×) on the foreground card too.
      //
      // EXCEPTION: when the launcher is the foreground, its live screenshot
      // is the (non-killable) launcher, while the top NORMAL mission is a
      // real BACKGROUND app. Seeding foregroundSeen=true keeps that app in
      // the row and leaves foregroundMid=-1, so the launcher card offers no
      // × (and we never kill a background app the user can't even see).
      AppStorage.SetOrCreate(APP_KEY_DRAG_FOREGROUND_MID, -1);
      let foregroundSeen = foregroundIsLauncher;
      const candidates: missionManager.MissionInfo[] = [];
      for (const m of missions) {
        const b: string = m.want?.bundleName ?? '';
        if (EXCLUDED_BUNDLES.has(b)) continue;
        if (!foregroundSeen) {
          foregroundSeen = true;
          AppStorage.SetOrCreate(APP_KEY_DRAG_FOREGROUND_MID, m.missionId);
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
      // Row layout convention: oldest leftmost → most-recent-BG
      // closest to the foreground card (which is appended on the
      // right by DragOverlay). So reverse the MRU-sorted result.
      const ordered = snaps.slice().reverse();
      this.cached = ordered;
      AppStorage.SetOrCreate(APP_KEY_DRAG_RECENTS, ordered);
      Log.showInfo(TAG, `loaded ${ordered.length} recents in ${Date.now() - t0} ms`);
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
    AppStorage.SetOrCreate(APP_KEY_DRAG_FOREGROUND_MID, -1);
  }
}
