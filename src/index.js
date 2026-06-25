import Tinypool from "tinypool";
import supportsColor from "supports-color";
import pLimit from "p-limit";

/** @typedef {import("@jest/test-result").Test} Test */
/** @typedef {"main_thread" | "worker_threads" | "child_process"} Runtime */

const createRunner = runnerOptions =>
  class LightRunner {
    #globalConfig;
    #testRunners = new Map();
    #runtime;

    constructor(globalConfig, context, runnerConfiguration) {
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
      const runtime = runInBand
        ? "main_thread"
        : (runnerOptions?.runtime ??
          runnerConfiguration?.runtime ??
          "worker_threads");

      this.#globalConfig = globalConfig;
      this.#runtime = runtime;
    }

    /**
     * @param {Array<Test>} tests
     * @param {*} watcher
     * @param {*} onStart
     * @param {*} onResult
     * @param {*} onFailure
     */
    async runTests(tests, watcher, onStart, onResult, onFailure) {
      const runtime = this.#runtime;
      const globalConfig = this.#globalConfig;
      const mutex = pLimit(globalConfig.maxWorkers);

      await Promise.all(
        tests.map(test =>
          mutex(() =>
            onStart(test)
              .then(() => this.#runTest(test))
              .then(result => onResult(test, result))
              .catch(error => onFailure(test, error)),
          ),
        ),
      );

      const runners = this.#testRunners;
      for (const [, { pool }] of runners) {
        if (runtime === "child_process") {
          for (const { process } of pool.threads) {
            killSubprocessUntilDisconnected(process);
          }
        }
      }

      runners.clear();
    }

    #runTest(test) {
      const runners = this.#testRunners;
      const projectConfig = test.context.config;
      if (!runners.has(projectConfig)) {
        const runtime = this.#runtime;
        const globalConfig = this.#globalConfig;
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
  #moduleP;
  #worker;
  #workerData;

  constructor({ filename, workerData }) {
    this.#moduleP = import(filename);
    this.#workerData = workerData;
  }

  async run(data) {
    if (!this.#worker) {
      const module = await this.#moduleP;

      module.setWorkerData(this.#workerData);

      this.#worker = module;
    }

    return this.#worker.default(data);
  }

  destroy() {
    this.#worker?.cleanup();
  }
}

function killSubprocessUntilDisconnected(process) {
  // Use `process.disconnect()` instead of `process.kill()`, so we can collect coverage
  // See https://github.com/nicolo-ribaudo/jest-light-runner/issues/90#issuecomment-2812473389
  // Only call disconnect once https://github.com/tinylibs/tinypool/blob/abc247f85cba0309e3f1e5655db1837a2a1c2483/src/runtime/process-worker.ts#L61
  const originalKill = process.kill;
  let disconnectPromise;
  process.kill = signal => {
    if (!disconnectPromise) {
      disconnectPromise = new Promise((resolve, reject) => {
        process.once("disconnect", resolve);
      });
      disconnectPromise.then(() => {
        process.kill = originalKill;
      });
      process.disconnect();
    }

    disconnectPromise.then(() => {
      originalKill.call(process, signal);
    });

    return true;
  };
}

export default createRunner();
export { createRunner };
