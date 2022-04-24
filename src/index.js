import { Piscina } from "piscina";
import supportsColor from "supports-color";
import { MessageChannel } from "worker_threads";

/** @typedef {import("@jest/test-result").Test} Test */

export default class LightRunner {
  #config;
  #piscina;

  constructor(config) {
    this.#config = config;

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

    this.#piscina = new (runInBand ? InBandPiscina : Piscina)({
      filename: new URL("./worker-runner.js", import.meta.url).href,
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
    const { updateSnapshot, testNamePattern } = this.#config;

    return Promise.all(
      tests.map(test => {
        const mc = new MessageChannel();
        mc.port2.onmessage = () => onStart(test);
        mc.port2.unref();

        return this.#piscina
          .run(
            { test, updateSnapshot, testNamePattern, port: mc.port1 },
            { transferList: [mc.port1] }
          )
          .then(
            result => void onResult(test, result),
            error => void onFailure(test, error)
          );
      })
    );
  }
}

// Exposes an API similar to Piscina, but it uses dynamic import()
// rather than worker_threads.
class InBandPiscina {
  #moduleP;
  #moduleDefault;

  #queue = [];
  #running = false;

  constructor({ filename }) {
    this.#moduleP = import(filename);
  }

  run(data) {
    return new Promise((resolve, reject) => {
      this.#queue.push({ data, resolve, reject });
      this.#runQueue();
    });
  }

  async #runQueue() {
    if (this.#running) return;
    this.#running = true;

    try {
      if (!this.#moduleDefault) {
        this.#moduleDefault = (await this.#moduleP).default;
      }

      while (this.#queue.length > 0) {
        const { data, resolve, reject } = this.#queue.shift();
        await this.#moduleDefault(data).then(resolve, reject);
      }
    } finally {
      this.#running = false;
    }
  }
}
