//@ts-nocheck
/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0.
 *
 * One-shot wallpaper fetch for the drag overlay's backdrop.
 *
 * AOSP Launcher3 shows the live wallpaper underneath the shrunken
 * app snapshot during a swipe-up. OHOS exposes the system wallpaper
 * as a PixelMap via `@ohos.wallpaper.getImage(WALLPAPER_SYSTEM)` —
 * gated behind `ohos.permission.GET_WALLPAPER` + @systemapi (which
 * systemui has). We load it once at onCreate and re-use the same
 * PixelMap for every gesture. If the wallpaper changes mid-session
 * we'd be stale; in practice systemui restarts on every flash and
 * the user rarely changes wallpaper, so refresh-on-event isn't
 * worth the complexity yet.
 */

import wallpaper from '@ohos.wallpaper';
import { image } from '@kit.ImageKit';
import Log from '../../../../../../../common/src/main/ets/default/Log';

const TAG = 'GestureNavigation_WallpaperCache';

export const APP_KEY_DRAG_WALLPAPER = 'OniroDragWallpaper';

export class WallpaperCache {
  private pixelMap: image.PixelMap | null = null;

  async load(): Promise<void> {
    try {
      const pm: image.PixelMap = await wallpaper.getImage(
        wallpaper.WallpaperType.WALLPAPER_SYSTEM);
      this.pixelMap = pm;
      AppStorage.SetOrCreate(APP_KEY_DRAG_WALLPAPER, pm);
      Log.showInfo(TAG, 'wallpaper loaded');
    } catch (e) {
      Log.showWarn(TAG, `wallpaper.getImage failed: ${JSON.stringify(e)}`);
    }
  }
}
