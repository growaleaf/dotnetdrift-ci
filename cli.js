#!/usr/bin/env node
'use strict';

// dotnetdrift-ci — self-contained, dependency-free (Node 18+, no npm install).
// Checks whether the .NET SDK version your team THINKS the project builds with agrees across
// every place a project can declare one: global.json's "sdk".version (read by the .NET CLI
// muxer and the MSBuild project SDK resolver — confirmed from learn.microsoft.com/dotnet/core/
// tools/global-json: "Requires the full version number... doesn't support version ranges"; the
// default rollForward policy when unset is "patch", i.e. an exact major/minor/feature-band pin
// with only patch-level flex), every *.csproj's <TargetFramework>/<TargetFrameworks> moniker
// (e.g. "net8.0" — confirmed from learn.microsoft.com/dotnet/standard/frameworks), any
// Dockerfile's "FROM mcr.microsoft.com/dotnet/sdk:X.Y" (tag shape confirmed live against
// mcr.microsoft.com/v2/dotnet/sdk/tags/list, not guessed), and any GitHub Actions workflow's
// "dotnet-version:" (the flat key actions/setup-dotnet reads — confirmed from its own README;
// it does NOT read global.json unless a separate global-json-file input is also set, so the two
// are genuinely independent sources, not one reading the other). Each is edited by a different
// person at a different time, so they drift silently — the same "works in CI, breaks in the
// Docker image" bug this lane already shipped for Node.js, Python, Go, Ruby, Java, Rust, Swift
// and Elixir, ported to .NET's own files.
//
// Granularity is MAJOR version only, not major.minor: .NET ships one new major version a year
// (net6.0, net7.0, net8.0, ...) and that IS the real target-framework-moniker boundary — there
// is no meaningful "8.0 vs 8.1" TFM the way there is for Ruby's 3.1 vs 3.2 (confirmed from the
// frameworks doc's own TFM table: one TFM per major release, "net8.0"/"net9.0"/"net10.0").
//
// A *.csproj using <TargetFrameworks> (plural) to deliberately multi-target, or multiple
// *.csproj files across the repo declaring different majors on purpose (e.g. a netstandard2.0
// library beside a net8.0 app), is reported as a skipped matrix, never as drift — same
// treatment this family already gives an intentional CI version matrix.
//
// FREE: compares global.json's sdk major against the repo's single consistent csproj major
// only. No key needed.
// PRO: also scans every Dockerfile and GitHub Actions workflow in the repo and cross-checks
//      every source against every other source. Unlocked by a valid offline license key — no
//      network call, no account, no phone-home.
//
// Usage:
//   node cli.js check [--dir <path>] [--json]
//
// Exit codes:
//   0 - no drift found
//   1 - a drift finding exists (any rule)
//   2 - configuration/usage error (--dir does not exist or is not a directory)

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------------------------------
// License (BP-001 offline ECDSA-P256 verify) — same chassis as every other D-lane standalone
// CLI, including the canonical-base64url round-trip check from the first line (the tamper-
// bypass coin-flip bug this lane found and fixed 2026-09-07).
// ---------------------------------------------------------------------------------------
const PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEmor4RYYZeubuern0aC61hcTYSV1kEtO/x4O+ozvXo8Euw54cGSUJTizuEdgPWt1U0M2ItQOMWMqASnvRpGcZ3Q==\n-----END PUBLIC KEY-----';
const LICENSE_PRODUCT = 'dotnetdrift-pro';

function b64urlToBuf(s) {
  const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const canonical = buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (canonical !== s) throw new Error('non-canonical base64url');
  return buf;
}

function verifyLicenseWith(key, pubPem) {
  try {
    if (typeof key !== 'string') return false;
    const parts = key.trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'DN1') return false;
    const signedData = `DN1.${parts[1]}`;
    const payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
    if (payload.product !== LICENSE_PRODUCT) return false;
    if (payload.exp && Date.now() > payload.exp) return false;
    const v = crypto.createVerify('SHA256');
    v.update(signedData); v.end();
    return v.verify(pubPem, b64urlToBuf(parts[2]));
  } catch (e) { return false; }
}

function verifyLicense(key) {
  if (PUBLIC_KEY_PEM.includes('PLACEHOLDER')) return false;
  return verifyLicenseWith(key, PUBLIC_KEY_PEM);
}

function readLicenseKey() {
  if (process.env.DOTNETDRIFT_KEY) return process.env.DOTNETDRIFT_KEY.trim();
  try {
    return fs.readFileSync(path.join(os.homedir(), '.dotnetdrift', 'license'), 'utf8').trim();
  } catch (e) {
    return null;
  }
}

function hasPro() {
  const key = readLicenseKey();
  return !!(key && verifyLicense(key));
}

// ---------------------------------------------------------------------------------------
// Version-source parsing — MAJOR version only. "8.0.403" -> 8, "net8.0"/"net8.0-windows" -> 8,
// "netstandard2.0"/"netcoreapp3.1" -> not a .NET-major TFM, excluded (not comparable).
// ---------------------------------------------------------------------------------------
function parseDotnetMajorFromVersion(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d+)\./);
  if (!m) return null;
  return parseInt(m[1], 10);
}

// A target framework moniker: "net8.0", "net8.0-windows", "net9.0-android34.0". Only the
// "net<major>.<minor>" family (.NET 5+) carries a direct SDK-major relationship — netstandardX.Y
// and netcoreappX.Y are different TFM families with no 1:1 SDK-major mapping, so they are read
// but excluded from comparison (not comparable, not an error).
function parseTfmMajor(tfm) {
  if (typeof tfm !== 'string') return null;
  const m = tfm.trim().match(/^net(\d+)\.\d+/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

// global.json's "sdk".version — confirmed from learn.microsoft.com/dotnet/core/tools/global-json
// to require the full x.y.znn version number, no ranges, no wildcards.
function readGlobalJson(rootDir) {
  const p = path.join(rootDir, 'global.json');
  if (!fs.existsSync(p)) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
  const raw = data && data.sdk && data.sdk.version;
  if (typeof raw !== 'string') return null;
  const major = parseDotnetMajorFromVersion(raw);
  if (major == null) return null;
  return { raw, major };
}

const DEFAULT_EXCLUDE_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'build']);
function walk(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir)) {
    if (DEFAULT_EXCLUDE_DIRS.has(e)) continue;
    const p = path.join(dir, e);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Every *.csproj's <TargetFramework>/<TargetFrameworks> in the repo. A single csproj's
// <TargetFrameworks> (plural, semicolon-separated) is itself a deliberate multi-target and is
// expanded into its own entries, same as a bare multi-value CI matrix elsewhere in this family.
function findCsprojTfms(rootDir) {
  const tfms = [];
  for (const fsPath of walk(rootDir)) {
    if (!/\.csproj$/i.test(fsPath)) continue;
    const text = fs.readFileSync(fsPath, 'utf8');
    const single = text.match(/<TargetFramework>\s*([^<]+?)\s*<\/TargetFramework>/);
    const plural = text.match(/<TargetFrameworks>\s*([^<]+?)\s*<\/TargetFrameworks>/);
    const loc = path.relative(rootDir, fsPath);
    if (plural) {
      const values = plural[1].split(';').map((v) => v.trim()).filter(Boolean);
      for (const v of values) tfms.push({ source: loc, raw: v, major: parseTfmMajor(v), multiTarget: values.length > 1 });
    } else if (single) {
      tfms.push({ source: loc, raw: single[1], major: parseTfmMajor(single[1]), multiTarget: false });
    }
  }
  return tfms;
}

// Every "FROM mcr.microsoft.com/dotnet/sdk:X.Y[-suffix]" line in every Dockerfile under rootDir
// — tag shape confirmed live against mcr.microsoft.com/v2/dotnet/sdk/tags/list ("8.0", "10.0",
// "9.0-alpine", ...), not guessed. An unversioned tag ("sdk:latest") is ambiguous and skipped.
function findDockerfilePins(rootDir) {
  const pins = [];
  for (const fsPath of walk(rootDir)) {
    const base = path.basename(fsPath);
    if (!/^Dockerfile(\..+)?$/.test(base)) continue;
    const text = fs.readFileSync(fsPath, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*FROM\s+mcr\.microsoft\.com\/dotnet\/sdk:([^\s]+)/i);
      if (!m) continue;
      const tag = m[1];
      const major = parseDotnetMajorFromVersion(tag);
      if (major == null) continue;
      pins.push({ source: `${path.relative(rootDir, fsPath)}:${i + 1}`, raw: tag, major });
    }
  }
  return pins;
}

// Every "dotnet-version:" declaration in every .github/workflows/*.yml(.yaml) file — the flat
// key actions/setup-dotnet reads (confirmed from its own README: `dotnet-version: '8.0.x'`;
// it does NOT read global.json unless the separate global-json-file input is also set).
function findWorkflowPins(rootDir) {
  const pins = [];
  const wfDir = path.join(rootDir, '.github', 'workflows');
  if (!fs.existsSync(wfDir)) return pins;
  for (const e of fs.readdirSync(wfDir)) {
    if (!/\.ya?ml$/i.test(e)) continue;
    const fsPath = path.join(wfDir, e);
    const lines = fs.readFileSync(fsPath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)dotnet-version:\s*(.*)$/);
      if (!m) continue;
      const indent = m[1].length;
      const rest = m[2].trim();
      let values = [];
      if (rest.startsWith('[')) {
        const inline = rest.match(/\[([^\]]*)\]/);
        if (inline) values = inline[1].split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, ''));
      } else if (rest) {
        values = [rest.replace(/^['"]|['"]$/g, '')];
      } else {
        let j = i + 1;
        while (j < lines.length) {
          const bm = lines[j].match(/^(\s*)-\s*(.+)$/);
          if (!bm || bm[1].length <= indent) break;
          values.push(bm[2].trim().replace(/^['"]|['"]$/g, ''));
          j++;
        }
      }
      if (!values.length) continue;
      const loc = `${path.relative(rootDir, fsPath)}:${i + 1}`;
      if (values.length > 1) {
        pins.push({ source: loc, raw: values.join(','), major: null, matrix: true, values });
      } else {
        const major = parseDotnetMajorFromVersion(values[0]);
        if (major != null) pins.push({ source: loc, raw: values[0], major });
      }
    }
  }
  return pins;
}

// ---------------------------------------------------------------------------------------
// Drift check
// ---------------------------------------------------------------------------------------
function buildReport(rootDir, opts) {
  opts = opts || {};
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    throw new ConfigError(`${rootDir} is not a directory`);
  }
  const globalJson = readGlobalJson(rootDir);
  const csprojTfms = findCsprojTfms(rootDir);
  const comparableTfms = csprojTfms.filter((t) => t.major != null);
  const distinctCsprojMajors = new Set(comparableTfms.map((t) => t.major));
  const csprojIsMatrix = comparableTfms.length > 1 && distinctCsprojMajors.size > 1;

  const pins = [];
  if (globalJson) pins.push({ source: 'global.json', raw: globalJson.raw, major: globalJson.major });
  let csprojMatrixSources = [];
  if (!csprojIsMatrix && comparableTfms.length) {
    const t = comparableTfms[0];
    pins.push({ source: t.source, raw: t.raw, major: t.major });
  } else if (csprojIsMatrix) {
    csprojMatrixSources = [...new Set(comparableTfms.map((t) => t.source))];
  }

  const pro = !!opts.pro;
  let matrixSources = [...csprojMatrixSources];
  if (pro) {
    pins.push(...findDockerfilePins(rootDir));
    const wfPins = findWorkflowPins(rootDir);
    matrixSources.push(...wfPins.filter((p) => p.matrix).map((p) => p.source));
    pins.push(...wfPins.filter((p) => !p.matrix));
  }

  const findings = [];

  const distinctMajors = new Set(pins.map((p) => p.major));
  if (distinctMajors.size > 1) {
    findings.push({
      rule: 'pinMismatch',
      message: `Pinned .NET major versions disagree: ${pins.map((p) => `${p.source}=${p.raw}`).join(', ')}`,
      pins,
    });
  }

  return {
    breach: findings.length > 0,
    pro,
    sources: {
      globalJson: globalJson && globalJson.raw,
      csprojTfm: (!csprojIsMatrix && comparableTfms[0]) ? comparableTfms[0].raw : null,
      pins,
    },
    matrixSources,
    findings,
  };
}

class ConfigError extends Error {}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

function printHumanReport(result) {
  console.log(`dotnetdrift-ci — mode: ${result.pro ? 'Pro (global.json + csproj + Dockerfile + CI workflows)' : 'free (global.json + csproj only)'}`);
  if (result.matrixSources.length) {
    console.log(`  (skipped as intentional multi-targeting/matrix, not drift: ${result.matrixSources.join(', ')})`);
  }
  if (!result.findings.length) {
    console.log('  no drift found.');
  } else {
    for (const f of result.findings) console.log(`  DRIFT  [${f.rule}]  ${f.message}`);
  }
  if (!result.pro) {
    console.log('  (free mode checked global.json + csproj only — Pro also checks every Dockerfile and GitHub Actions workflow: https://dotnetdrift-ci.madeforthisday.com)');
  }
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0];

  if (args.help || !command) {
    console.log('Usage: node cli.js check [--dir <path>] [--json]');
    process.exit(command ? 0 : 2);
    return;
  }
  if (command !== 'check') {
    console.error(`Unknown command "${command}". Only "check" is supported.`);
    process.exit(2);
    return;
  }

  const dir = args.dir ? path.resolve(process.cwd(), args.dir) : process.cwd();
  let result;
  try {
    result = buildReport(dir, { pro: hasPro() });
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`dotnetdrift-ci config error: ${e.message}`);
      process.exit(2);
      return;
    }
    throw e;
  }

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHumanReport(result);

  process.exit(result.breach ? 1 : 0);
}

if (require.main === module) main();

module.exports = {
  buildReport, verifyLicense, verifyLicenseWith, parseDotnetMajorFromVersion, parseTfmMajor,
  readGlobalJson, findCsprojTfms, findDockerfilePins, findWorkflowPins,
};
