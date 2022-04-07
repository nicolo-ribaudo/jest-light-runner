import { Piscina } from "piscina";
import supportsColor from "supports-color";
import { MessageChannel } from "worker_threads";
import { shouldInstrument } from "@jest/transform";
import { fileURLToPath } from "url";

/** @typedef {import("@jest/test-result").Test} Test */

export default class LightRunner {
  #config;
  #testContext;
  #piscina;

  constructor(config, testContext) {
    this.#config = config;
    this.#testContext = testContext;

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

  filterCoverage(result, projectConfig) {
    if (!result.v8Coverage) {
      return result;
    }

    const coverageOptions = {
      changedFiles: this.#testContext && this.#testContext.changedFiles,
      collectCoverage: true,
      collectCoverageFrom: this.#config.collectCoverageFrom,
      collectCoverageOnlyFrom: this.#config.collectCoverageOnlyFrom,
      coverageProvider: this.#config.coverageProvider,
      sourcesRelatedToTestsInChangedFiles:
        this.#testContext && this.#testContext.sourcesRelatedToTestsInChangedFiles,
    };

    return {
      ...result,
      v8Coverage: result.v8Coverage
        .filter(res => res.url.startsWith("file://"))
        .map(res => ({ ...res, url: fileURLToPath(res.url) }))
        .filter(
          ({ url }) =>
            // TODO: will this work on windows? It might be better if `shouldInstrument` deals with it anyways
            url.startsWith(projectConfig.rootDir) &&
            shouldInstrument(url, coverageOptions, projectConfig)
        )
        .map(result => ({ result })),
    };
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
            result =>
              void onResult(
                test,
                this.filterCoverage(result, test.context.config)
              ),
            error => void onFailure(test, error)
          );
      })
    );
  }
}
