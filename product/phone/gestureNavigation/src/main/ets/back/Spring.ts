//@ts-nocheck
/*
 * Copyright (C) 2018 The Android Open Source Project
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
 * Derivative work: ported from AOSP androidx.dynamicanimation
 * (SpringForce / SpringAnimation) and SystemUI BackPanel.kt's
 * AnimatedFloat (Copyright (C) 2022 The Android Open Source Project);
 * translated to TypeScript and modified.
 *
 * Spring physics for the side-edge back indicator — a port of AOSP
 * SystemUI's use of androidx.dynamicanimation (SpringForce +
 * SpringAnimation) plus BackPanel.kt's `AnimatedFloat` wrapper.
 *
 * androidx solves a damped harmonic oscillator (mass = 1) ANALYTICALLY
 * per frame: given (displacement, velocity, dt) it returns the exact
 * (displacement, velocity) at dt later. The closed form is exact for
 * any dt, so frame jitter only makes the visual stride uneven, never
 * unstable — we feed it the real elapsed dt each tick.
 *
 *   natural frequency   ω = sqrt(stiffness)          (mass = 1)
 *   damping ratio       ζ = dampingRatio
 *   under-damped  (ζ<1): decaying sinusoid
 *   critically    (ζ=1): (A + B t) e^{-ω t}
 *   over-damped   (ζ>1): sum of two decaying exponentials
 *
 * Units: positions in vp, velocities in vp/s, dt in SECONDS — matching
 * androidx (stiffness values like 800/1500 are ω² in rad²/s², and the
 * pop start-velocities in BackPanelController are vp/s). The caller
 * converts pointer px → vp at the boundary.
 */

// androidx DynamicAnimation thresholds.
const THRESHOLD_MULTIPLIER = 0.75;
const VELOCITY_THRESHOLD_MULTIPLIER = 1000.0 / 16.0; // 62.5

// BackPanel.kt minimum-visible-change presets (androidx SpringAnimation
// MIN_VISIBLE_CHANGE_* constants).
export const MIN_VISIBLE_CHANGE_PIXELS = 1;
export const MIN_VISIBLE_CHANGE_ROTATION_DEGREES = 0.1;
export const MIN_VISIBLE_CHANGE_SCALE = 1 / 250;
export const MIN_VISIBLE_CHANGE_ALPHA = 1 / 256;

/** androidx SpringForce — stiffness + damping ratio + final position. */
export class SpringForce {
  stiffness: number = 1500; // STIFFNESS_MEDIUM-ish default
  dampingRatio: number = 0.5;
  finalPosition: number = 0;

  constructor(stiffness?: number, dampingRatio?: number) {
    if (stiffness !== undefined) this.stiffness = stiffness;
    if (dampingRatio !== undefined) this.dampingRatio = dampingRatio;
  }

  setStiffness(s: number): SpringForce { this.stiffness = s; return this; }
  setDampingRatio(d: number): SpringForce { this.dampingRatio = d; return this; }
  setFinalPosition(p: number): SpringForce { this.finalPosition = p; return this; }

  /**
   * Advance the oscillator by `dtSec` seconds. Returns the new
   * { value, velocity }. `value`/`velocity` are the CURRENT state.
   */
  updateValues(value: number, velocity: number, dtSec: number): { value: number; velocity: number } {
    const omega = Math.sqrt(this.stiffness);
    const zeta = this.dampingRatio;
    const x = value - this.finalPosition; // displacement from rest
    const v = velocity;
    let newX: number;
    let newV: number;

    if (zeta < 1 - 1e-6) {
      // Under-damped.
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      const a = zeta * omega;
      const e = Math.exp(-a * dtSec);
      const cos = Math.cos(wd * dtSec);
      const sin = Math.sin(wd * dtSec);
      const A = x;
      const B = (a * x + v) / wd;
      newX = e * (A * cos + B * sin);
      newV = e * ((-a * A + B * wd) * cos + (-a * B - A * wd) * sin);
    } else if (zeta <= 1 + 1e-6) {
      // Critically damped.
      const e = Math.exp(-omega * dtSec);
      const A = x;
      const B = v + omega * x;
      newX = (A + B * dtSec) * e;
      newV = (B - omega * (A + B * dtSec)) * e;
    } else {
      // Over-damped.
      const s = Math.sqrt(zeta * zeta - 1);
      const r1 = -omega * (zeta - s);
      const r2 = -omega * (zeta + s);
      const c2 = (r1 * x - v) / (r1 - r2);
      const c1 = x - c2;
      const e1 = Math.exp(r1 * dtSec);
      const e2 = Math.exp(r2 * dtSec);
      newX = c1 * e1 + c2 * e2;
      newV = c1 * r1 * e1 + c2 * r2 * e2;
    }

    return { value: newX + this.finalPosition, velocity: newV };
  }
}

export interface AnimationEndListener {
  /** Fired once when the spring settles (canceled=false) or is
   *  cancelled (canceled=true). */
  onAnimationEnd(canceled: boolean): void;
}

/**
 * BackPanel.AnimatedFloat port. Wraps a SpringForce with a resting
 * position and the stretch/snap helpers the controller drives. Ticked
 * externally by BackPanelModel.tick().
 */
export class AnimatedFloat {
  readonly name: string;
  spring: SpringForce = new SpringForce();

  // The resting position when not stretched by a touch drag.
  private restingPosition = 0;
  // The current animated value + velocity.
  pos = 0;
  private velocity = 0;
  private running = false;

  private minValue: number | null;
  private maxValue: number | null;
  private valueThreshold: number;
  private velocityThreshold: number;

  private endListeners: AnimationEndListener[] = [];

  constructor(
    name: string,
    minimumVisibleChange?: number,
    minimumValue?: number,
    maximumValue?: number,
  ) {
    this.name = name;
    this.minValue = minimumValue ?? null;
    this.maxValue = maximumValue ?? null;
    const mvc = minimumVisibleChange ?? MIN_VISIBLE_CHANGE_PIXELS;
    this.valueThreshold = mvc * THRESHOLD_MULTIPLIER;
    this.velocityThreshold = this.valueThreshold * VELOCITY_THRESHOLD_MULTIPLIER;
  }

  get isRunning(): boolean { return this.running; }

  /** Replace the spring (cancels the in-flight animation, AOSP setter).
   *  Clones the incoming SpringForce so we never mutate the shared
   *  EdgePanelParams instances when animateToFinalPosition later writes
   *  finalPosition (several indicators reference the same SpringForce). */
  setSpring(s: SpringForce): void {
    this.cancel();
    const fresh = new SpringForce(s.stiffness, s.dampingRatio);
    fresh.finalPosition = this.spring.finalPosition;
    this.spring = fresh;
  }

  addEndListener(l: AnimationEndListener): void {
    this.endListeners.push(l);
  }

  private fireEnd(canceled: boolean): void {
    if (this.endListeners.length === 0) return;
    const listeners = this.endListeners;
    this.endListeners = [];
    for (const l of listeners) l.onAnimationEnd(canceled);
  }

  private animateToFinalPosition(finalPos: number): void {
    this.spring.finalPosition = finalPos;
    this.running = true;
  }

  snapTo(newPosition: number): void {
    this.cancel();
    this.restingPosition = newPosition;
    this.spring.finalPosition = newPosition;
    this.pos = this.clamp(newPosition);
    this.velocity = 0;
  }

  snapToRestingPosition(): void { this.snapTo(this.restingPosition); }

  stretchTo(stretchAmount: number, startingVelocity?: number, springForce?: SpringForce): void {
    if (startingVelocity !== undefined) {
      this.cancel();
      this.velocity = startingVelocity;
    }
    // Clone (don't adopt) the shared params SpringForce — see setSpring.
    if (springForce) this.spring = new SpringForce(springForce.stiffness, springForce.dampingRatio);
    this.animateToFinalPosition(this.restingPosition + stretchAmount);
  }

  /** Animate to (restingPosition + amount*(finalPosition-restingPosition)).
   *  restingPosition is unchanged — only the animation target moves. */
  stretchBy(finalPosition: number | null, amount: number): void {
    const stretched = amount * ((finalPosition ?? 0) - this.restingPosition);
    this.animateToFinalPosition(this.restingPosition + stretched);
  }

  updateRestingPosition(pos: number | null | undefined, animated: boolean = true): void {
    if (pos === null || pos === undefined) return;
    this.restingPosition = pos;
    if (animated) {
      this.animateToFinalPosition(this.restingPosition);
    } else {
      this.snapTo(this.restingPosition);
    }
  }

  cancel(): void {
    if (this.running) {
      this.running = false;
      this.fireEnd(true);
    }
  }

  private clamp(v: number): number {
    if (this.minValue !== null && v < this.minValue) return this.minValue;
    if (this.maxValue !== null && v > this.maxValue) return this.maxValue;
    return v;
  }

  /** Advance one frame. Returns true if still running after the step. */
  tick(dtSec: number): boolean {
    if (!this.running) return false;
    const r = this.spring.updateValues(this.pos, this.velocity, dtSec);
    let value = r.value;
    let vel = r.velocity;

    // Clamp to bounds; hitting a bound ends the animation at the bound.
    if (this.minValue !== null && value < this.minValue) {
      this.pos = this.minValue; this.velocity = 0; this.running = false; this.fireEnd(false); return false;
    }
    if (this.maxValue !== null && value > this.maxValue) {
      this.pos = this.maxValue; this.velocity = 0; this.running = false; this.fireEnd(false); return false;
    }

    this.pos = value;
    this.velocity = vel;

    // Equilibrium check (androidx isAtEquilibrium).
    if (Math.abs(vel) < this.velocityThreshold &&
        Math.abs(value - this.spring.finalPosition) < this.valueThreshold) {
      this.pos = this.spring.finalPosition;
      this.velocity = 0;
      this.running = false;
      this.fireEnd(false);
      return false;
    }
    return true;
  }
}

export function createSpring(stiffness: number, dampingRatio: number): SpringForce {
  return new SpringForce(stiffness, dampingRatio);
}
