# AGENTS.md — working on `dsh-plugin-source-control`

Orientation for an agent (or a person) picking this repository up cold. The
[README](README.md) describes what the plugin *is*; this describes how to change it without
breaking it, and records the traps that have already cost time.

Read this file before editing anything.

---

## 1. What this is

A DeepSeek Harness **plugin package** (not a dynamic Cordis package) that ports VS Code's Source
Control views — **Changes** and **Graph** — into the DSH web client's right Sidebar, with a real
Monaco diff editor in the pane beside it.

Two halves, bundled separately, talking over one private HTTP surface:

```
  Browser (right Sidebar)                       Node (the DSH process)
  ────────────────────────                      ───────────────────────
  SourceControlBody.tsx   ─┐                    ┌─ index.ts      plugin entry + config
  GraphSection.tsx         ├─ fetch() ────────► │─ host/api.ts   the routes
  DiffBody.tsx            ─┘  /source-control   │─ host/git.ts   git via ctx.subprocess
                                ▲              │─ host/status.ts, history.ts, diff.ts, actions.ts
                                └──────────────┘
```

**The browser half never touches the repository.** Every read and write is a JSON call to the host
half, which runs git through `ctx.subprocess` with argv arrays — nothing is ever quoted into a shell.
Keep it that way; it is the only reason paths with spaces or non-ASCII work.

### File map

| Path | Responsibility |
|---|---|
| `src/index.ts` | Host plugin: Schemastery `Config`, registers the HTTP surface |
| `src/host/api.ts` | Routes: `/api/status`, `/api/diff`, `/api/action`, `/api/history`, `/api/commit`, `/monaco/editor.worker.js` |
| `src/host/git.ts` | The git runner (argv, exit codes, `findRepositoryRoot`) |
| `src/host/status.ts` | `git status --porcelain=v1 -z` parsing and group assembly |
| `src/host/history.ts` | `git log` / `git show --name-status` parsing |
| `src/host/diff.ts` | Which two revisions a comparison uses, plus language detection |
| `src/host/actions.ts` | stage / unstage / discard / commit / push / ignore |
| `src/client/index.ts` | Tab-type registration, slot seats, stylesheet, and the diff-opener |
| `src/client/SourceControlBody.tsx` | The panel: toolbar, repo row, commit box, the two sections |
| `src/client/GraphSection.tsx` | The Graph view, driving the ported renderer |
| `src/client/graph.ts` | **Ported from VS Code** — swimlane model + SVG renderer. Do not re-derive. |
| `src/client/DiffBody.tsx` | The Monaco diff pane |
| `src/client/monaco.ts` | Monaco, the Harness-derived theme, worker wiring |
| `src/client/scm.css` | All styling, including the ported graph rules |
| `src/shared/protocol.ts`, `routes.ts` | The wire contract both halves compile against |
| `build.mjs` | esbuild: host bundle, client bundle + envelope, Monaco worker |
| `tests/graph.test.mjs` | Swimlane-model tests |
| `tools/drive.mjs` | CDP browser-verification harness (§5) |

---

## 2. Commands

```sh
pnpm install          # also runs the build (the `prepare` script)
pnpm build            # lib/index.js, lib/client.js, lib/monaco-editor.worker.js
pnpm typecheck        # tsc --noEmit; must stay clean
pnpm test             # swimlane-model tests
```

Install into a profile and activate:

```sh
dsh plugin --profile web add link:$PWD
dsh --profile web --dump-config | grep -A4 source-control   # the row must be composed
dsh --profile web                                            # restart; the Host half loads at boot
```

A **bundle plugin takes effect at startup**, so a Host-half change needs a server restart. Client-only
changes reach a reloaded page through the client-module HMR revision.

---

## 3. Architecture rules that are not optional

### The client bundle envelope

`build.mjs` wraps the browser bundle in the client module system's envelope:

```js
window.__ModuleLoader__.load({ id: 'dsh-plugin-source-control', factory: (require) => { … } })
```

The factory receives `require`, which resolves **platform modules only** — `react` and
`react/jsx-runtime` are externalised for exactly this reason. There is no npm resolution inside the
bundle: anything else you import is inlined by esbuild. The bundled stylesheet is embedded in the same
file and installed through `__dshInstallStyles`, which the wrapper declares and `src/client/index.ts`
calls from an effect so the styles leave with the plugin.

### `dsh.client` and `exports["./client"]`

`package.json#dsh.client` (with `platform: 'web'`) plus `exports["./client"]` are how the Host finds
the browser half. Both must keep pointing at `lib/client.js`. `dsh.bundle.patch` points at
`cordis.patch.yml`, which is what puts the row in the profile's bundle stack.

### Registration is an effect

Every contribution goes through `ctx.effect(() => …)` and returns the disposer: tab types, slot seats,
the stylesheet, the HTTP routes. Nothing is torn down by hand.

---

## 4. Traps that have already bitten

Each of these was a real failure, not a hypothetical.

### `slots.register`'s `inject` is a **factory**, not an object

```ts
// WRONG — throws "inject is not a function" when the slot renders
ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID, inject: { openDiff } }, Body)

// RIGHT — the runtime calls it with (sessionId, actions)
ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID, inject: () => ({ openDiff }) }, Body)
```

The type in `src/client/index.ts` says so; the shipped `dsh-client-ui-sidebar-files` is the reference.

### A throw while unmounting a body takes the whole column down

A cleanup that throws during React's unmount commit escapes the component, reaches the slot runtime,
and kills **every** tab body in `rightbar.session` — the sidebar goes blank and stays blank until a
reload. This is how the "second file click crashes the sidebar" bug happened: the editor effect's
cleanup disposed the editor, then a later effect's cleanup called `editor.setModel(null)` on it.

Two rules follow, and both are load-bearing:

1. **One effect owns the editor and everything it holds.** It creates and disposes the editor *and* the
   text models, in that order, in its own cleanup. Do not put model disposal in a second effect —
   React runs cleanups in declaration order, so the editor would be disposed first.
2. **Every teardown step goes through `release()`** (`DiffBody.tsx`), which logs instead of throwing. A
   viewer is never entitled to take the host UI down.

### One diff address, re-navigated — not one per file

`DIFF_ADDRESS` in `src/shared/routes.ts` is a single constant. Opening an address that is already open
re-navigates that tab with the new params instead of minting another. That is what makes a second file
click re-point the diff in place, and it is also what keeps the unmount path out of the common case.

If you ever make the address per-file, you reintroduce a tab-per-file pile-up and unmount a `DiffBody`
on every click.

### Monaco needs its worker from the plugin's own route

`monaco.ts` sets `MonacoEnvironment.getWorkerUrl` to `/source-control/monaco/editor.worker.js`, which
`host/api.ts` serves from `lib/monaco-editor.worker.js`. Only the editor worker exists: the bundle
imports `edcore.main` plus the basic languages, deliberately **not** `editor.main`, because the
TypeScript/JSON/CSS/HTML language services would each demand a worker of their own.

### git details that cost real time

- `--no-optional-locks` is a **global** git option: `git -c … --no-optional-locks status …`, not
  `git status --no-optional-locks`.
- `git log --pretty=format:` puts its own newline **after** each record, so a `%x1e`-terminated record
  arrives with a leading `\n`. Trim the record before splitting, or the first field (the hash) carries
  it and never compares equal to the parent that named it. This made every commit land in its own lane.
- Use `\x1f` between fields and `\x1e` between records rather than newlines: a commit subject may
  contain anything a person can type.
- `git show --format= --name-status -z` emits `status\0path\0` pairs; it is run with `--no-renames` so a
  rename reads as a delete plus an add, each of which opens a diff that resolves cleanly.

### `--dsw-alias-brand-primary` is a foreground colour, not a brand blue

It reads like an accent colour and it is not: the light theme resolves it to `#0f1115` and the dark
theme to `#f9fafb` — it is the theme's **text** colour, which is what "brand" means in these tokens.

The commit button filled itself with it and hardcoded `color: #fff`, so in the dark theme it drew white
on near-white: a blank pill, ~1.03:1 contrast. A filled control must take its label from the token that
is defined as the foreground *of* a fill:

```css
background: var(--dsw-alias-button-primary-fill);
color: var(--dsw-alias-label-primary-foreground);
```

That pair is what DSH's own primary buttons use (`dsh-client-ui-settings-models`), and it also brings a
real `--dsw-alias-button-primary-hover` — prefer it to `filter: brightness()`, which brightens a dark
fill and a light one in the same direction and so is wrong in one of the two themes.

The same trap applies to any `border` or divider drawn *on* a filled surface: `rgb(255 255 255 / 25%)`
vanishes in the dark theme. Mix from `--dsw-alias-label-primary-foreground` instead.

### The Graph is **ported** — change it at the source, not by reasoning

`src/client/graph.ts` is a port of `src/vs/workbench/contrib/scm/browser/scmHistory.ts` (MIT,
© Microsoft Corporation), matched to that extension's `scm.css`. When something about the graph looks
wrong, **read the VS Code source and match it**; do not re-derive the behaviour. Writing it from a prose
description is precisely how the first version got the node shapes, the lane pitch, and the background
halo wrong.

The look is split between the renderer and the stylesheet, and neither half is meaningful alone:

- `drawCircle` sets `fill` only when given a colour, and always sets `stroke-width`.
- `scm.css` strokes **every** circle in the row's background (`--dsh-scm-graph-bg`) — that is the halo
  that stops lanes running into the dot.
- The same stylesheet fills the **last** circle of a `current` / `incoming-changes` /
  `outgoing-changes` container with the background. That is the hole.

Note the class mapping: a HEAD row's container is classed **`current`**, not `HEAD` — VS Code maps the
kind, and getting this wrong silently leaves the hole black.

A known original wart, reproduced deliberately: the middle circle of an incoming/outgoing node has no
colour and no CSS fill rule, so it computes to SVG's default `fill: rgb(0,0,0)`. It is invisible on a
dark theme and a black dot on a light one. Fixing it is a one-line CSS rule — but it is a divergence
from the original, so make that call knowingly.

---

## 5. Verifying a change

Static checks cannot see either failure mode this plugin actually has: a body that throws while
unmounting, and imperative SVG whose *computed* stroke/fill is the entire visual result. Both need a
live page.

**Never verify against the user's running server or their repositories.** Start a throwaway server on
another port and drive a headless browser at it:

```powershell
# 1. A second server on a spare port; it prints a tokenised URL.
dsh --profile web --port 3099 --no-open

# 2. Headless Chrome with remote debugging.
$profile = Join-Path $env:TEMP 'dsh-scm-chrome'
Start-Process chrome -ArgumentList @(
  '--headless=new', '--remote-debugging-port=9222', "--user-data-dir=$profile",
  '--window-size=1600,1000', 'about:blank')

# 3. Drive it. The URL needs the token from step 1.
node tools/drive.mjs 'http://127.0.0.1:3099/?token=<token>' tools/steps/open-panel.mjs
```

`tools/drive.mjs` prints the step report on stdout and **every page console error and exception** on
stderr, exiting non-zero if there were any. A clean run prints no events section — treat any event as a
failure, and remember that errors can be leftovers from the page that was already open, so re-run once
before believing them.

`tools/steps/open-panel.mjs` is a worked example (it reaches a session, reveals the right Sidebar, opens
the Source Control tab, and reports the panel). Copy it for a new check. Two things it encodes:

- **Layout state is per session and memory-only.** A fresh session's right column starts collapsed, and
  the reveal control (`Open right sidebar`) lives in the conversation header's corner, which does not
  exist until a session is open. Reach a session first.
- **`.YDXeBa_*` class names are the shipped workspace sidebar's**, not this plugin's. They change if DSH
  is updated; if a check starts failing at "expand workspace", that is why.

Useful driver tricks: `click({ selector, text })` composes the two so you can pick one section header
out of several; `probe()` runs arbitrary JS and is how you read computed styles — which is the only way
to prove the graph's fill/stroke wiring.

`tools/steps/commit-button-contrast.mjs` is the second worked example, for the other kind of visual
bug: it measures the commit button's computed colour against its fill in **both** colour schemes. The
dark theme is selected by nothing but `document.body`'s `data-ds-dark-theme` attribute, so one run can
toggle it and check both — which matters here, because a hardcoded `#fff` label is invisible in exactly
one of the two and looks perfect in the other. `driver.shot(name, clip)` takes a rect for that reason:
a whole-page screenshot cannot show whether a label is readable.

### Fixtures

For anything that writes to git, build a throwaway repository; never run mutating actions against a
workspace the user has open. `tests/graph.test.mjs` shows the pattern of bundling a client module with
esbuild and importing it in Node, which is how the swimlane model is tested without a browser.

The swimlane model is the one piece whose correctness is invisible — a wrong lane still draws
*something* — so it is covered by `pnpm test` against linear, merged, diverged, in-step and empty
histories.

**When a test fails, check the expectation against the VS Code source before touching the
implementation.** Three of the original cases failed against correct code because the expectations were
guessed; the port was right each time.

---

## 6. Definition of done

1. `pnpm typecheck` clean.
2. `pnpm test` clean.
3. `pnpm build` clean.
4. `dsh --profile web --dump-config` still composes the `source-control` row.
5. A browser run against a throwaway server with **no page events**, exercising whatever you changed —
   plus a screenshot for anything visual.
6. The verification server and Chrome are stopped, and any fixture repository is removed.

Referenced screenshots live in `docs/` and are updated from real runs.

---

## 7. Known gaps and likely next steps

- **Read and change, not manage.** No blame, stashes, branches/remotes/tags UI, multi-file diff editor,
  or paging past the newest 150 commits.
- **Renames read as two rows** in a commit's file list, because the host passes `--no-renames`.
- **One repository per session**, resolved from the session's working directory.
- **List view only** — VS Code's tree view, sort keys and file-icon themes are not implemented.
- **No file watching**: the Changes view polls every four seconds while visible; the Graph is read on
  mount, on demand, and after every write.
- **`Incoming Changes` depends on the upstream being loaded.** The host names the upstream as a second
  `git log` starting point when the branch is behind, so the merge-base lane can take the remote colour.
  If the upstream ref is missing, the row is suppressed exactly as VS Code suppresses it — this is a
  behaviour, not a bug.
- **Dynamic Cordis packages cannot do any of this.** They have no npm resolution and their client
  service allow-list excludes `sidebarRightTabs`/`sidebarRight`, so the right Sidebar's tab registry is
  unreachable from one. This had to be a real plugin package.
