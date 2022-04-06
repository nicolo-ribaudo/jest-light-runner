# jest-light-runner

A Jest runner that runs tests directly in bare Node.js, without virtualizing the environment.

## Comparison with the default Jest runner

This approach is wasy faster than the default Jest runner (it [more than doubled](https://github.com/babel/babel/pull/13966#pullrequestreview-819765720) the speed of [Babel](https://github.com/babel/babel)'s tests suite) and has complete support for the Node.js ESM implementation. However, it doesn't provide support for most of Jest's advanced features.

The lists below are not comprehensive: feel free to [start a discussion](https://github.com/nicolo-ribaudo/jest-light-runner/discussions/new) regarding any other missing Jest feature!

### Supported Jest features

- Jest globals: `expect`, `test`, `it`, `describe`, `beforeAll`, `afterAll`, `beforeEach`, `afterEach`
- Jest function mocks: `jest.fn`, `jest.spyOn`
- Inline and external snapshots
- `--testNamePattern`/`-t`, to only run some specific tests
- Jest config options: `setupFiles`, `snapshotSerializers`

### Unsupported Jest features

- `import`/`require` mocks. You can use a custom mocking library such as [`esmock`](https://github.com/iambumblehead/esmock) or [`proxyquire`](https://github.com/thlorenz/proxyquire).
- On-the-fly compilation (for example, with Babel or TypeScript). You can use a Node.js module loader, such as [`ts-node/esm`](https://github.com/TypeStrong/ts-node).
- Tests isolation. Jest runs every test file in its own global environment, meaning that modification to built-ins done in one test file don't affect other test files. This is not supported, but you can use the Node.js option [`--frozen-intrinsics`](https://nodejs.org/api/cli.html#--frozen-intrinsics) to prevent such modifications.

### Partially supported features

- `process.chdir`. This runner uses Node.js workers, that don't support `process.chdir()`. It provides a simple polyfill so that `process.chdir()` calls still affect the `process.cwd()` result, but they won't affect all the other Node.js API (such as `fs.*` or `path.resolve`).

## Usage

After installing `jest` and `jest-light-runner`, add it to your Jest config.

In `package.json`:
```json
{
  "jest": {
    "runner": "jest-light-runner"
  }
}
```
or in `jest.config.js`:
```js
module.exports = {
    runner: "jest-light-runner",
};
```

### Using custom Node.js ESM loaders

You can specify custom ESM loaders using Node.js's [`--loader`](https://nodejs.org/api/cli.html#--loadermodule) option. Jest's CLI doesn't allow providing Node.js-specific options, but you can do it in two alternative ways:
1. Run Jest by explicitly running Node.js:
   ```
   node --loader ts-node/esm ./node_modules/.bin/jest
   ```
2. Use the [`NODE_OPTIONS`](https://nodejs.org/docs/latest-v17.x/api/cli.html#node_optionsoptions) environment variable:
   ```
   NODE_OPTIONS='--loader ts-node/esm' jest
   ```
   or, if you are using [`cross-env`](https://www.npmjs.com/package/cross-env) to be able to provide environment variables on multiple OSes:
   ```
   cross-env NODE_OPTIONS='--loader ts-node/esm' jest
   ```

## Stability

This project follows semver, and it's currently in the `0.x` release line.

It is used to run tests in the [`babel/babel`](https://github.com/babel/babel/) and [`prettier/prettier`](https://github.com/prettier/prettier/) repositories, but there are no internal tests for the runner itself. I would gladly accept a pull requests adding a test infrastructure!

## Donations

If you use this package and it has helped with your tests, please consider [sponsoring me on GitHub](https://github.com/sponsors/nicolo-ribaudo)! You can also donate to Jest on their [OpenCollective page](https://opencollective.com/jest).
