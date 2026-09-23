# Security

Report vulnerabilities privately to **joey@jkudish.com** with “Amp Collect Secret security” in the subject. Include the Amp/CLI version, operating system, installation method, reproduction steps using a dummy value, and expected versus observed behavior. Do not send a real credential or open a public issue containing one.

Only the latest released version is intended to receive fixes. There is no committed response time or bug bounty.

The owner-only dialog and transcript behavior depend on Amp. This plugin uses the executor's Amp CLI credentials to write a secret, and cannot attest that those credentials belong to the connected account shown in the dialog. Stored secrets may be injected into later agent environments. Treat those environments and their tools as authorized to access them. Process-group cleanup for CLI descendants is supported on POSIX hosts, not Windows.
