# MatrixMedia account core

These source files are copied from https://github.com/hanliang97/MatrixMedia on 2026-11-11 (main branch, package version 0.14.8).

- `core/accountPartition.js` ← `src/shared/accountPartition.js`
- `core/accountIdentity.js` ← `src/shared/accountIdentity.js`

Upstream author: hanliang97 and MatrixMedia contributors.
License: GPL-2.0-only; the complete upstream license is included in `LICENSE`.

The copied core files are unmodified. Content Studio calls them for account identity, grouping, and logical session keys. Its browser adapter maps these stable keys to independent Chrome profiles; Electron, Vue components, browser credentials, and upstream application data are not bundled here.

This directory is a source-code reuse boundary, not a claim that the complete MatrixMedia application or account UI runs inside Content Studio. Distribution must preserve and comply with the applicable upstream license.

