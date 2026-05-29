//@ts-nocheck
/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0.
 *
 * Port of AOSP SystemUI EdgePanelParams.kt — every per-state geometry,
 * spring, and interpolator the back indicator uses. Values are the
 * stock navigation_edge_* dimens (dp); because OHOS Canvas works in vp
 * and dp == vp, they're used verbatim (no density scaling needed for
 * drawing). Distances the controller compares against the finger are
 * also in vp (the service converts pointer px → vp at the boundary).
 *
 * Also hosts PathInterpolator (cubic-bezier easing, a port of
 * android.view.animation.PathInterpolator) and Step<T> (BackPanel's
 * hysteresis step function for the arrow stroke alpha).
 */

import { SpringForce, createSpring } from './Spring';

/** Cubic-bezier easing P0=(0,0) P1=(c1x,c1y) P2=(c2x,c2y) P3=(1,1). */
export class PathInterpolator {
  private c1x: number; private c1y: number; private c2x: number; private c2y: number;
  constructor(c1x: number, c1y: number, c2x: number, c2y: number) {
    this.c1x = c1x; this.c1y = c1y; this.c2x = c2x; this.c2y = c2y;
  }
  private static bezier(t: number, p1: number, p2: number): number {
    // P0=0, P3=1.
    const mt = 1 - t;
    return 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t;
  }
  getInterpolation(x: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Solve Bx(t) = x for t by binary search (Bx monotonic — all our
    // x control points are within [0,1]), then return By(t).
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 40; i++) {
      t = (lo + hi) / 2;
      const bx = PathInterpolator.bezier(t, this.c1x, this.c2x);
      if (Math.abs(bx - x) < 1e-5) break;
      if (bx < x) lo = t; else hi = t;
    }
    return PathInterpolator.bezier(t, this.c1y, this.c2y);
  }
}

/**
 * Hysteresis step (BackPanelController.Step). Returns one of two values
 * based on a threshold but, to avoid flicker near the boundary, the
 * threshold shifts after it's crossed so small jitter can't re-cross it.
 */
export class StepValue<T> {
  constructor(public value: T, public isNewState: boolean) {}
}
export class Step<T> {
  private threshold: number;
  private factor: number;
  private postThreshold: T;
  private preThreshold: T;
  private lowerFactor: number;
  private startValue: StepValue<T>;
  private previousValue: StepValue<T>;
  private hasCrossedUpperBoundAtLeastOnce = false;

  constructor(threshold: number, factor: number, postThreshold: T, preThreshold: T) {
    this.threshold = threshold;
    this.factor = factor;
    this.postThreshold = postThreshold;
    this.preThreshold = preThreshold;
    this.lowerFactor = 2 - factor;
    this.startValue = new StepValue<T>(preThreshold, false);
    this.previousValue = this.startValue;
  }

  reset(): void {
    this.hasCrossedUpperBoundAtLeastOnce = false;
    this.startValue = new StepValue<T>(this.preThreshold, false);
    this.previousValue = this.startValue;
  }

  get(progress: number): StepValue<T> {
    const hasCrossedUpperBound = progress > this.threshold * this.factor;
    const hasCrossedLowerBound = progress > this.threshold * this.lowerFactor;
    let result: StepValue<T>;
    if (hasCrossedUpperBound && !this.hasCrossedUpperBoundAtLeastOnce) {
      this.hasCrossedUpperBoundAtLeastOnce = true;
      result = new StepValue<T>(this.postThreshold, true);
    } else if (hasCrossedLowerBound) {
      result = new StepValue<T>(this.previousValue.value, false);
    } else if (this.hasCrossedUpperBoundAtLeastOnce) {
      this.hasCrossedUpperBoundAtLeastOnce = false;
      result = new StepValue<T>(this.preThreshold, true);
    } else {
      result = this.startValue;
    }
    this.previousValue = result;
    return result;
  }
}

export interface ArrowDimens {
  length: number | null;
  height: number | null;
  alpha: number;
  heightSpring?: SpringForce | null;
  lengthSpring?: SpringForce | null;
  alphaSpring?: Step<SpringForce> | null;
  alphaInterpolator?: Step<number> | null;
}

export interface BackgroundDimens {
  width: number | null;
  height: number;
  edgeCornerRadius: number;
  farCornerRadius: number;
  alpha: number;
  widthSpring?: SpringForce | null;
  heightSpring?: SpringForce | null;
  farCornerRadiusSpring?: SpringForce | null;
  edgeCornerRadiusSpring?: SpringForce | null;
  alphaSpring?: SpringForce | null;
}

export interface BackIndicatorDimens {
  horizontalTranslation: number | null;
  scale: number;
  scalePivotX?: number | null;
  arrowDimens: ArrowDimens;
  backgroundDimens: BackgroundDimens;
  verticalTranslationSpring?: SpringForce | null;
  horizontalTranslationSpring?: SpringForce | null;
  scaleSpring?: SpringForce | null;
}

export class EdgePanelParams {
  // Scalar tuning constants (vp).
  arrowThickness = 4;
  arrowPaddingEnd = 8;
  minArrowYPosition = 64;
  fingerOffset = 64;
  staticTriggerThreshold = 16;
  reactivationTriggerThreshold = 32;
  // AOSP's getter returns -field, so the negated value is what callers see.
  deactivationTriggerThreshold = -32;
  swipeProgressThreshold = 412;

  // Interpolators.
  entryWidthInterpolator = new PathInterpolator(.19, 1.27, .71, .86);
  entryWidthTowardsEdgeInterpolator = new PathInterpolator(1, -3, 1, 1.2);
  activeWidthInterpolator = new PathInterpolator(.7, -0.24, .48, 1.21);
  arrowAngleInterpolator = this.entryWidthInterpolator;
  horizontalTranslationInterpolator = new PathInterpolator(0.2, 1.0, 1.0, 1.0);
  verticalTranslationInterpolator = new PathInterpolator(.5, 1.15, .41, .94);
  farCornerInterpolator = new PathInterpolator(.03, .19, .14, 1.09);
  edgeCornerInterpolator = new PathInterpolator(0, 1.11, .85, .84);
  heightInterpolator = new PathInterpolator(1, .05, .9, -0.29);

  entryIndicator: BackIndicatorDimens;
  activeIndicator: BackIndicatorDimens;
  cancelledIndicator: BackIndicatorDimens;
  flungIndicator: BackIndicatorDimens;
  committedIndicator: BackIndicatorDimens;
  preThresholdIndicator: BackIndicatorDimens;
  fullyStretchedIndicator: BackIndicatorDimens;

  /** dynamicTriggerThresholdRange.contains(x) — faithful to AOSP, where
   *  the range is built reactivation..(negated deactivation) i.e.
   *  32..-32 and is therefore always empty (never contains). */
  inDynamicRange(_x: number): boolean { return false; }

  constructor() {
    const activeCommittedArrowLengthSpring = createSpring(1500, 0.29);
    const activeCommittedArrowHeightSpring = createSpring(1500, 0.29);
    const flungCommittedEdgeCornerSpring = createSpring(10000, 1);
    const flungCommittedFarCornerSpring = createSpring(10000, 1);
    const flungCommittedWidthSpring = createSpring(10000, 1);
    const flungCommittedHeightSpring = createSpring(10000, 1);

    const commonArrowDimensAlphaThreshold = .165;
    const commonArrowDimensAlphaFactor = 1.05;
    // Step instances are stateful (hysteresis); each indicator that
    // references them shares the instance, matching AOSP.
    const commonArrowDimensAlphaSpring = new Step<SpringForce>(
      commonArrowDimensAlphaThreshold, commonArrowDimensAlphaFactor,
      createSpring(180, 0.9), createSpring(2000, 0.6));
    const commonArrowDimensAlphaSpringInterpolator = new Step<number>(
      commonArrowDimensAlphaThreshold, commonArrowDimensAlphaFactor, 1, 0);

    this.entryIndicator = {
      horizontalTranslation: 4,
      scale: 0.98,
      scalePivotX: 51, // pre_threshold_background_width
      horizontalTranslationSpring: createSpring(800, 0.76),
      verticalTranslationSpring: createSpring(30000, 1),
      scaleSpring: createSpring(120, 0.8),
      arrowDimens: {
        length: 8.6, height: 5, alpha: 0,
        lengthSpring: createSpring(600, 0.4),
        heightSpring: createSpring(600, 0.4),
        alphaSpring: commonArrowDimensAlphaSpring,
        alphaInterpolator: commonArrowDimensAlphaSpringInterpolator,
      },
      backgroundDimens: {
        alpha: 1, width: 0, height: 48, edgeCornerRadius: 6, farCornerRadius: 6,
        widthSpring: createSpring(450, 0.65),
        heightSpring: createSpring(1500, 0.45),
        farCornerRadiusSpring: createSpring(300, 0.5),
        edgeCornerRadiusSpring: createSpring(150, 0.5),
      },
    };

    this.activeIndicator = {
      horizontalTranslation: 14,
      scale: 1.0,
      scalePivotX: 48, // active_background_width
      horizontalTranslationSpring: createSpring(1000, 0.8),
      scaleSpring: createSpring(325, 0.55),
      arrowDimens: {
        length: 6.4, height: 7.2, alpha: 1,
        lengthSpring: activeCommittedArrowLengthSpring,
        heightSpring: activeCommittedArrowHeightSpring,
        alphaSpring: commonArrowDimensAlphaSpring,
        alphaInterpolator: commonArrowDimensAlphaSpringInterpolator,
      },
      backgroundDimens: {
        alpha: 1, width: 48, height: 48, edgeCornerRadius: 24, farCornerRadius: 24,
        widthSpring: createSpring(850, 0.75),
        heightSpring: createSpring(10000, 1),
        edgeCornerRadiusSpring: createSpring(2600, 0.855),
        farCornerRadiusSpring: createSpring(1200, 0.30),
      },
    };

    this.preThresholdIndicator = {
      horizontalTranslation: 4,
      scale: 0.98,
      scalePivotX: 51,
      scaleSpring: createSpring(120, 0.8),
      horizontalTranslationSpring: createSpring(6000, 1),
      arrowDimens: {
        length: 8, height: 5.6, alpha: 1,
        lengthSpring: createSpring(100, 0.6),
        heightSpring: createSpring(100, 0.6),
        alphaSpring: commonArrowDimensAlphaSpring,
        alphaInterpolator: commonArrowDimensAlphaSpringInterpolator,
      },
      backgroundDimens: {
        alpha: 1, width: 51, height: 46, edgeCornerRadius: 16, farCornerRadius: 20,
        widthSpring: createSpring(650, 1),
        heightSpring: createSpring(1500, 0.45),
        farCornerRadiusSpring: createSpring(300, 1),
        edgeCornerRadiusSpring: createSpring(250, 0.5),
      },
    };

    // committed = active.copy(...) — see EdgePanelParams.kt.
    this.committedIndicator = {
      horizontalTranslation: null,
      scale: 0.86,
      scalePivotX: null,
      horizontalTranslationSpring: this.activeIndicator.horizontalTranslationSpring,
      scaleSpring: createSpring(5700, 1),
      arrowDimens: {
        length: null, height: null, alpha: 1,
        lengthSpring: activeCommittedArrowLengthSpring,
        heightSpring: activeCommittedArrowHeightSpring,
        alphaSpring: commonArrowDimensAlphaSpring,
        alphaInterpolator: commonArrowDimensAlphaSpringInterpolator,
      },
      backgroundDimens: {
        alpha: 0, width: null, height: 48, edgeCornerRadius: 24, farCornerRadius: 24,
        widthSpring: flungCommittedWidthSpring,
        heightSpring: flungCommittedHeightSpring,
        edgeCornerRadiusSpring: flungCommittedEdgeCornerSpring,
        farCornerRadiusSpring: flungCommittedFarCornerSpring,
        alphaSpring: createSpring(1400, 1),
      },
    };

    // flung = committed.copy(...) — restores active arrow length/height.
    this.flungIndicator = {
      horizontalTranslation: null,
      scale: 0.86,
      scalePivotX: null,
      horizontalTranslationSpring: this.activeIndicator.horizontalTranslationSpring,
      scaleSpring: createSpring(5700, 1),
      arrowDimens: {
        length: 6.4, height: 7.2, alpha: 1,
        lengthSpring: createSpring(850, 0.46),
        heightSpring: createSpring(850, 0.46),
        alphaSpring: commonArrowDimensAlphaSpring,
        alphaInterpolator: commonArrowDimensAlphaSpringInterpolator,
      },
      backgroundDimens: {
        alpha: 0, width: null, height: 48, edgeCornerRadius: 24, farCornerRadius: 24,
        widthSpring: flungCommittedWidthSpring,
        heightSpring: flungCommittedHeightSpring,
        edgeCornerRadiusSpring: flungCommittedEdgeCornerSpring,
        farCornerRadiusSpring: flungCommittedFarCornerSpring,
        alphaSpring: createSpring(1400, 1),
      },
    };

    // cancelled = entry.copy(background width=0, alpha=0, ...).
    this.cancelledIndicator = {
      horizontalTranslation: 4,
      scale: 0.98,
      scalePivotX: 51,
      horizontalTranslationSpring: createSpring(800, 0.76),
      verticalTranslationSpring: createSpring(30000, 1),
      scaleSpring: createSpring(120, 0.8),
      arrowDimens: {
        length: 8.6, height: 5, alpha: 0,
        lengthSpring: createSpring(600, 0.4),
        heightSpring: createSpring(600, 0.4),
        alphaSpring: commonArrowDimensAlphaSpring,
        alphaInterpolator: commonArrowDimensAlphaSpringInterpolator,
      },
      backgroundDimens: {
        alpha: 0, width: 0, height: 48, edgeCornerRadius: 6, farCornerRadius: 6,
        widthSpring: createSpring(450, 0.65),
        heightSpring: createSpring(1500, 0.45),
        farCornerRadiusSpring: createSpring(300, 0.5),
        edgeCornerRadiusSpring: createSpring(150, 0.5),
        alphaSpring: createSpring(450, 1),
      },
    };

    this.fullyStretchedIndicator = {
      horizontalTranslation: 18,
      scale: 1.0,
      arrowDimens: {
        length: 5.6, height: 8, alpha: 1,
        alphaSpring: null, heightSpring: null, lengthSpring: null,
      },
      backgroundDimens: {
        alpha: 1, width: 60, height: 48, edgeCornerRadius: 24, farCornerRadius: 24,
        alphaSpring: null, widthSpring: null, heightSpring: null,
        edgeCornerRadiusSpring: null, farCornerRadiusSpring: null,
      },
    };
  }
}
