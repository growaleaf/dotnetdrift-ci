'use strict';
// Standalone-package test suite for dotnetdrift-ci. Exercises the exact exported functions the
// shipped cli.js ships against real fixture trees on disk (global.json, *.csproj, Dockerfile,
// .github/workflows/*.yml) — never a mocked file tree.
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const {
  buildReport, verifyLicenseWith, parseDotnetMajorFromVersion, parseTfmMajor, readGlobalJson,
  findCsprojTfms, findDockerfilePins, findWorkflowPins,
} = require('../cli.js');

let passed = 0;
const failures = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log('  ok -', name);
  }).catch((err) => {
    failures.push({ name, err });
    console.log('FAIL -', name, '\n       ', err.message);
  });
}

const FIXTURES = path.join(__dirname, 'fixtures');

async function main() {
  await check('parseDotnetMajorFromVersion extracts the leading major from an x.y.znn version', () => {
    assert.equal(parseDotnetMajorFromVersion('8.0.403'), 8);
    assert.equal(parseDotnetMajorFromVersion('10.0.100'), 10);
    assert.equal(parseDotnetMajorFromVersion('8.0'), 8);
    assert.equal(parseDotnetMajorFromVersion('latest'), null);
  });

  await check('parseTfmMajor extracts major only from a net<major>.<minor> TFM, excludes netstandard/netcoreapp', () => {
    assert.equal(parseTfmMajor('net8.0'), 8);
    assert.equal(parseTfmMajor('net8.0-windows'), 8);
    assert.equal(parseTfmMajor('net10.0-android34.0'), 10);
    assert.equal(parseTfmMajor('netstandard2.0'), null);
    assert.equal(parseTfmMajor('netcoreapp3.1'), null);
    assert.equal(parseTfmMajor('garbage'), null);
  });

  await check('readGlobalJson reads sdk.version, null when absent or malformed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnetdrift-gj-'));
    fs.writeFileSync(path.join(dir, 'global.json'), JSON.stringify({ sdk: { version: '8.0.403' } }));
    assert.deepEqual(readGlobalJson(dir), { raw: '8.0.403', major: 8 });
    fs.writeFileSync(path.join(dir, 'global.json'), 'not json');
    assert.equal(readGlobalJson(dir), null);
    assert.equal(readGlobalJson(os.tmpdir() + '/does-not-exist-dotnetdrift'), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('findCsprojTfms reads a single <TargetFramework>', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnetdrift-csproj-'));
    fs.writeFileSync(path.join(dir, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
    const tfms = findCsprojTfms(dir);
    assert.equal(tfms.length, 1);
    assert.equal(tfms[0].major, 8);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('findCsprojTfms expands a plural <TargetFrameworks> and flags it multiTarget', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnetdrift-csproj-multi-'));
    fs.writeFileSync(path.join(dir, 'Lib.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>netstandard2.0;net8.0</TargetFrameworks></PropertyGroup></Project>');
    const tfms = findCsprojTfms(dir);
    assert.equal(tfms.length, 2);
    assert.ok(tfms.every((t) => t.multiTarget));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('findDockerfilePins finds mcr.microsoft.com/dotnet/sdk FROM lines, skips unversioned tags', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnetdrift-docker-'));
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build\nRUN echo hi\n');
    fs.mkdirSync(path.join(dir, 'services', 'api'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'services', 'api', 'Dockerfile.prod'), 'FROM mcr.microsoft.com/dotnet/sdk:latest\nFROM mcr.microsoft.com/dotnet/sdk:9.0-alpine\n');
    const pins = findDockerfilePins(dir);
    assert.equal(pins.length, 2); // the unversioned "sdk:latest" FROM is skipped
    assert.deepEqual(pins.map((p) => p.major).sort(), [8, 9]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('findWorkflowPins reads a scalar dotnet-version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnetdrift-wf-scalar-'));
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), [
      'jobs:', '  test:', '    steps:', '      - uses: actions/setup-dotnet@v4',
      '        with:', "          dotnet-version: '8.0.x'", '',
    ].join('\n'));
    const pins = findWorkflowPins(dir);
    assert.equal(pins.length, 1);
    assert.equal(pins[0].major, 8);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('findWorkflowPins treats a block-style matrix list as matrix, not a comparable pin', () => {
    const pins = findWorkflowPins(path.join(FIXTURES, 'matrix'));
    const matrixPins = pins.filter((p) => p.matrix);
    assert.equal(matrixPins.length, 1);
    assert.deepEqual(matrixPins[0].values, ['6.0.x', '8.0.x']);
  });

  await check('buildReport free mode (no Pro): consistent fixture has zero findings', () => {
    const result = buildReport(path.join(FIXTURES, 'consistent'), { pro: false });
    assert.equal(result.breach, false);
    assert.equal(result.pro, false);
    // Dockerfile/CI pins are not even collected in free mode.
    assert.equal(result.sources.pins.length, 2);
  });

  await check('buildReport Pro mode: consistent fixture (global.json/csproj/Dockerfile/CI all major 8) is clean', () => {
    const result = buildReport(path.join(FIXTURES, 'consistent'), { pro: true });
    assert.equal(result.breach, false);
    assert.equal(result.sources.pins.length, 4);
  });

  await check('buildReport Pro mode: drift fixture flags pinMismatch (global.json/csproj/CI at 8, Dockerfile at 9)', () => {
    const result = buildReport(path.join(FIXTURES, 'drift'), { pro: true });
    assert.equal(result.breach, true);
    assert.ok(result.findings.some((f) => f.rule === 'pinMismatch'));
  });

  await check('buildReport free mode on the drift fixture: global.json and csproj already agree, so free mode alone sees no drift', () => {
    // The drift fixture's Dockerfile-only divergence is invisible without Pro mode, same
    // deliberate free/Pro gap as this lane's other *drift-ci products.
    const result = buildReport(path.join(FIXTURES, 'drift'), { pro: false });
    assert.equal(result.breach, false);
    assert.equal(result.sources.pins.length, 2);
  });

  await check('buildReport Pro mode: a deliberate CI version matrix is reported as skipped, never as drift', () => {
    const result = buildReport(path.join(FIXTURES, 'matrix'), { pro: true });
    assert.equal(result.breach, false);
    assert.ok(result.matrixSources.length >= 1);
  });

  await check('buildReport on a tree with only global.json (no csproj, no Docker, no CI) is clean, not an error', () => {
    const result = buildReport(path.join(FIXTURES, 'minimal'), { pro: true });
    assert.equal(result.breach, false);
    assert.equal(result.sources.csprojTfm, null);
  });

  await check('buildReport throws ConfigError when --dir does not exist', () => {
    assert.throws(() => buildReport(path.join(FIXTURES, 'does-not-exist'), {}), /is not a directory/);
  });

  await check('CLI end-to-end via real subprocess: free mode runs with no key, Pro mode engages with a real minted key', () => {
    const cliPath = path.join(__dirname, '..', 'cli.js');

    const runCli = (args, env) => {
      try {
        const out = execFileSync('node', [cliPath, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
        return { code: 0, out };
      } catch (e) {
        return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
      }
    };

    // Free mode, no key at all: consistent fixture is still clean (exit 0), and the CLI runs
    // successfully rather than refusing outright — license absence narrows scope, it is not a
    // hard gate on the whole tool.
    const freeRun = runCli(['check', '--dir', path.join(FIXTURES, 'consistent')], { DOTNETDRIFT_KEY: '' });
    assert.equal(freeRun.code, 0);
    assert.ok(freeRun.out.includes('free'));

    // Pro mode with a real minted key: the drift fixture now fails (the Dockerfile pin disagrees
    // with global.json/csproj/CI, which free mode alone could not see).
    const devVarsPath = path.join(os.homedir(), '.hive_devtools_license_keys', 'dotnetdrift.dev.vars');
    const devVars = fs.readFileSync(devVarsPath, 'utf8');
    const privB64 = devVars.match(/LICENSE_PRIVATE_KEY=(\S+)/)[1];
    const privateKey = crypto.createPrivateKey({ key: Buffer.from(privB64, 'base64'), format: 'der', type: 'pkcs8' });
    const payload = Buffer.from(JSON.stringify({ product: 'dotnetdrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`DN1.${payload}`).end().sign(privateKey).toString('base64url');
    const realKey = `DN1.${payload}.${sig}`;

    const proRun = runCli(['check', '--dir', path.join(FIXTURES, 'drift')], { DOTNETDRIFT_KEY: realKey });
    assert.equal(proRun.code, 1);
    assert.ok(proRun.out.includes('Pro'));

    const proCleanRun = runCli(['check', '--dir', path.join(FIXTURES, 'consistent')], { DOTNETDRIFT_KEY: realKey });
    assert.equal(proCleanRun.code, 0);
  });

  await check('license: a key signed by the real private key verifies true against the matching public key', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'dotnetdrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`DN1.${payload}`).end().sign(privateKey).toString('base64url');
    assert.equal(verifyLicenseWith(`DN1.${payload}.${sig}`, pubPem), true);
  });

  await check('license: a tampered key is rejected', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'dotnetdrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`DN1.${payload}`).end().sign(privateKey).toString('base64url');
    const tamperedPayload = Buffer.from(JSON.stringify({ product: 'dotnetdrift-pro', iat: 0 })).toString('base64url');
    assert.equal(verifyLicenseWith(`DN1.${tamperedPayload}.${sig}`, pubPem), false);
  });

  await check('license: non-canonical base64url (coin-flip tamper-bypass shape) is rejected, not accepted by luck', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'dotnetdrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`DN1.${payload}`).end().sign(privateKey).toString('base64url');
    assert.equal(verifyLicenseWith(`DN1.${payload}.${sig}AB`, pubPem), false);
  });

  await check('license: a key signed by a DIFFERENT private key is rejected by this public key', () => {
    const { publicKey: pubA } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { privateKey: privB } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPemA = pubA.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'dotnetdrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`DN1.${payload}`).end().sign(privB).toString('base64url');
    assert.equal(verifyLicenseWith(`DN1.${payload}.${sig}`, pubPemA), false);
  });

  await check('license: wrong product in the payload is rejected even with a valid signature', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'some-other-product', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`DN1.${payload}`).end().sign(privateKey).toString('base64url');
    assert.equal(verifyLicenseWith(`DN1.${payload}.${sig}`, pubPem), false);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
  else console.log('All dotnetdrift-ci standalone test groups passed.');
}

main();
