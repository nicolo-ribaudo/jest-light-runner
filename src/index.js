import Tinypool from "tinypool";
import supportsColor from "supports-color";
import { MessageChannel } from "worker_threads";
import pMap from "p-map";

/** @typedef {import("@jest/test-result").Test} Test */

const createRunner = ({ runtime = "worker_threads" } = {}) =>
  class LightRunner {
    // TODO: Use real private fields when we drop support for Node.js v12
    _config;
    _pool;
    _isProcessRunner = runtime === "child_process";
    _runInBand = false;

    constructor(config) {
      this._config = config;

      // Jest's logic to decide when to spawn workers and when to run in the
      // main thread is quite complex:
      //  https://github.com/facebook/jest/blob/5183c1/packages/jest-core/src/testSchedulerHelper.ts#L13
      // We will only run in the main thread when `maxWorkers` is 1.
      // It's always 1 when using the `--runInBand` option.
      // This is so that the tests shares the same global context as Jest only
      // when explicitly required, to prevent them from accidentally interferring
      // with the test runner. Jest's default runner does not have this problem
      // because it isolates every test in a vm.Context.
      const { maxWorkers } = config;
      const runInBand = maxWorkers === 1;

      this._runInBand = runInBand;
      this._pool = new (runInBand ? InBandTinypool : Tinypool)({
        filename: new URL("./worker-runner.js", import.meta.url).href,
        runtime,
        maxThreads: maxWorkers,
        env: {
          // Workers don't have a tty; we whant them to inherit
          // the color support level from the main thread.
          FORCE_COLOR: supportsColor.stdout.level,
          ...process.env,
        },
      });
    }

    /**
     * @param {Array<Test>} tests
     * @param {*} watcher
     * @param {*} onStart
     * @param {*} onResult
     * @param {*} onFailure
     */
    runTests(tests, watcher, onStart, onResult, onFailure) {
      const { updateSnapshot, testNamePattern, maxWorkers } = this._config;

      if (!this._runInBand && this._isProcessRunner) {
        return pMap(
          tests,
          test =>
            this._pool.run({ test, updateSnapshot, testNamePattern }).then(
              result => void onResult(test, result),
              error => void onFailure(test, error),
            ),
          { concurrency: maxWorkers },
        );
      }

      return Promise.all(
        tests.map(test => {
          const mc = new MessageChannel();
          mc.port2.onmessage = () => onStart(test);
          mc.port2.unref();

          return this._pool
            .run(
              { test, updateSnapshot, testNamePattern, port: mc.port1 },
              { transferList: [mc.port1] },
            )
            .then(
              result => void onResult(test, result),
              error => void onFailure(test, error),
            );
        }),
      );
    }
  };

// Exposes an API similar to Tinypool, but it uses dynamic import()
// rather than worker_threads.
class InBandTinypool {
  _moduleP;
  _moduleDefault;

  _queue = [];
  _running = false;

  constructor({ filename }) {
    this._moduleP = import(filename);
  }

  run(data) {
    return new Promise((resolve, reject) => {
      this._queue.push({ data, resolve, reject });
      this._runQueue();
    });
  }

  async _runQueue() {
    if (this._running) return;
    this._running = true;

    try {
      if (!this._moduleDefault) {
        this._moduleDefault = (await this._moduleP).default;
      }

      while (this._queue.length > 0) {
        const { data, resolve, reject } = this._queue.shift();
        await this._moduleDefault(data).then(resolve, reject);
      }
    } finally {
      this._running = false;
    }
  }
}

export default createRunner();
export { createRunner };
