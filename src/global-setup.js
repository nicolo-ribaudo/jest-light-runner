/* eslint-disable import/extensions */

import mock from "jest-mock";
import { jestExpect as expect } from "@jest/expect";
import { ModernFakeTimers } from "@jest/fake-timers";
import * as circus from "jest-circus";

const jestMock = new mock.ModuleMocker(globalThis);
const jestTimer = new ModernFakeTimers({
  config: {
    fakeTimers: {
      enableGlobally: true,
    },
  },
  global: globalThis,
});

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
globalThis.jest = {
  fn: jestMock.fn.bind(jestMock),
  spyOn: jestMock.spyOn.bind(jestMock),
  clearAllMocks: jestMock.clearAllMocks.bind(jestMock),
  resetAllMocks: jestMock.resetAllMocks.bind(jestMock),
  restoreAllMocks: jestMock.restoreAllMocks.bind(jestMock),
  useFakeTimers() {
    jestTimer.useFakeTimers();
    return this;
  },
  setSystemTime(time) {
    jestTimer.setSystemTime(time);
    return this;
  },
  advanceTimersByTime(ms) {
    jestTimer.advanceTimersByTime(ms);
    return this;
  },
  useRealTimers() {
    jestTimer.useRealTimers();
    return this;
  },
};
