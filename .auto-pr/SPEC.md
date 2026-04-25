Problem: README links to Node.js v17.x docs (https://nodejs.org/docs/latest-v17.x/api/cli.html#node_optionsoptions) but the package requires Node.js ^16.10.0 || ^18.12.0 || >=20.0.0, making v17.x irrelevant and confusing.
Fix: Replace the v17.x-pinned URL with the version-agnostic https://nodejs.org/api/cli.html#node_optionsoptions link.
Test: Verify README.md contains the updated URL and no longer references v17.x.
