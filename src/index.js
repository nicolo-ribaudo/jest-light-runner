import Tinypool from "tinypool";
import supportsColor from "supports-color";
import pLimit from "p-limit";

/** @typedef {import("@jest/test-result").Test} Test */
/** @typedef {"main_thread" | "worker_threads" | "child_process"} Runtime */

const createRunner = ({ runtime: preferredRuntime = "worker_threads" } = {}) =>
  class LightRunner {
    // TODO: Use real private fields when we drop support for Node.js v12
    _globalConfig;
    _testRunners = new Map();

    constructor(globalConfig) {
      // Jest's logic to decide when to spawn workers and when to run in the
      // main thread is quite complex:
      //  https://github.com/facebook/jest/blob/5183c1/packages/jest-core/src/testSchedulerHelper.ts#L13
      // We will only run in the main thread when `maxWorkers` is 1.
      // It's always 1 when using the `--runInBand` option.
      // This is so that the tests shares the same global context as Jest only
      // when explicitly required, to prevent them from accidentally interfering
      // with the test runner. Jest's default runner does not have this problem
      // because it isolates every test in a vm.Context.
      const runInBand = globalConfig.maxWorkers === 1;
      const runtime = runInBand ? "main_thread" : preferredRuntime;

      this._globalConfig = globalConfig;
      this._runtime = runtime;
    }

    /**
     * @param {Array<Test>} tests
     * @param {*} watcher
     * @param {*} onStart
     * @param {*} onResult
     * @param {*} onFailure
     */
    async runTests(tests, watcher, onStart, onResult, onFailure) {
      const { _runtime: runtime, _globalConfig: globalConfig } = this;
      const mutex = pLimit(globalConfig.maxWorkers);

      await Promise.all(
        tests.map(test =>
          mutex(() =>
            onStart(test)
              .then(() => this._runTest(test))
              .then(result => onResult(test, result))
              .catch(error => onFailure(test, error)),
          ),
        ),
      );

      const runners = this._testRunners;
      for (const [, { pool }] of runners) {
        if (runtime === "child_process") {
          for (const { process } of pool.threads) {
            // Use `process.disconnect()` instead of `process.kill()`, so we can collect coverage
            // See https://github.com/nicolo-ribaudo/jest-light-runner/issues/90#issuecomment-2812473389
            // Only override the first call https://github.com/tinylibs/tinypool/blob/dbf6d74282dd6031df8fc5c7706caef66b54070b/src/runtime/process-worker.ts#L61
            const originalKill = process.kill;
            process.kill = signal => {
              if (!signal) {
                process.disconnect();
                process.kill = originalKill;
                return;
              }
              return originalKill.call(process, signal);
            };
          }
        }

        await pool.destroy();
      }

      runners.clear();
    }

    _runTest(test) {
      const runners = this._testRunners;
      const projectConfig = test.context.config;
      if (!runners.has(projectConfig)) {
        const { _runtime: runtime, _globalConfig: globalConfig } = this;
        const { maxWorkers } = globalConfig;
        const env =
          runtime === "worker_threads"
            ? {
                // Workers don't have a tty; we want them to inherit
                // the color support level from the main thread.
                FORCE_COLOR: supportsColor.stdout.level,
                ...process.env,
              }
            : process.env;
        const workerData = { globalConfig, projectConfig, runtime };
        const pool = new (
          runtime === "main_thread" ? MainThreadTinypool : Tinypool
        )({
          filename: new URL("./worker-runner.js", import.meta.url).href,
          runtime,
          minThreads: maxWorkers,
          maxThreads: maxWorkers,
          env,
          trackUnmanagedFds: false,
          workerData,
        });

        let poolRunOption;
        if (runtime === "child_process") {
          const listeners = new Set();
          const channel = {
            onMessage(listener) {
              listeners.add(listener);
            },
            postMessage(message) {
              if (message !== "jest-light-runner-get-worker-data") {
                return;
              }

              for (const listener of listeners) {
                listener({ type: "jest-light-runner-worker-data", workerData });
                listeners.delete(listener);
              }
            },
          };
          poolRunOption = { channel };
        }

        runners.set(projectConfig, {
          pool,
          run: test => pool.run(test.path, poolRunOption),
        });
      }

      return runners.get(projectConfig).run(test);
    }
  };

// Exposes an API similar to Tinypool, but it uses dynamic import()
// rather than worker_threads.
class MainThreadTinypool {
  _moduleP;
  _worker;
  _workerData;
  _runTest;
  _initialized = false;

  constructor({ filename, workerData }) {
    this._moduleP = import(filename);
    this._workerData = workerData;
  }

  async run(data) {
    if (!this._initialized) {
      const module = await this._moduleP;

      module.setWorkerData(this._workerData);

      this._worker = module;
      this._runTest = module.default;
      this._initialized = true;
    }

    return this._runTest(data);
  }

  destroy() {
    this._worker.cleanup();
  }
}

export default createRunner();
export { createRunner };
