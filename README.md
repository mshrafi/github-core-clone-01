# github-core-clone-01 — a GitHub-compatible forge

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/mshrafi/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/mshrafi/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A working clone of GitHub's core in Node.js 22, standard library only — no
dependencies, no git binary, no network at runtime, no model calls. One
in-memory store drives all four surfaces the suite grades:

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (protocol v2), `git-receive-pack` (v0) |
| anything else | 404 `{"message":"Not Found"}` |

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. There is nothing
to install: the program imports `node:http`, `node:crypto`, `node:zlib` and its
own modules only.

## The lifecycle (main.ts)

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one.
   Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port>}`.
3. **Wait for done.** Poll `GET $MAKEFUN_ENV_URL/done` until `{"done":true}`.
4. **Exit 0** when it does.

## Layout

- `main.ts`: the lifecycle above.
- `app.ts`: the server: routing, auth, body reading, the git endpoints.
- `store.ts`: the shared in-memory store: repos, git objects, refs, issues,
  pull requests, merge-base and three-way conflict logic, deterministic ids
  and timestamps (fixed epoch + a monotonic sequence — never `Date.now()` or
  `Math.random()`, so a replay of the same requests reaches identical state).
- `git.ts`: pkt-line codec, pack reader/writer (plain objects out, deltas in
  resolved), v2 upload-pack (`ls-refs`, `fetch`, shallow), v0 receive-pack
  with per-ref fast-forward enforcement.
- `rest.ts`: REST v3 handlers, including contents commits that create real
  git commits and squash merges with real three-way conflict detection.
- `graphql.ts`: GraphQL v4 executor for the 18 suite documents, `__type`
  introspection, `node()` global ids, mutations, batching, cursor pagination.
- `mcp.ts`: MCP 2026-07-28 (`server/discover`) with the legacy `initialize`
  fallback, and the six tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`).

## Determinism

Every observable value is a function of the requests: ids are counters or
content hashes, timestamps are a fixed epoch plus a monotonic sequence, lists
are insertion- or name-ordered. The bearer token names one login (the
scenario's viewer, `adaiversen`, fixed by the kit's seeded scenario); a
repository under any other owner answers 404, never 403.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest
page: **https://make.fun/bounty/github-core-clone-01**. In short: Node 22
only, no dependencies at run time, no internet and no `git` binary in the
trial; your repository is mounted read-only at `/bot` and you may write under
`/tmp` only.
