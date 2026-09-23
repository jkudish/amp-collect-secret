# Contributing

Install [Bun](https://bun.sh) and [Amp](https://ampcode.com). No API key is needed for the tests. From the repository root:

```bash
bun test
git diff --check
```

The tests create a fake `amp` executable in a temporary directory; they do not store real secrets. To check that Amp loads the plugin, run:

```bash
amp plugins exec ./collect-secret.ts session.start --data '{"thread":{"id":"T-00000000-0000-0000-0000-000000000000"}}'
```

For changes to credential handling, add a test that distinguishes the intended behavior from a plausible unsafe implementation. Keep real credentials out of tests, issues, screenshots, and pull requests. Describe user-visible changes in the changelog and update the README when behavior or limits change.
