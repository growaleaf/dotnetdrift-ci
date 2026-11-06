# dotnetdrift-ci

Fail CI when your .NET SDK version claims disagree with each other.

A project can declare its target .NET version in four different places —
`global.json`'s `sdk.version` (read by the .NET CLI muxer and the MSBuild project SDK resolver;
confirmed from learn.microsoft.com/dotnet/core/tools/global-json: it "requires the full version
number" with "no wildcard support" and "no version ranges", and the default `rollForward` policy
when unset is `patch`, an exact major/minor/feature-band pin with only patch-level flex), every
`*.csproj`'s `<TargetFramework>`/`<TargetFrameworks>` moniker (e.g. `net8.0`), a `Dockerfile`'s
`FROM mcr.microsoft.com/dotnet/sdk:X.Y`, and a GitHub Actions workflow's `dotnet-version:` — each
edited by a different person at a different time. They drift silently, and the bug that surfaces
is a build that passes locally against whatever SDK happens to be installed and then fails (or
silently multi-targets wrong) in the Docker image or CI runner, discovered during a release
window, not in review. Same shape as this lane's `nodedrift-ci` (Node.js), `pydrift-ci` (Python),
`godrift-ci` (Go), `rubydrift-ci` (Ruby), `javadrift-ci` (Java), `rustdrift-ci` (Rust),
`swiftdrift-ci` (Swift) and `elixirdrift-ci` (Elixir), ported to .NET's own files.

Comparisons are at **major version** only: .NET ships one new major version a year
(`net6.0`, `net7.0`, `net8.0`, ...) and that TFM boundary IS the real compatibility line —
confirmed from learn.microsoft.com/dotnet/standard/frameworks, whose own "Latest versions" table
lists one target framework moniker per major release, not per minor. `netstandardX.Y` and
`netcoreappX.Y` monikers are read but excluded from comparison — they're a different TFM family
with no 1:1 SDK-major relationship.

```
$ npx github:growaleaf/dotnetdrift-ci check
dotnetdrift-ci — mode: free (global.json + csproj only)
  no drift found.
  (free mode checked global.json + csproj only — Pro also checks every Dockerfile and GitHub
  Actions workflow: https://dotnetdrift-ci.madeforthisday.com)

$ DOTNETDRIFT_KEY=... npx github:growaleaf/dotnetdrift-ci check
dotnetdrift-ci — mode: Pro (global.json + csproj + Dockerfile + CI workflows)
  DRIFT  [pinMismatch]  Pinned .NET major versions disagree: global.json=8.0.403, App.csproj=net8.0, Dockerfile:1=9.0, .github/workflows/ci.yml:8=8.0.x
```

A `<TargetFrameworks>` (plural) multi-target, or several `*.csproj` files across the repo
declaring different majors on purpose (a `netstandard2.0` library next to a `net8.0` app), and a
deliberate CI version matrix (`dotnet-version: ['6.0.x', '8.0.x']`) are all detected and reported
as skipped — never treated as drift.

## Install

No npm account needed — install straight from the GitHub repo:

```
npm install github:growaleaf/dotnetdrift-ci
```

Or run it without installing:

```
npx github:growaleaf/dotnetdrift-ci check
```

## Usage

```
node cli.js check [--dir <path>] [--json]
```

| Exit code | Meaning |
|---|---|
| 0 | no drift found |
| 1 | a drift finding exists — fail the build on this |
| 2 | configuration error — `--dir` does not exist |

`--json` writes the full report (every source checked, every finding, the skipped-matrix
list) to stdout, suited to a PR-comment bot or a lint-results artifact.

## Free vs. Pro

**Free, no key needed:** compares `global.json`'s SDK major against the repo's single
consistent `*.csproj` `TargetFramework` major. Useful on its own for a library or small service
with no Docker image and no CI-declared `.NET` version.

**Pro ($9, one time):** also scans every `Dockerfile` (any file matching `Dockerfile*`,
anywhere in the repo) and every `.github/workflows/*.yml` for a `dotnet-version:` declaration,
and cross-checks every source against every other source — this is where the real bugs are,
since the Dockerfile and the CI workflow are usually the two files furthest from active editing
when a team bumps its `global.json`.

The license key is checked **offline** — an ECDSA-signed token verified locally; the CLI makes
no network call to check it, ever, and reads neither your source files nor your repository name
over the network at any point.

```
export DOTNETDRIFT_KEY=<your key>       # CI secret
# or, on your own machine:
mkdir -p ~/.dotnetdrift && echo "<your key>" > ~/.dotnetdrift/license
```

Buy a key: https://dotnetdrift-ci.madeforthisday.com (one-time purchase, no subscription).

## How this differs from an existing tool you may already know

`actions/setup-dotnet` can itself *read* `global.json` via its `global-json-file` input, but
that only answers "what SDK should this one CI job install" — it does not cross-check the
project's own version-declaration files against each other, or notice when a Dockerfile still
pins an older major than `global.json` now requires. A search of the npm registry and GitHub for
a tool with that exact cross-check scope turned up nothing as of 2026-11-06 — this is a narrow,
specific gap, not a crowded one.

## Source

Source is readable here before you buy. The free tier works as shipped; the Pro tier needs a
key (see `LICENSE`).
