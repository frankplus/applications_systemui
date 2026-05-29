//@ts-nocheck
/*
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
 * Attribution: the public API (addMovement / computeCurrentVelocity /
 * reset) is modeled on android.view.VelocityTracker, but this is an
 * independent original implementation — it contains no AOSP source code
 * (it uses a weighted moving average, not AOSP's least-squares solver).
 *
 * Sliding-window velocity tracker. Modeled on android.view.VelocityTracker
 * (frameworks/native/libs/input/VelocityTracker.cpp) but uses a simple
 * weighted moving average over the most-recent samples instead of LSQ
 * regression. Good enough for end-of-gesture fling decisions.
 *
 * Caller convention: feed positions in any linear unit (px or vp) and
 * times in ms; computeCurrentVelocity() returns velocity in the same
 * unit per millisecond. Keep units consistent across calls.
 */

interface Sample {
  t: number;  // ms
  v: number;  // position value
}

export class VelocityTracker {
  private samples: Sample[] = [];
  private maxAgeMs: number;
  private maxSamples: number;

  constructor(maxAgeMs: number = 100, maxSamples: number = 20) {
    this.maxAgeMs = maxAgeMs;
    this.maxSamples = maxSamples;
  }

  reset(): void {
    this.samples.length = 0;
  }

  addMovement(timeMs: number, value: number): void {
    this.samples.push({ t: timeMs, v: value });
    this.prune(timeMs);
  }

  /**
   * Average instantaneous velocity (value units per ms) over the
   * remaining samples. Older samples decay linearly so the most recent
   * motion dominates — matches the spirit of Android's tracker without
   * the LSQ machinery.
   *
   * Returns 0 when fewer than 2 samples are available.
   */
  computeCurrentVelocity(): number {
    const n = this.samples.length;
    if (n < 2) return 0;
    const now = this.samples[n - 1].t;
    let weightedSum = 0;
    let weightTotal = 0;
    for (let i = 1; i < n; i++) {
      const a = this.samples[i - 1];
      const b = this.samples[i];
      const dt = b.t - a.t;
      if (dt <= 0) continue;
      const instV = (b.v - a.v) / dt;
      // Newer pairs get higher weight (linear decay by age relative to now)
      const age = Math.max(now - b.t, 0);
      const w = Math.max(1 - age / this.maxAgeMs, 0.05);
      weightedSum += instV * w;
      weightTotal += w;
    }
    return weightTotal > 0 ? weightedSum / weightTotal : 0;
  }

  /**
   * Most recent value fed to the tracker, or NaN if empty.
   */
  lastValue(): number {
    return this.samples.length === 0 ? NaN : this.samples[this.samples.length - 1].v;
  }

  /**
   * Most recent timestamp fed to the tracker, or NaN if empty.
   */
  lastTime(): number {
    return this.samples.length === 0 ? NaN : this.samples[this.samples.length - 1].t;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.maxAgeMs;
    let dropTo = 0;
    while (dropTo < this.samples.length && this.samples[dropTo].t < cutoff) dropTo++;
    if (dropTo > 0) this.samples.splice(0, dropTo);
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
  }
}
