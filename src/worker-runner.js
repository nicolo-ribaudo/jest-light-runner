import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { performance } from "perf_hooks";
import snapshot from "jest-snapshot";
import expect from "expect";
import * as circus from "jest-circus";
import { inspect } from "util";
import { isWorkerThread } from "piscina";

import "./global-setup.js";

/** @typedef {{ failures: number, passes: number, pending: number, start: number, end: number }} Stats */
/** @typedef {{ ancestors: string[], title: string, duration: number, errors: Error[], skipped: boolean }} InternalTestResult */

// Node.js workers (worker_threads) don't support
// process.chdir, that we use multiple times in our tests.
// We can "polyfill" it for process.cwd() usage, but it
// won't affect path.* and fs.* functions.
if (isWorkerThread) {
  const startCwd = process.cwd();
  let cwd = startCwd;
  process.cwd = () => cwd;
  process.chdir = dir => {
    cwd = path.resolve(cwd, dir);
  };
}

export default async function ({
  test,
  updateSnapshot,
  testNamePattern,
  port,
}) {
  port.postMessage("start");

  const { setupFiles, snapshotSerializers } = test.context.config;

  // https://github.com/facebook/jest/issues/11038
  for (const setupFile of setupFiles) {
    const { default: setup } = await import(pathToFileURL(setupFile));

    if (typeof setup === "function") {
      await setup();
    }
  }

  for (const snapshotSerializer of [...snapshotSerializers].reverse()) {
    const { default: serializer } = await import(
      pathToFileURL(snapshotSerializer)
    );
    snapshot.addSerializer(serializer);
  }

  const testNamePatternRE =
    testNamePattern != null ? new RegExp(testNamePattern, "i") : null;

  /** @type {Stats} */
  const stats = { passes: 0, failures: 0, pending: 0, start: 0, end: 0 };
  /** @type {Array<InternalTestResult>} */
  const results = [];

  const { tests, hasFocusedTests } = await loadTests(test.path);

  const snapshotState = new snapshot.SnapshotState(
    `${path.dirname(test.path)}/__snapshots__/${path.basename(test.path)}.snap`,
    { prettierPath: "prettier", updateSnapshot }
  );
  expect.setState({ snapshotState });

  stats.start = performance.now();
  await runTestBlock(tests, hasFocusedTests, testNamePatternRE, results, stats);
  stats.end = performance.now();

  snapshotState._inlineSnapshots.forEach(({ frame }) => {
    // When using native ESM, errors have a URL location.
    // Jest expects paths.
    frame.file = fileURLToPath(frame.file);
  });
  snapshotState.save();

  return toTestResult(stats, results, test);
}

async function loadTests(testFile) {
  circus.resetState();
  await import(pathToFileURL(testFile));
  const { rootDescribeBlock, hasFocusedTests } = circus.getState();
  return { tests: rootDescribeBlock, hasFocusedTests };
}

async function runTestBlock(
  block,
  hasFocusedTests,
  testNamePatternRE,
  results,
  stats,
  ancestors = []
) {
  await runHooks("beforeAll", block, results, stats, ancestors);

  for (const child of block.children) {
    const { type, mode, fn, name } = child;
    const nextAncestors = ancestors.concat(name);

    if (
      mode === "skip" ||
      (hasFocusedTests && type === "test" && mode !== "only") ||
      shouldSkip(testNamePatternRE, getFullName(nextAncestors))
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
        nextAncestors
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
  await callAsync(fn).catch(error => {
    errors.push(error);
  });

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
  results.push({ ancestors, title: name, errors, skipped: false });
}

async function runHooks(hook, block, results, stats, ancestors, runInParents) {
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

  if (block.parent && runInParents) {
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
 * @param {import("@jest/test-result").Test} testInput
 * @returns {import("@jest/test-result").TestResult}
 */
function toTestResult(stats, tests, { path, context }) {
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
      slow: runtime / 1000 > context.config.slowTestThreshold,
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
    testFilePath: path,
    testResults: tests.map(test => {
      return {
        ancestorTitles: test.ancestors,
        duration: test.duration / 1000,
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

function failureToString(test) {
  return (
    test.ancestors.concat(test.title).join(" > ") +
    "\n" +
    test.errors.map(error => inspect(error).replace(/^/gm, "    ")).join("\n") +
    "\n"
  );
}
