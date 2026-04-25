Problem: src/index.js uses pseudo-private fields (_foo) with a TODO comment saying to use real private fields when Node.js v12 is dropped. The package.json now requires node ^16.10.0 || ^18.12.0 || >=20.0.0, so v12 is long gone.
Fix: Replace _globalConfig, _testRunners, _runtime in LightRunner and _moduleP, _worker, _workerData in MainThreadTinypool with ES2022 real private fields (#foo).
Test: n/a — typo-class change, no test runner produces meaningful signal here.
