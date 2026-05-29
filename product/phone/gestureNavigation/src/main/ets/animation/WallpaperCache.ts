//@ts-nocheck
/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0.
 *
 * System-wallpaper source for the drag overlay's backdrop.
 *
 * AOSP Launcher3 shows the live wallpaper underneath the shrunken
 * app snapshot during a swipe-up. OHOS exposes the system wallpaper
 * as a PixelMap via `@ohos.wallpaper.getImage(WALLPAPER_SYSTEM)` —
 * gated behind `ohos.permission.GET_WALLPAPER` + @systemapi (which
 * systemui has). We load it at onCreate, publish it to AppStorage
 * (the DragOverlay binds it via @StorageLink), and subscribe to
 * `wallpaperChange` so a change to the system wallpaper is reflected
 * live — same managed wallpaper the launcher home screen shows.
 */

import wallpaper from '@ohos.wallpaper';
import { image } from '@kit.ImageKit';
import Log from '../../../../../../../common/src/main/ets/default/Log';

const TAG = 'GestureNavigation_WallpaperCache';

export const APP_KEY_DRAG_WALLPAPER = 'OniroDragWallpaper';

// The bound Image keeps rendering the previous PixelMap for a moment after the
// @StorageLink swaps; releasing it synchronously would free the native buffer
// out from under the component. Wallpaper changes are rare, so defer the free.
const RELEASE_DELAY_MS = 3000;

export class WallpaperCache {
  private pixelMap: image.PixelMap | null = null;
  private listening: boolean = false;
  // Monotonic load token — discard out-of-order getImage() resolutions so a
  // newer wallpaper can't be overwritten by an older one that resolves late.
  private loadSeq: number = 0;

  // Stable reference so wallpaper.off() can deregister exactly this listener.
  private readonly onWallpaperChange = (type: wallpaper.WallpaperType): void => {
    if (type === wallpaper.WallpaperType.WALLPAPER_SYSTEM) {
      Log.showInfo(TAG, 'wallpaperChange(SYSTEM): reloading');
      this.fetch();
    }
  };

  async load(): Promise<void> {
    // Subscribe once so the drag overlay tracks live wallpaper changes instead
    // of going stale until the next systemui restart.
    if (!this.listening) {
      this.listening = true;
      try {
        wallpaper.on('wallpaperChange', this.onWallpaperChange);
      } catch (e) {
        Log.showWarn(TAG, `wallpaper.on failed: ${JSON.stringify(e)}`);
      }
    }
    await this.fetch();
  }

  // Deregister the wallpaperChange listener. Call from the owner's onDestroy so
  // a recreated ServiceExtAbility doesn't leak this instance + its listener.
  stop(): void {
    if (this.listening) {
      this.listening = false;
      try {
        wallpaper.off('wallpaperChange', this.onWallpaperChange);
      } catch (e) {
        Log.showWarn(TAG, `wallpaper.off failed: ${JSON.stringify(e)}`);
      }
    }
  }

  private async fetch(): Promise<void> {
    const seq = ++this.loadSeq;
    try {
      const pm: image.PixelMap = await wallpaper.getImage(
        wallpaper.WallpaperType.WALLPAPER_SYSTEM);
      if (seq !== this.loadSeq) {
        // Superseded by a newer fetch — this map was never published; free it.
        pm.release().catch(
          (e) => Log.showWarn(TAG, `stale pixelMap.release failed: ${JSON.stringify(e)}`));
        return;
      }
      // Publish the new map first, then free the old one once the bound
      // DragOverlay Image has had time to swap to it.
      const old = this.pixelMap;
      this.pixelMap = pm;
      AppStorage.SetOrCreate(APP_KEY_DRAG_WALLPAPER, pm);
      Log.showInfo(TAG, 'wallpaper loaded');
      if (old != null) {
        setTimeout(() => {
          old.release().catch(
            (e) => Log.showWarn(TAG, `pixelMap.release failed: ${JSON.stringify(e)}`));
        }, RELEASE_DELAY_MS);
      }
    } catch (e) {
      Log.showWarn(TAG, `wallpaper.getImage failed: ${JSON.stringify(e)}`);
    }
  }
}
