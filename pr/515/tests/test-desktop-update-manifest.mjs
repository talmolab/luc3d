/**
 * test-desktop-update-manifest.mjs — the desktop updater's CI scripts:
 *
 *   scripts/desktop/make_update_manifest.py    writes latest.json (Tauri's
 *       static update format) from a directory of payloads + .sig files
 *   scripts/desktop/check_update_signatures.py fails a build whose .sig files
 *       were made by a key other than tauri.conf.json's plugins.updater.pubkey
 *
 * Both run on fixture directories here (no network, no Rust):
 *   1. all three platforms → the exact key set, URLs, signatures, version/date
 *   2. a payload without its .sig → refused, nothing written
 *   3. a .sig without its payload → refused
 *   4. zero platforms → refused; two payloads for one platform → refused
 *   5. filenames with spaces/specials are percent-encoded in the URL
 *   6. bad --version / --pub-date / --base-url → refused
 *   7. signatures: REAL Tauri signer output (public data only, embedded
 *      below): the app key's signature is accepted, a throwaway key's rejected,
 *      a missing required payload/.sig fails, a corrupt .sig fails
 *   8. optional live check: with LUCID_UPDATER_KEY_FILE (+ ..._PASSWORD_FILE)
 *      set, signs a fresh file with `npx @tauri-apps/cli@2 signer sign` and
 *      checks it against that key's .pub. The private key never enters the repo.
 *
 * Run:  node tests/test-desktop-update-manifest.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.platform === 'win32' ? 'py' : 'python3';
const MANIFEST = path.join(ROOT, 'scripts', 'desktop', 'make_update_manifest.py');
const CHECK = path.join(ROOT, 'scripts', 'desktop', 'check_update_signatures.py');

let passed = 0, failed = 0; const failures = [];
function ok(c, m) { if (c) passed++; else { failed++; failures.push(m); console.error('  ✗ ' + m); } }
function group(n) { console.log('\n• ' + n); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-update-manifest-'));
const run = (script, args) => spawnSync(PY, [script, ...args], { cwd: tmp, encoding: 'utf8' });
const fixture = (name, files) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
    return dir;
};
const BASE = 'https://github.com/talmolab/luc3d/releases/download/v1.2.0';
const manifest = (dir, extra = []) => {
    const out = path.join(dir, '..', path.basename(dir) + '.latest.json');
    fs.rmSync(out, { force: true });
    const r = run(MANIFEST, ['--version', '1.2.0', '--pub-date', '2026-11-04T12:00:00Z',
        '--base-url', BASE, '--assets-dir', dir, '--output', out, ...extra]);
    return { r, out, json: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
};

const ALL = {
    'luc3d_macos.app.tar.gz': 'mac', 'luc3d_macos.app.tar.gz.sig': 'SIG-MAC\n',
    'luc3d_windows_1.2.0_x64-setup.exe': 'win', 'luc3d_windows_1.2.0_x64-setup.exe.sig': 'SIG-WIN',
    'luc3d_linux_1.2.0_amd64.AppImage': 'lin', 'luc3d_linux_1.2.0_amd64.AppImage.sig': 'SIG-LIN',
    // Installers that are not updater payloads, and their stray signatures, are ignored.
    'luc3d_macos_1.2.0_universal.dmg': 'dmg', 'luc3d_linux_1.2.0_amd64.deb': 'deb',
    'luc3d_windows_1.2.0_x64_en-US.msi': 'msi', 'luc3d_windows_1.2.0_x64_en-US.msi.sig': 'SIG-MSI',
};

group('1. all three platforms');
{
    const notes = path.join(tmp, 'notes.md');
    fs.writeFileSync(notes, 'Fixes "quotes"\nand newlines.\n');
    const { r, json } = manifest(fixture('all', ALL), ['--notes-file', notes]);
    ok(r.status === 0, `exit 0 (${r.status}) ${r.stderr.trim()}`);
    ok(json && json.version === '1.2.0' && json.pub_date === '2026-11-04T12:00:00Z',
        'version and pub_date as given');
    ok(json && json.notes === 'Fixes "quotes"\nand newlines.', 'notes read from the file (trimmed), quotes intact');
    const keys = json ? Object.keys(json.platforms).sort() : [];
    const want = ['darwin-aarch64', 'darwin-aarch64-app', 'darwin-x86_64', 'darwin-x86_64-app',
        'linux-x86_64', 'linux-x86_64-appimage', 'windows-x86_64', 'windows-x86_64-nsis'];
    ok(JSON.stringify(keys) === JSON.stringify(want), `exactly the 8 platform keys (${keys.join(', ')})`);
    const p = json ? json.platforms : {};
    for (const k of ['darwin-aarch64', 'darwin-x86_64', 'darwin-aarch64-app', 'darwin-x86_64-app'])
        ok(p[k] && p[k].url === BASE + '/luc3d_macos.app.tar.gz' && p[k].signature === 'SIG-MAC',
            `${k} → the universal .app.tar.gz, signature from its .sig (trimmed)`);
    for (const k of ['windows-x86_64', 'windows-x86_64-nsis'])
        ok(p[k] && p[k].url === BASE + '/luc3d_windows_1.2.0_x64-setup.exe' && p[k].signature === 'SIG-WIN',
            `${k} → the NSIS -setup.exe`);
    for (const k of ['linux-x86_64', 'linux-x86_64-appimage'])
        ok(p[k] && p[k].url === BASE + '/luc3d_linux_1.2.0_amd64.AppImage' && p[k].signature === 'SIG-LIN',
            `${k} → the AppImage`);
    ok(!JSON.stringify(json).includes('.msi') && !JSON.stringify(json).includes('.deb'),
        'MSI / deb are not updater payloads');
    const sub = manifest(fixture('mac-only', { 'luc3d_macos.app.tar.gz': 'm', 'luc3d_macos.app.tar.gz.sig': 's' }));
    ok(sub.r.status === 0 && Object.keys(sub.json.platforms).length === 4,
        'one platform alone is a valid manifest (a release whose other legs failed)');
}

group('2–4. refusals (nothing written)');
{
    const noSig = { ...ALL }; delete noSig['luc3d_windows_1.2.0_x64-setup.exe.sig'];
    let m = manifest(fixture('nosig', noSig));
    ok(m.r.status === 1 && m.json === null && /x64-setup\.exe has no .*\.sig/.test(m.r.stderr),
        'a payload without its .sig is refused');
    const orphan = { ...ALL }; delete orphan['luc3d_linux_1.2.0_amd64.AppImage'];
    m = manifest(fixture('orphan', orphan));
    ok(m.r.status === 1 && m.json === null && /AppImage\.sig has no payload/.test(m.r.stderr),
        'a .sig without its payload is refused');
    m = manifest(fixture('empty', { 'luc3d_macos_1.2.0_universal.dmg': 'dmg', 'notes.txt': 'x' }));
    ok(m.r.status === 1 && m.json === null && /no updater payload/.test(m.r.stderr), 'zero platforms is refused');
    m = manifest(fixture('twomac', { ...ALL, 'luc3d_old.app.tar.gz': 'x', 'luc3d_old.app.tar.gz.sig': 'y' }));
    ok(m.r.status === 1 && m.json === null && /more than one payload/.test(m.r.stderr),
        'two payloads for one platform are refused (stale file?)');
    m = manifest(fixture('emptysig', { 'luc3d_macos.app.tar.gz': 'm', 'luc3d_macos.app.tar.gz.sig': '  \n' }));
    ok(m.r.status === 1 && /\.sig is empty/.test(m.r.stderr), 'an empty .sig is refused');
}

group('5. URL encoding');
{
    const name = 'luc3d test build#1+x.app.tar.gz';
    const { r, json } = manifest(fixture('spaces', { [name]: 'm', [name + '.sig']: 'S' }));
    ok(r.status === 0, 'a name with spaces is accepted');
    const url = json && json.platforms['darwin-aarch64'].url;
    ok(url === BASE + '/luc3d%20test%20build%231%2Bx.app.tar.gz', `percent-encoded: ${url}`);
    ok(json && new URL(url).pathname.endsWith('/luc3d%20test%20build%231%2Bx.app.tar.gz'),
        'a URL parser keeps it one path segment');
}

group('6. argument validation');
{
    const dir = path.join(tmp, 'all');
    const bad = (args, re, what) => {
        const r = run(MANIFEST, args);
        ok(r.status !== 0 && re.test(r.stderr), `${what} (exit ${r.status})`);
    };
    const base = ['--base-url', BASE, '--assets-dir', dir, '--output', path.join(tmp, 'x.json')];
    bad(['--version', 'v1.2.0', ...base], /not semver/, 'a leading "v" is refused (the app compares the bare version)');
    bad(['--version', '1.2', ...base], /not semver/, 'X.Y is refused');
    bad(['--version', '1.2.0', '--pub-date', 'yesterday', ...base], /RFC 3339/, 'a non-date pub-date is refused');
    bad(['--version', '1.2.0', '--pub-date', '2026-11-04T12:00:00', ...base], /time zone/, 'a pub-date without a zone is refused');
    bad(['--version', '1.2.0', '--base-url', 'http://example.com/x', '--assets-dir', dir], /https/, 'an http base URL is refused');
    const dev = run(MANIFEST, ['--version', '1.0.6-dev.42', ...base]);
    ok(dev.status === 0, 'a dev version X.Y.Z-dev.N is accepted');
    const now = run(MANIFEST, ['--version', '1.2.0', ...base]);
    const j = JSON.parse(fs.readFileSync(path.join(tmp, 'x.json'), 'utf8'));
    ok(now.status === 0 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(j.pub_date) && j.notes === '',
        'pub-date defaults to now (UTC), notes to empty');
}

// Real `npx @tauri-apps/cli@2 signer sign` output over the bytes "dummy payload\n".
// Public data only: two minisign public keys and their signatures, both from
// throwaway keys generated for this test and discarded (APP_* stands in for the
// app's key; the test writes its own tauri.conf.json, so it does not depend on
// the real pubkey in src-tauri/tauri.conf.json).
const APP_PUB = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDY3MURGOEVCRTNERTQwMkEKUldRcVFON2o2L2dkWjBYc0pJMmxwTGd6RW1sRjhSNEJOT0k3aWE2WXA1WStkRW5Ib2VqRjNpNVYK';
const APP_SIG = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRcVFON2o2L2dkWjhoaWVyblpZT05jamhCZkRkalo5NVBYYnlSWWMrUlhselYyYXZjS2RYQXpvVmpqemZXTjFJSy9IRm4zRnRmOFVoRlZhdllHOEtyQjdnTWF6bmd4SFE4PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzODIyMjY3CWZpbGU6cGF5bG9hZC5iaW4KNS9IcDF3MnMwMDJPcElNNnNWNE5UWnBnVHF1VTZtWVRiSmYrTFJCdnE3SHh0eTkzbHh0MFN4TE1WR0lFb1VHR3I4MncvaDZvSDhjR3AwOFh6Z0tMQ2c9PQo=';
const OTHER_PUB = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEUyQzMzMUM3N0I1NDE2MjIKUldRaUZsUjd4ekhENHJpaTF1eFllS29yZW41TnRPMytHMzc4SGRGamsvWlhuZFVuZ1ZqUW9rZ3MK';
const OTHER_SIG = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRaUZsUjd4ekhENHZ0WWhueElUWGM3c0V4bHpqdDQrSEFVVTBvd2FjSW8wRXpydy9zamM1VkdYdkhVOGhpRUg2M280VW5uTlFIdTVpSVllejBabTQxaGgxU25yZEVYWlFRPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzODIyMjc1CWZpbGU6cGF5bG9hZC5iaW4KQ1lTclZlM1pJWEZUVW4yMlNER2NHZ05IeWVpT2g3azYvMzNmblBWVlZpeGtueCt0WnZrOHZnOEE3akJQMklNdUFIdi9HSnlYbUY3S1UyaE5VekxBQ3c9PQo=';

group('7. signature key ids (real Tauri signer output)');
{
    const conf = path.join(tmp, 'tauri.conf.json');
    fs.writeFileSync(conf, JSON.stringify({ plugins: { updater: { pubkey: APP_PUB } } }));
    const good = fixture('sig-good', { 'luc3d_macos.app.tar.gz': 'dummy payload\n', 'luc3d_macos.app.tar.gz.sig': APP_SIG });
    let r = run(CHECK, ['--conf', conf, '--require', '.app.tar.gz', good]);
    ok(r.status === 0 && r.stdout.includes('671DF8EBE3DE402A'), `the app key's signature is accepted (exit ${r.status}) ${r.stderr.trim()}`);
    const bad = fixture('sig-bad', { 'luc3d_macos.app.tar.gz': 'dummy payload\n', 'luc3d_macos.app.tar.gz.sig': OTHER_SIG });
    r = run(CHECK, ['--conf', conf, '--require', '.app.tar.gz', bad]);
    ok(r.status === 1 && /E2C331C77B541622/.test(r.stderr) && /671DF8EBE3DE402A/.test(r.stderr),
        `a throwaway key's signature is rejected, naming both key ids (exit ${r.status})`);
    r = run(CHECK, ['--pubkey', OTHER_PUB, bad]);
    ok(r.status === 0, 'the same signature passes against its own key (the check is the key id, not luck)');
    r = run(CHECK, ['--conf', conf, good, bad]);
    ok(r.status === 1, 'one bad .sig among good ones fails the whole check');
    r = run(CHECK, ['--conf', conf, '--require=-setup.exe', good]);
    ok(r.status === 1 && /no \*-setup\.exe updater payload/.test(r.stderr), 'a required payload that was not produced fails');
    const unsigned = fixture('sig-missing', { 'luc3d_1.2.0_amd64.AppImage': 'x' });
    r = run(CHECK, ['--conf', conf, '--require', '.AppImage', unsigned]);
    ok(r.status === 1 && /has no \.sig/.test(r.stderr), 'a required payload without a .sig fails');
    const corrupt = fixture('sig-corrupt', { 'a.AppImage': 'x', 'a.AppImage.sig': 'bm90IGEgc2lnbmF0dXJl' });
    r = run(CHECK, ['--conf', conf, corrupt]);
    ok(r.status === 1 && /minisign/.test(r.stderr), 'a .sig that is not a minisign signature fails');
    const noKey = path.join(tmp, 'nokey.json');
    fs.writeFileSync(noKey, '{"plugins":{}}');
    r = run(CHECK, ['--conf', noKey, good]);
    ok(r.status === 2 && /pubkey/.test(r.stderr), 'a conf without plugins.updater.pubkey is a usage error');
    const repoConf = path.join(ROOT, 'src-tauri', 'tauri.conf.json');
    if (fs.existsSync(repoConf) && JSON.parse(fs.readFileSync(repoConf, 'utf8'))?.plugins?.updater?.pubkey === APP_PUB) {
        r = run(CHECK, ['--conf', repoConf, good]);
        ok(r.status === 0, "the repo's tauri.conf.json pubkey accepts the app key's signature");
    } else {
        console.log('  (src-tauri/tauri.conf.json carries a different pubkey; skipped the repo-conf check)');
    }
}

group('8. live signing (optional: LUCID_UPDATER_KEY_FILE)');
{
    const keyFile = process.env.LUCID_UPDATER_KEY_FILE;
    if (!keyFile) {
        console.log('  skipped: set LUCID_UPDATER_KEY_FILE (and LUCID_UPDATER_KEY_PASSWORD_FILE) to sign a fresh file');
    } else {
        const pw = process.env.LUCID_UPDATER_KEY_PASSWORD_FILE
            ? fs.readFileSync(process.env.LUCID_UPDATER_KEY_PASSWORD_FILE, 'utf8').trim() : '';
        const dir = fixture('live', { 'luc3d_live.app.tar.gz': 'fresh ' + Date.now() });
        const s = spawnSync('npx', ['--yes', '@tauri-apps/cli@2', 'signer', 'sign', '-f', keyFile, '-p', pw,
            path.join(dir, 'luc3d_live.app.tar.gz')], { encoding: 'utf8', shell: process.platform === 'win32' });
        ok(s.status === 0 && fs.existsSync(path.join(dir, 'luc3d_live.app.tar.gz.sig')), `tauri signer sign ran (exit ${s.status})`);
        const pub = fs.readFileSync(keyFile + '.pub', 'utf8').trim();
        const r = run(CHECK, ['--pubkey', pub, '--require', '.app.tar.gz', dir]);
        ok(r.status === 0, `a fresh signature passes against ${path.basename(keyFile)}.pub (exit ${r.status})`);
        const r2 = run(CHECK, ['--pubkey', OTHER_PUB, dir]);
        ok(r2.status === 1, '…and fails against the throwaway key');
        const m = manifest(dir);
        ok(m.r.status === 0 && m.json.platforms['darwin-aarch64'].signature === fs.readFileSync(path.join(dir, 'luc3d_live.app.tar.gz.sig'), 'utf8').trim(),
            'the manifest carries the fresh signature verbatim');
    }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failed ? '✗ FAIL' : '✓ PASS'} — ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.error('  - ' + f); process.exit(1); }
