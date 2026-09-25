# Changelog

## Unreleased

### Added

- Added the opt-in `habicron/cloudflare` asynchronous Durable Object runtime.
- Added durable fixed-grid sub-minute scheduling, generation fencing, stable tick IDs, hard expiry, lifecycle controls, and missed-tick skipping.
- Added official Workerd integration coverage and a complete Queue handoff example.

### Compatibility

- Existing `habicron`, `habicron/core`, Node, browser, Vue, React, and CLI imports retain their current behavior.
- Cloudflare code is loaded only through the new subpath export.
- The adapter is ready for isolated downstream evaluation. Sanna Transfer integration remains a separate future task.
