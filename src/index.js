import { Piscina } from "piscina";
import supportsColor from "supports-color";
import { MessageChannel } from "worker_threads";

/** @typedef {import("@jest/test-result").Test} Test */

export default class LightRunner {
  #config;
  #piscina;

  constructor(config) {
    this.#config = config;

    const { collectCoverage, coverageProvider } = this.#config;

    if (collectCoverage && coverageProvider !== "v8") {
      throw new Error("Coverage needs v8 coverage provider");
    }

    this.#piscina = new Piscina({
      filename: new URL("./worker-runner.js", import.meta.url).href,
      maxThreads: this.#config.maxWorkers,
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
    const { updateSnapshot, testNamePattern, collectCoverage } = this.#config;

    return Promise.all(
      tests.map(test => {
        const mc = new MessageChannel();
        mc.port2.onmessage = () => onStart(test);
        mc.port2.unref();

        return this.#piscina
          .run(
            {
              test,
              updateSnapshot,
              testNamePattern,
              port: mc.port1,
              collectCoverage,
            },
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
