//@ts-nocheck
/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0.
 *
 * Foreground-app screen capture for the swipe-up drag animation.
 *
 * OHOS does not expose a live, transformable surface handle for the
 * foreground app (the JS equivalent of Android's RemoteAnimationTarget
 * .leash is internal-only — see plans/sharded-doodling-gosling.md).
 * Instead we capture a PixelMap of the live display via
 * @ohos.screenshot.save() at gesture start and render it in an
 * overlay window that we transform per-frame.
 *
 * Capture is best-effort: a failure logs at WARN and leaves the
 * AppStorage key unset, in which case the overlay renders nothing and
 * the existing dock + commit path still works.
 */

import screenshot from '@ohos.screenshot';
import { image } from '@kit.ImageKit';
import Log from '../../../../../../../common/src/main/ets/default/Log';

const TAG = 'GestureNavigation_SnapshotCapture';

export const APP_KEY_DRAG_SNAP = 'OniroDragSnap';

export class SnapshotCapture {
  private inFlight = false;
  private lastPixelMap: image.PixelMap | null = null;

  /**
   * Capture the current display into a PixelMap and stash it in
   * AppStorage under OniroDragSnap. Returns the elapsed time in ms
   * (or -1 on failure) so callers can profile.
   *
   * Re-entry is gated: if a previous capture is still in flight, this
   * call is a no-op (returns 0 immediately). The recognizer fires
   * onTrackingStart once per gesture so this normally doesn't matter.
   */
  async capture(widthPx: number, heightPx: number): Promise<number> {
    if (this.inFlight) {
      Log.showDebug(TAG, 'capture: skipped, in-flight');
      return 0;
    }
    this.inFlight = true;
    const t0 = Date.now();
    try {
      // Half-res keeps the captured PixelMap small enough that the
      // screenshot path completes in ~150-250 ms instead of ~700 ms.
      // ArkUI scales the Image up to fullscreen, so the loss of detail
      // is invisible on a mid-gesture animation.
      const options: screenshot.ScreenshotOptions = {
        imageSize: {
          width: Math.max(1, Math.round(widthPx / 2)),
          height: Math.max(1, Math.round(heightPx / 2)),
        },
      };
      const pm: image.PixelMap = await screenshot.save(options);
      const elapsed = Date.now() - t0;
      if (this.lastPixelMap) {
        this.lastPixelMap.release().catch(() => {});
      }
      this.lastPixelMap = pm;
      AppStorage.SetOrCreate(APP_KEY_DRAG_SNAP, pm);
      Log.showInfo(TAG, `capture ok in ${elapsed} ms`);
      return elapsed;
    } catch (e) {
      const elapsed = Date.now() - t0;
      Log.showWarn(TAG, `capture failed in ${elapsed} ms: ${JSON.stringify(e)}`);
      return -1;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Clear AppStorage and release the underlying PixelMap so the
   * overlay stops rendering and we don't hold a 1080p-sized buffer
   * between gestures.
   */
  clear(): void {
    AppStorage.SetOrCreate(APP_KEY_DRAG_SNAP, null);
    if (this.lastPixelMap) {
      this.lastPixelMap.release().catch(() => {});
      this.lastPixelMap = null;
    }
  }
}
