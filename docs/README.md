# Clementine documentation

The root [README](../README.md) is the canonical product overview. This directory contains deeper architecture notes, research, roadmaps, and point-in-time design records for contributors.

Design documents describe the repository at the time they were written. They are useful context, but they are not product promises and may lag the implementation. Source code, tests, current configuration examples, and release notes remain authoritative.

## Start here

- [Product overview and installation](../README.md)
- [Contributing](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md)
- [Plugin authoring guide](guides/plugins.md)
- [Development and testing guide](development/testing.md)
- [Desktop release guide](guides/desktop-releases.md)

## Architecture and reliability

- [Agent system design](agent-system-design.md)
- [Reliability and trust gates](reliability-trust-gate.md)
- [Outcome model](outcome-v2.md)
- [Memory source landscape](source-map-landscape-memory.md)
- [Harness audit](harness-audit.md)

## Conversation and continuity design

- [Conversational autonomy](conversational-autonomy-build.md)
- [Plan continuity](plan-continuity-build.md)
- [North-star unification](north-star-unification.md)

## Research and proposals

- [iOS app roadmap](roadmap-ios-app.md)
- [Composio reliability slice](plans/composio-reliability-slice.md)

## Documentation standard

When changing behavior, update the narrowest authoritative document in the same pull request:

- product capability, install, platform, or privacy changes → root `README.md`;
- vulnerability reporting or security-boundary changes → `SECURITY.md`;
- development workflow changes → `CONTRIBUTING.md` or `docs/development/testing.md`;
- architectural decisions → a focused document here with its status and date;
- configuration changes → `.env.example` plus the relevant user-facing guide.

Never include live credentials, customer data, meeting content, personal memory, or unredacted screenshots in documentation.
