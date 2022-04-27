/* eslint-disable import/extensions */

import mock from "jest-mock";
import { expect } from "expect";
import snapshot from "jest-snapshot";
import * as circus from "jest-circus";

expect.extend({
  toMatchInlineSnapshot: snapshot.toMatchInlineSnapshot,
  toMatchSnapshot: snapshot.toMatchSnapshot,
  toThrowErrorMatchingInlineSnapshot:
    snapshot.toThrowErrorMatchingInlineSnapshot,
  toThrowErrorMatchingSnapshot: snapshot.toThrowErrorMatchingSnapshot,
});
expect.addSnapshotSerializer = snapshot.addSerializer;

const jestMock = new mock.ModuleMocker(globalThis);

globalThis.expect = expect;
globalThis.test = circus.test;
globalThis.it = circus.it;
globalThis.describe = circus.describe;
globalThis.beforeAll = circus.beforeAll;
globalThis.afterAll = circus.afterAll;
globalThis.beforeEach = circus.beforeEach;
globalThis.afterEach = circus.afterEach;
globalThis.jest = {
  fn: jestMock.fn.bind(jestMock),
  spyOn: jestMock.spyOn.bind(jestMock),
  clearAllMocks: jestMock.clearAllMocks.bind(jestMock),
  resetAllMocks: jestMock.resetAllMocks.bind(jestMock),
};
