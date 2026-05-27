/*
 * Copyright (c) 2026 Francesco Pham
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
import AbilityStage from '@ohos.app.ability.AbilityStage';
import Log from '../../../../../../../common/src/main/ets/default/Log';

const TAG = 'GestureNavigation_AbilityStage';

export default class MainAbilityStage extends AbilityStage {
  onCreate(): void {
    Log.showInfo(TAG, 'onCreate');
  }
}
