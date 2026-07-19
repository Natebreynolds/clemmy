# Security policy

Clementine is a local-first agent that can read files, invoke tools, connect to external services, and act with a user's authority. Security reports are taken seriously, especially when they involve authentication, secret handling, approval bypasses, local API access, meeting capture, or unintended data disclosure.

## Supported versions

Security fixes target the latest published release and the current `main` branch. Older releases may not receive backports. Before reporting, reproduce against the latest release when it is safe to do so.

## Report a vulnerability privately

Do **not** open a public issue, discussion, pull request, or social-media post for a suspected vulnerability.

Use GitHub's private vulnerability reporting form:

**[Open a private security advisory](https://github.com/Natebreynolds/clemmy/security/advisories/new)**

Include only the information needed to reproduce and assess the issue:

- affected version, commit, and platform;
- relevant configuration with all credentials and personal data removed;
- a clear impact statement;
- minimal reproduction steps or a small proof of concept;
- whether the issue appears to be actively exploited;
- any suggested remediation, if known.

Never include live API keys, OAuth tokens, meeting content, client data, or a copy of a user's `~/.clementine-next/` directory. Use synthetic fixtures and redact logs before attaching them.

## Coordinated disclosure

Please allow maintainers time to investigate and prepare a fix before publishing details. The project does not promise a fixed response SLA, but private reports will be triaged according to severity, exploitability, and affected users. Maintainers may ask for clarification, coordinate a release, and credit reporters who want to be acknowledged.

If you discover an exposed credential, revoke or rotate it with the issuing provider immediately. Do not test whether someone else's credential still works.

## Security boundaries to understand

- Clementine's canonical file credential vault is plaintext JSON. On macOS and other POSIX systems, Clementine writes it with owner-only `0600` permissions. On Windows, it lives in per-user app state and relies on the operating-system profile and ACL boundary. It is not encrypted at rest.
- The default daemon HTTP listener is loopback-only. Deliberately binding it to a non-loopback interface changes the threat model.
- Full-disk encryption and operating-system account security protect local Clementine data from offline access.
- Model providers and enabled integrations receive the data needed for requested work.
- Recall-based meeting capture uploads media and transcript data to Recall under the selected retention policy.
- Approval policies reduce accidental or unauthorized side effects; they are not a sandbox for hostile code.
- Installed skills, plugins, MCP servers, and scripts are code or instructions from their publisher. Review their source and permissions before enabling them.

## Good-faith research

Use accounts, devices, integrations, and data you own or have explicit permission to test. Avoid privacy violations, persistence, destructive actions, denial of service, supply-chain publication, and access to other users' data. Stop testing and report privately if you encounter real personal information or credentials.

Third-party service vulnerabilities should also be reported to the affected provider. If Clementine's integration makes the issue exploitable or worsens its impact, report it here as well.
