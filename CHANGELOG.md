# Changelog

## 0.1.1 (2026-09-23)

- Correct the installation instructions: save the plugin file in Amp's project or system plugin directory. `amp plugins add` does not accept GitHub raw-file URLs.

## 0.1.0 (2026-09-23)

- Add owner-only secret entry after a required human confirmation of scope, account context, and destination.
- Validate names and explicit project/app targets; send single-line values to `amp secrets set` on stdin.
- Discard CLI output and terminate commands and their process groups on timeout or unload on POSIX hosts.
