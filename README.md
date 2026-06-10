# listam-packages

Shared, versioned npm packages for the [Listam](https://listam.ch) multi-app
architecture. The mobile, desktop, and headless apps all consume these from
the npm registry under the [`@listam`](https://www.npmjs.com/org/listam) org.

| Package | What it is |
| --- | --- |
| [`@listam/protocol`](packages/protocol) | RPC command / event numbers shared by every client and the backend |
| [`@listam/domain`](packages/domain) | Domain types, the id-keyed list reduction, and item identity |
| [`@listam/logging`](packages/logging) | Append-only log format and redaction rules |
| [`@listam/secrets`](packages/secrets) | Secret-name registry, secure-store contracts, and the file secret store |
| [`@listam/grocery`](packages/grocery) | Grocery category, translation, and grouping intelligence |
| [`@listam/i18n`](packages/i18n) | Typed UI message catalogs, locale resolution, and formatting helpers |
| [`@listam/owner-control`](packages/owner-control) | The authenticated-capability owner-control protocol (signed envelopes, pairing, registry) |
| [`@listam/client`](packages/client) | Transport-agnostic backend client contract + the in-process channel |
| [`@listam/backend`](packages/backend) | The Bare-compatible Autobase/Corestore/Hyperswarm backend, platform-portable |

## Dependency layering

```
protocol  domain  logging  secrets  grocery  i18n  owner-control   (leaves)
   │                                                    │
client ─┘                                               │
backend ── domain, logging, protocol, secrets, owner-control
```

Publish leaves first, then `client`, then `backend`.

## Develop

```sh
npm install      # links the workspace
npm test         # runs every package's node:test suite
```

## Publish

Publishing requires an npm token for the `@listam` org in a local `.npmrc`
(gitignored). Packages publish `--access public` in dependency order:

```sh
npm run publish:all
```
