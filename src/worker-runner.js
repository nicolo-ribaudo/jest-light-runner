import path from "path";
import { pathToFileURL } from "url";
import { performance } from "perf_hooks";
import * as snapshot from "jest-snapshot";
import { jestExpect as expect } from "@jest/expect";
import * as circus from "jest-circus";
import Tinypool, { workerId } from "tinypool";

/** @typedef {{ failures: number, passes: number, pending: number, start: number, end: number }} Stats */
/** @typedef {{ ancestors: string[], title: string, duration: number, errors: Error[], skipped: boolean }} InternalTestResult */

let workerData = Tinypool.workerData;
let projectState;

async function initialSetup() {
  if (!workerData && process.__tinypool_state__?.isChildProcess) {
    workerData = await new Promise(resolve => {
      const listener = message => {
        if (message?.type === "jest-light-runner-worker-data") {
          process.off("message", listener);
          resolve(message.workerData);
        }
      };
      process.on("message", listener);
      process.send("jest-light-runner-get-worker-data");
    });
  }

  const { globalConfig, projectConfig, runtime } = workerData;

  const originalDirectory = process.cwd();

  let state = {
    globalConfig,
    projectConfig,
    runtime,
    JEST_WORKER_ID: process.env.JEST_WORKER_ID,
    originalDirectory: originalDirectory,
    originalCwd: process.cwd,
    originalChdir: process.chdir,
  };

  // Setup `JEST_WORKER_ID` environment variable
  // https://jestjs.io/docs/environment-variables
  process.env.JEST_WORKER_ID = workerId || 1;

  // Node.js workers (worker_threads) don't support
  // process.chdir, that we use multiple times in our tests.
  // We can "polyfill" it for process.cwd() usage, but it
  // won't affect path.* and fs.* functions.
  if (runtime === "worker_threads") {
    let current = originalDirectory;
    process.cwd = () => current;
    process.chdir = directory => {
      current = path.resolve(current, directory);
    };
  }

  for (const setupFile of projectConfig.setupFiles) {
    const { default: setup } = await import(pathToFileURL(setupFile));
    // https://github.com/facebook/jest/issues/11038
    if (typeof setup === "function") await setup();
  }

  await import("./global-setup.js");

  for (const snapshotSerializer of projectConfig.snapshotSerializers
    .slice()
    .reverse()) {
    const { default: serializer } = await import(
      pathToFileURL(snapshotSerializer)
    );
    snapshot.addSerializer(serializer);
  }

  for (const setupFile of projectConfig.setupFilesAfterEnv) {
    const { default: setup } = await import(pathToFileURL(setupFile));
    if (typeof setup === "function") await setup();
  }

  state.projectSnapshotSerializers = snapshot.getSerializers().slice();
  state.snapshotResolver = await snapshot.buildSnapshotResolver(projectConfig);
  state.testNamePattern =
    globalConfig.testNamePattern !== null
      ? new RegExp(globalConfig.testNamePattern, "i")
      : null;

  return state;
}

export default async function run(testFilePath) {
  if (!projectState) {
    projectState = await initialSetup();
  }

  const {
    globalConfig,
    projectConfig,
    projectSnapshotSerializers,
    snapshotResolver,
    testNamePattern,
  } = projectState;

  /** @type {Stats} */
  const stats = { passes: 0, failures: 0, pending: 0, start: 0, end: 0 };
  /** @type {Array<InternalTestResult>} */
  const results = [];
  const { tests, hasFocusedTests } = await loadTests(testFilePath);
  const snapshotState = new snapshot.SnapshotState(
    snapshotResolver.resolveSnapshotPath(testFilePath),
    {
      prettierPath: "prettier",
      updateSnapshot: projectConfig.updateSnapshot,
      snapshotFormat: projectConfig.snapshotFormat,
    },
  );
  expect.setState({ snapshotState, testPath: testFilePath });

  stats.start = performance.now();
  await runTestBlock(tests, hasFocusedTests, testNamePattern, results, stats);
  stats.end = performance.now();

  const result = addSnapshotData(
    toTestResult(stats, results, testFilePath, projectConfig),
    snapshotState,
  );

  // Restore the project-level serializers, so that serializers
  // installed by one test file don't leak to other files.
  arrayReplace(snapshot.getSerializers(), projectSnapshotSerializers);

  return result;
}

async function loadTests(testFile) {
  circus.resetState();
  await import(pathToFileURL(testFile) + "?" + Date.now());
  const { rootDescribeBlock, hasFocusedTests } = circus.getState();
  return { tests: rootDescribeBlock, hasFocusedTests };
}

async function runTestBlock(
  block,
  hasFocusedTests,
  testNamePatternRE,
  results,
  stats,
  ancestors = [],
) {
  await runHooks("beforeAll", block, results, stats, ancestors);

  for (const child of block.children) {
    const { type, mode, fn, name } = child;
    const nextAncestors = ancestors.concat(name);

    if (
      mode === "skip" ||
      (type === "test" &&
        ((hasFocusedTests && mode !== "only") ||
          shouldSkip(testNamePatternRE, getFullName(nextAncestors))))
    ) {
      stats.pending++;
      results.push({ ancestors, title: name, errors: [], skipped: true });
    } else if (type === "describeBlock") {
      await runTestBlock(
        child,
        hasFocusedTests,
        testNamePatternRE,
        results,
        stats,
        nextAncestors,
      );
    } else if (type === "test") {
      await runHooks("beforeEach", block, results, stats, nextAncestors, true);
      await runTest(fn, stats, results, ancestors, name);
      await runHooks("afterEach", block, results, stats, nextAncestors, true);
    }
  }

  await runHooks("afterAll", block, results, stats, ancestors);

  return results;
}

function shouldSkip(testNamePatternRE, testName) {
  return testNamePatternRE && !testNamePatternRE.test(testName);
}

/**
 * @param {string[]} pieces
 */
function getFullName(pieces) {
  return pieces.join(" ");
}

/**
 * @param {Function} fn
 * @param {Stats} stats
 * @param {Array<InternalTestResult>} results
 * @param {string[]} ancestors
 * @param {string} name
 */
async function runTest(fn, stats, results, ancestors, name) {
  expect.setState({
    suppressedErrors: [],
    currentTestName: getFullName(ancestors.concat(name)),
  });

  const errors = [];
  const start = performance.now();
  await callAsync(fn).catch(error => {
    errors.push(error);
  });
  const end = performance.now();

  // Get suppressed errors from ``jest-matchers`` that weren't thrown during
  // test execution and add them to the test result, potentially failing
  // a passing test.
  const { suppressedErrors } = expect.getState();
  expect.setState({ suppressedErrors: [] });
  if (suppressedErrors.length > 0) {
    errors.unshift(...suppressedErrors);
  }

  if (errors.length > 0) {
    stats.failures++;
  } else {
    stats.passes++;
  }
  results.push({
    ancestors,
    title: name,
    duration: end - start,
    errors,
    skipped: false,
  });
}

async function runHooks(hook, block, results, stats, ancestors, runInParents) {
  if (hook.startsWith("before") && block.parent && runInParents) {
    await runHooks(hook, block.parent, results, stats, ancestors, true);
  }

  for (const { type, fn } of block.hooks) {
    if (type === hook) {
      await callAsync(fn).catch(error => {
        stats.failures++;
        results.push({
          ancestors,
          title: `(${hook})`,
          errors: [error],
          skipped: false,
        });
      });
    }
  }

  if (hook.startsWith("after") && block.parent && runInParents) {
    await runHooks(hook, block.parent, results, stats, ancestors, true);
  }
}

function callAsync(fn) {
  if (fn.length >= 1) {
    return new Promise((resolve, reject) => {
      fn((err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
  } else {
    return Promise.resolve().then(fn);
  }
}

/**
 *
 * @param {Stats} stats
 * @param {Array<InternalTestResult>} tests
 * @param {string} testFilePath
 * @param {import("@jest/test-result").Test["context"]["config"]} projectConfig
 * @returns {import("@jest/test-result").TestResult}
 */
function toTestResult(stats, tests, testFilePath, projectConfig) {
  const { start, end } = stats;
  const runtime = end - start;

  return {
    coverage: globalThis.__coverage__,
    console: null,
    failureMessage: tests
      .filter(t => t.errors.length > 0)
      .map(failureToString)
      .join("\n"),
    numFailingTests: stats.failures,
    numPassingTests: stats.passes,
    numPendingTests: stats.pending,
    perfStats: {
      start,
      end,
      runtime: Math.round(runtime), // ms precision
      slow: runtime / 1000 > projectConfig.slowTestThreshold,
    },
    skipped: false,
    snapshot: {
      added: 0,
      fileDeleted: false,
      matched: 0,
      unchecked: 0,
      unmatched: 0,
      updated: 0,
    },
    sourceMaps: {},
    testExecError: null,
    testFilePath,
    testResults: tests.map(test => {
      return {
        ancestorTitles: test.ancestors,
        duration: test.duration,
        failureMessages: test.errors.length ? [failureToString(test)] : [],
        fullName: test.title,
        numPassingAsserts: test.errors.length > 0 ? 1 : 0,
        status: test.skipped
          ? "pending"
          : test.errors.length > 0
            ? "failed"
            : "passed",
        title: test.title,
      };
    }),
  };
}

// https://github.com/facebook/jest/blob/7d8d01c4854aa83e82cc11cefdd084a7d9b8bdfc/packages/jest-jasmine2/src/index.ts#L206
function addSnapshotData(results, snapshotState) {
  results.testResults.forEach(({ fullName, status }) => {
    if (status === "pending" || status === "failed") {
      // if test is skipped or failed, we don't want to mark
      // its snapshots as obsolete.
      snapshotState.markSnapshotsAsCheckedForTest(fullName);
    }
  });

  const uncheckedCount = snapshotState.getUncheckedCount();
  const uncheckedKeys = snapshotState.getUncheckedKeys();

  if (uncheckedCount) {
    snapshotState.removeUncheckedKeys();
  }

  const status = snapshotState.save();
  results.snapshot.fileDeleted = status.deleted;
  results.snapshot.added = snapshotState.added;
  results.snapshot.matched = snapshotState.matched;
  results.snapshot.unmatched = snapshotState.unmatched;
  results.snapshot.updated = snapshotState.updated;
  results.snapshot.unchecked = !status.deleted ? uncheckedCount : 0;
  // Copy the array to prevent memory leaks
  results.snapshot.uncheckedKeys = Array.from(uncheckedKeys);

  return results;
}

function failureToString(test) {
  return (
    test.ancestors.concat(test.title).join(" > ") +
    "\n" +
    test.errors
      .map(error =>
        error.stack
          .replace(/\n.*jest-light-runner.*/g, "")
          .replace(/^/gm, "    "),
      )
      .join("\n") +
    "\n"
  );
}

function arrayReplace(array, replacement) {
  array.splice(0, array.length, ...replacement);
}

// For MainThreadTinypool to set worker data
export function setWorkerData(data) {
  workerData = data;
}

// For MainThreadTinypool to cleanup
export async function cleanup() {
  const { JEST_WORKER_ID, originalDirectory, originalCwd, originalChdir } =
    projectState;

  // Restore `process.env.JEST_WORKER_ID`
  if (JEST_WORKER_ID === undefined) {
    delete process.env.JEST_WORKER_ID;
  } else {
    process.env.JEST_WORKER_ID = JEST_WORKER_ID;
  }

  const currentDirectory = process.cwd();

  if (originalDirectory !== currentDirectory) {
    process.chdir(originalDirectory);
  }

  // Restore `process.cwd`
  if (process.cwd !== originalCwd) {
    process.cwd = originalCwd;
  }

  // Restore `process.chdir`
  if (process.chdir !== originalChdir) {
    process.chdir = originalChdir;
  }

  workerData = undefined;
  projectState = undefined;
}
