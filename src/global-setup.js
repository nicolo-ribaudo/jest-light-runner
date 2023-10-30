/* eslint-disable import/extensions */

import { ModuleMocker } from "jest-mock";
import { jestExpect as expect } from "@jest/expect";
import { ModernFakeTimers } from "@jest/fake-timers";
import * as circus from "jest-circus";

const jestMock = new ModuleMocker(globalThis);
const jestTimer = new ModernFakeTimers({
  config: {
    fakeTimers: {
      enableGlobally: true,
    },
  },
  global: globalThis,
});

const jest = {
  fn: jestMock.fn.bind(jestMock),
  spyOn: jestMock.spyOn.bind(jestMock),
  clearAllMocks: jestMock.clearAllMocks.bind(jestMock),
  resetAllMocks: jestMock.resetAllMocks.bind(jestMock),
  restoreAllMocks: jestMock.restoreAllMocks.bind(jestMock),
  useFakeTimers() {
    jestTimer.useFakeTimers();
    return jest;
  },
  setSystemTime(time) {
    jestTimer.setSystemTime(time);
    return jest;
  },
  advanceTimersByTime(ms) {
    jestTimer.advanceTimersByTime(ms);
    return jest;
  },
  useRealTimers() {
    jestTimer.useRealTimers();
    return jest;
  },
};

globalThis.expect = expect;
globalThis.test = circus.test;
globalThis.it = circus.it;
globalThis.xit = globalThis.xtest = circus.test.skip;
globalThis.fit = circus.test.only;
globalThis.describe = circus.describe;
globalThis.xdescribe = circus.describe.skip;
globalThis.fdescribe = circus.describe.only;
globalThis.beforeAll = circus.beforeAll;
globalThis.afterAll = circus.afterAll;
globalThis.beforeEach = circus.beforeEach;
globalThis.afterEach = circus.afterEach;
globalThis.jest = jest;
