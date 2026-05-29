# Third-party notices — phone_gestureNavigation

This module's gesture-navigation logic (the bottom-edge HOME/RECENTS
Quickstep gestures and the side-edge "back" indicator) contains work
**derived from the Android Open Source Project (AOSP)**, which is licensed
under the Apache License, Version 2.0. The OpenHarmony systemui component
is likewise Apache-2.0, so the combined work is distributed under that
same license.

Per Apache-2.0 §4, each derivative source file below retains the original
`Copyright (C) <year> The Android Open Source Project` notice in its header
and states that it was modified. This file consolidates that attribution.

## Derivative works (ported AOSP source, translated and modified)

| File | Derived from (AOSP) | AOSP © |
|---|---|---|
| `back/Spring.ts` | `androidx.dynamicanimation` `SpringForce`/`SpringAnimation` + SystemUI `BackPanel.kt` `AnimatedFloat` | 2018, 2022 |
| `back/EdgePanelParams.ts` | SystemUI `EdgePanelParams.kt` + `android.view.animation.PathInterpolator` | 2013, 2022 |
| `back/BackPanelController.ts` | SystemUI `BackPanelController.kt` + `BackPanel.kt` | 2022 |
| `pages/BackPanel.ets` | SystemUI `BackPanel.kt` (`onDraw`) | 2022 |
| `recognizer/SwipeRecognizer.ts` | Launcher3 Quickstep `OtherActivityInputConsumer.java` + `AbsSwipeUpHandler.java` | 2018 |
| `recognizer/MotionPauseDetector.ts` | Launcher3 Quickstep `MotionPauseDetector.java` | 2019 |

AOSP source locations:
- SystemUI: `frameworks/base/packages/SystemUI/src/com/android/systemui/navigationbar/gestural/`
- Launcher3 Quickstep: `packages/apps/Launcher3/quickstep/src/com/android/quickstep/`
- `androidx.dynamicanimation`, `android.view.animation.PathInterpolator` (Android SDK)

## Independent implementations modeled on AOSP (no AOSP source code)

These files were written independently for OpenHarmony; their design or
public API is modeled on AOSP, but they contain no copied AOSP source and
are the original work of the systemui contributor:

- `recognizer/VelocityTracker.ts` — API modeled on `android.view.VelocityTracker`; uses a weighted moving average (not AOSP's least-squares solver).
- `animation/DragController.ts` — swipe-to-Overview transform behaviour modeled on Launcher3 `SwipeUpAnimationLogic.java`; ArkUI/AppStorage implementation.
- `pages/DragOverlay.ets` — Overview surface behaviour modeled on Launcher3 Quickstep; ArkUI implementation.

## License

```
Copyright (C) The Android Open Source Project
Copyright (c) 2026 Francesco Pham

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
