/**
 * test-track-identity-palette.mjs — when coloring by Identity, a track color is
 * never an identity color.
 *
 * In Identity mode a track with no identity on the frame falls back to its
 * TRACK color, so the two palettes share the canvas. The identity palette
 * (`IDENTITY_COLORS`, pose/pose-data.js) is full-saturation neon over the
 * whole hue wheel, and Track mode's palette (`TRACK_COLORS`) is vivid too, so
 * every track lands near some identity: after Track All, `track_4`
 * (`#2bce48`) drew in nearly the green of `id_0` (`#00ff00`) — ΔE2000 12.2 —
 * and read as that animal. Track mode keeps the vivid palette, where no
 * identity color is on the canvas; Identity mode draws tracks from
 * `UNIDENTIFIED_TRACK_COLORS` instead.
 *
 * The rule for that palette, measured in CIEDE2000 (perceptual distance; ~2
 * is a just-noticeable difference, ~10 "same family, clearly different", 20+
 * a different color):
 *   - every entry is >= 20 from every identity color;
 *   - >= 15 from the other fixed meanings on the canvas — reprojection red,
 *     ungrouped-user peach, and the no-ID gray;
 *   - >= 9 from every other track color, so tracks still tell apart (the
 *     old palette's closest pair was 4.0);
 *   - no darker than L* 52, or a name label vanishes into its translucent
 *     black pill wherever the pill sits over a white mouse.
 *
 * §8-9 hold the identity palette to the same standard against itself: N
 * animals show its first N entries, so the closest pair among them must stay
 * wide as N grows, and a project saved with an old default gets the new one.
 *
 * Both modules are import-free, so they load directly under Node.
 */
import { pathToFileURL } from 'url';
import path from 'path';

const ov = await import(pathToFileURL(path.resolve('ui/overlays.js')).href);
const pd = await import(pathToFileURL(path.resolve('pose/pose-data.js')).href);
const { TRACK_COLORS, UNIDENTIFIED_TRACK_COLORS, REPROJECTION_COLOR, UNGROUPED_USER_COLOR,
    NULL_ID_COLOR, getTrackColor, getGroupColor, getInstanceColor } = ov;
const { IDENTITY_COLORS } = pd;

const MIN_FROM_IDENTITY = 20;
const MIN_FROM_FIXED = 15;
const MIN_BETWEEN_TRACKS = 9;
const MIN_LIGHTNESS = 52;

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};

// sRGB hex -> CIELAB (D65).
function hexToLab(hex) {
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const r = lin(parseInt(hex.slice(1, 3), 16) / 255);
    const g = lin(parseInt(hex.slice(3, 5), 16) / 255);
    const b = lin(parseInt(hex.slice(5, 7), 16) / 255);
    const X = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
    const Y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
    const Z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    const fx = f(X), fy = f(Y), fz = f(Z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// CIEDE2000 (Sharma, Wu & Dalal 2005), kL = kC = kH = 1.
function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
    const rad = Math.PI / 180;
    const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
    const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
    const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    const hue = (b, a) => {
        if (a === 0 && b === 0) return 0;
        const h = Math.atan2(b, a) / rad;
        return h < 0 ? h + 360 : h;
    };
    const h1p = hue(b1, a1p), h2p = hue(b2, a2p);
    const dLp = L2 - L1, dCp = C2p - C1p;
    let dhp = 0;
    if (C1p * C2p !== 0) {
        dhp = h2p - h1p;
        if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
    }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp / 2 * rad);
    const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
    let hbp = h1p + h2p;
    if (C1p * C2p !== 0) {
        hbp = Math.abs(h1p - h2p) > 180
            ? (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2
            : (h1p + h2p) / 2;
    }
    const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
        + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.20 * Math.cos((4 * hbp - 63) * rad);
    const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
    const RC = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)));
    const SL = 1 + 0.015 * Math.pow(Lbp - 50, 2) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
    const SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T;
    const RT = -Math.sin(2 * dTheta * rad) * RC;
    return Math.sqrt(Math.pow(dLp / SL, 2) + Math.pow(dCp / SC, 2) + Math.pow(dHp / SH, 2)
        + RT * (dCp / SC) * (dHp / SH));
}
const dE = (h1, h2) => deltaE2000(hexToLab(h1), hexToLab(h2));

console.log('\n0. The metric itself matches the published CIEDE2000 test data');
{
    // Sharma, Wu & Dalal (2005), Table 1 — pairs 1, 7, 17, 19, 25, 34. These
    // cover the hue-wrap, the blue-region rotation term and near-neutral input,
    // so a typo anywhere above fails here rather than loosening the rule.
    const ref = [
        [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
        [[50, 0, 0], [50, -1, 2], 2.3669],
        [[50, 2.5, 0], [73, 25, -18], 27.1492],
        [[50, 2.5, 0], [50, 3.1736, 0.5854], 1.0000],
        [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
        [[2.0776, 0.0795, -1.1350], [0.9033, -0.0636, -0.5514], 0.9082],
    ];
    for (const [p, q, want] of ref) {
        const got = deltaE2000(p, q);
        check(Math.abs(got - want) < 1e-4, `ΔE(${p.join(',')} | ${q.join(',')}) = ${got.toFixed(4)} (want ${want})`);
    }
}

console.log('\n1. Negative control: the metric catches the reported collision');
{
    // TRACK_COLORS[4] — what Identity mode used to draw for `track_4` (no
    // identity) beside `id_0`, and still what Track mode draws.
    const d = dE(TRACK_COLORS[4], IDENTITY_COLORS[0]);
    check(TRACK_COLORS[4] === '#2bce48' && d < MIN_FROM_IDENTITY,
        `Track mode's track_4 ${TRACK_COLORS[4]} vs id_0 ${IDENTITY_COLORS[0]} is ${d.toFixed(1)} < ${MIN_FROM_IDENTITY}, so the rule rejects it`);
    let worst = Infinity;
    for (const t of TRACK_COLORS) for (const id of IDENTITY_COLORS) worst = Math.min(worst, dE(t, id));
    check(worst < MIN_FROM_IDENTITY, `the whole Track-mode palette would fail (worst pair ${worst.toFixed(1)}), which is why Identity mode does not use it`);
}

console.log(`\n2. Every Identity-mode track color is >= ${MIN_FROM_IDENTITY} from every identity color`);
{
    // All 20 identity colors, not just the first few: the palette cycles, and
    // a 6-animal project already uses #0088ff, the hardest one to stay off.
    let worst = Infinity, pair = '';
    for (const t of UNIDENTIFIED_TRACK_COLORS) {
        for (const id of IDENTITY_COLORS) {
            const d = dE(t, id);
            if (d < worst) { worst = d; pair = `${t} vs ${id}`; }
        }
    }
    check(worst >= MIN_FROM_IDENTITY, `closest track/identity pair is ${pair} at ${worst.toFixed(1)}`);
}

console.log(`\n3. Every Identity-mode track color is >= ${MIN_FROM_FIXED} from the canvas's fixed colors`);
{
    const fixed = { REPROJECTION_COLOR, UNGROUPED_USER_COLOR, NULL_ID_COLOR };
    for (const [name, hex] of Object.entries(fixed)) {
        let worst = Infinity, which = '';
        for (const t of UNIDENTIFIED_TRACK_COLORS) {
            const d = dE(t, hex);
            if (d < worst) { worst = d; which = t; }
        }
        check(worst >= MIN_FROM_FIXED, `${name} ${hex}: closest track color ${which} at ${worst.toFixed(1)}`);
    }
}

console.log(`\n4. Identity-mode track colors stay >= ${MIN_BETWEEN_TRACKS} from each other`);
{
    let worst = Infinity, pair = '';
    for (let i = 0; i < UNIDENTIFIED_TRACK_COLORS.length; i++) {
        for (let j = i + 1; j < UNIDENTIFIED_TRACK_COLORS.length; j++) {
            const d = dE(UNIDENTIFIED_TRACK_COLORS[i], UNIDENTIFIED_TRACK_COLORS[j]);
            if (d < worst) { worst = d; pair = `${UNIDENTIFIED_TRACK_COLORS[i]} vs ${UNIDENTIFIED_TRACK_COLORS[j]}`; }
        }
    }
    check(worst >= MIN_BETWEEN_TRACKS, `closest pair ${pair} at ${worst.toFixed(1)}`);
    check(new Set(UNIDENTIFIED_TRACK_COLORS).size === UNIDENTIFIED_TRACK_COLORS.length, 'no duplicate entries');
    check(UNIDENTIFIED_TRACK_COLORS.every((c) => /^#[0-9a-f]{6}$/.test(c)), 'every entry is #rrggbb (adjustColorBrightness/hexToRgb parse it by slice)');
}

console.log(`\n4b. No Identity-mode track color is darker than L* ${MIN_LIGHTNESS}`);
{
    let darkest = Infinity, which = '';
    for (const t of UNIDENTIFIED_TRACK_COLORS) {
        const L = hexToLab(t)[0];
        if (L < darkest) { darkest = L; which = t; }
    }
    check(Math.round(darkest) >= MIN_LIGHTNESS, `darkest is ${which} at L* ${darkest.toFixed(1)}`);
}

console.log('\n5. getTrackColor answers from the palette of the coloring mode');
{
    const idxs = [0, 1, 4, 11, 12, 99, -1, null, undefined, NaN];
    check(idxs.every((i) => TRACK_COLORS.includes(getTrackColor(i))),
        `Track mode: indices ${idxs.map(String).join(', ')} all resolve inside TRACK_COLORS`);
    check(idxs.every((i) => UNIDENTIFIED_TRACK_COLORS.includes(getTrackColor(i, true))),
        'Identity mode: the same indices all resolve inside UNIDENTIFIED_TRACK_COLORS');
    check(TRACK_COLORS.every((t) => !UNIDENTIFIED_TRACK_COLORS.includes(t)), 'the two palettes share no entry');
}

console.log('\n6. Coloring by Identity: an identity-less track draws in a track color');
{
    // The screenshot's case: `track_4` with identity "(none)" beside `id_0`.
    const id0 = new pd.Identity(0);
    const session = {
        getIdentityForTrack: (trackIdx) => (trackIdx === 0 ? id0 : null),
        isExplicitNoIdentity: () => false,
        isNoIdTrack: () => false,
        getIdentity: (id) => (id === 0 ? id0 : null),
    };
    const unlinked = { trackIdx: 4, identityId: null };
    const ulColor = getInstanceColor(unlinked, session, 'cam', true, 0);
    check(UNIDENTIFIED_TRACK_COLORS.includes(ulColor), `ungrouped track_4 draws in an Identity-mode track color (${ulColor})`);
    check(dE(ulColor, id0.color) >= MIN_FROM_IDENTITY,
        `which is ${dE(ulColor, id0.color).toFixed(1)} from id_0 ${id0.color}`);

    const group = { instances: new Map([['cam', { trackIdx: 4 }]]), identityId: null };
    const gColor = getGroupColor(group, session, true, 0, 'cam');
    check(UNIDENTIFIED_TRACK_COLORS.includes(gColor), `grouped, identity-less track_4 draws in an Identity-mode track color (${gColor})`);

    const named = { instances: new Map([['cam', { trackIdx: 0 }]]), identityId: null };
    check(getGroupColor(named, session, true, 0, 'cam') === id0.color,
        'and a track WITH an identity still draws in the identity color');

    console.log('\n7. Coloring by Track: the vivid palette, unchanged');
    check(getInstanceColor(unlinked, session, 'cam', false, 0) === TRACK_COLORS[4],
        `ungrouped track_4 is TRACK_COLORS[4] ${TRACK_COLORS[4]}`);
    check(getGroupColor(group, session, false, 0, 'cam') === TRACK_COLORS[4], 'and so is the grouped one');
    check(getGroupColor(named, session, false, 0, 'cam') === TRACK_COLORS[0],
        'a track with an identity is drawn by its track, too');
}

console.log('\n8. The identity palette stays distinct from itself as animals are added');
{
    // Identity N takes entry N, so a project with N animals shows the first N.
    // The first 7 are the original set and must not change; 7-19 replaced
    // entries that put id_7 6.0 from id_0 and the closest pair at 1.4.
    const ORIGINAL_7 = ['#00ff00', '#ff00ff', '#00ffff', '#ffff00', '#ff8800', '#0088ff', '#ff0088'];
    const LEGACY = ['#00ff00', '#ff00ff', '#00ffff', '#ffff00', '#ff8800', '#0088ff', '#ff0088',
        '#88ff00', '#8800ff', '#00ff88', '#ff0000', '#0000ff', '#00ff44', '#ff4400', '#4400ff',
        '#44ff00', '#ff0044', '#0044ff', '#ffaa00', '#aa00ff'];
    check(IDENTITY_COLORS.length === 20, `20 identity colors (${IDENTITY_COLORS.length})`);
    check(ORIGINAL_7.every((c, i) => IDENTITY_COLORS[i] === c), 'id_0..id_6 are the original seven');

    const closestOfFirst = (pal, n) => {
        let worst = Infinity, pair = '';
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
            const d = dE(pal[i], pal[j]);
            if (d < worst) { worst = d; pair = `id_${i} ${pal[i]} / id_${j} ${pal[j]}`; }
        }
        return { worst, pair };
    };
    // Floors per animal count, each a little under what the palette achieves.
    const FLOORS = [[7, 18], [8, 17.5], [9, 16], [10, 14.5], [12, 13.5], [20, 8.5]];
    for (const [n, floor] of FLOORS) {
        const r = closestOfFirst(IDENTITY_COLORS, n);
        check(r.worst >= floor, `${n} animals: closest pair ${r.pair} at ${r.worst.toFixed(1)} >= ${floor}`);
    }
    const old8 = closestOfFirst(LEGACY, 8);
    check(old8.worst < 17.5, `negative control: the old palette at 8 animals is ${old8.worst.toFixed(1)} (${old8.pair}), so it fails`);

    // Vivid and visible: what keeps an identity from reading as a muted track
    // (section 2 checks the distance itself) and from vanishing on dark video.
    let dimmest = Infinity, dullest = Infinity, dW = '', cW = '';
    for (const c of IDENTITY_COLORS) {
        const [L, a, b] = hexToLab(c), C = Math.hypot(a, b);
        if (L < dimmest) { dimmest = L; dW = c; }
        if (C < dullest) { dullest = C; cW = c; }
    }
    check(Math.round(dimmest) >= 55, `no identity color darker than L* 55 (dimmest ${dW} at ${dimmest.toFixed(1)})`);
    check(Math.round(dullest) >= 50, `every identity color is vivid, chroma >= 50 (dullest ${cW} at ${dullest.toFixed(1)})`);

    // The canvas's other fixed meanings, and white, the selection color.
    const fixed = { REPROJECTION_COLOR, UNGROUPED_USER_COLOR, NULL_ID_COLOR, selection: '#ffffff' };
    for (const [name, hex] of Object.entries(fixed)) {
        let worst = Infinity, which = '';
        for (let i = 7; i < IDENTITY_COLORS.length; i++) {
            const d = dE(IDENTITY_COLORS[i], hex);
            if (d < worst) { worst = d; which = IDENTITY_COLORS[i]; }
        }
        check(worst >= MIN_FROM_FIXED, `${name} ${hex}: closest new identity color ${which} at ${worst.toFixed(1)}`);
    }
}

console.log('\n9. A saved old default is upgraded on load; any other color is kept');
{
    // Every load path builds identities with `new Identity(id, name, color)`.
    const Id = pd.Identity;
    check(new Id(7, 'id_7', '#88ff00').color === IDENTITY_COLORS[7],
        `id_7 saved as the old default #88ff00 loads as ${IDENTITY_COLORS[7]}`);
    check(new Id(19, 'id_19', '#AA00FF').color === IDENTITY_COLORS[19], 'matched case-insensitively');
    check(new Id(27, 'id_27', '#88ff00').color === IDENTITY_COLORS[7], 'and by slot, id % 20');
    check(new Id(8, 'id_8', '#88ff00').color === '#88ff00',
        'an old default stored on a DIFFERENT identity is not a default there, so it is kept');
    check(new Id(7, 'id_7', '#123456').color === '#123456', 'a color from another tool is kept');
    check(new Id(0, 'id_0', '#00ff00').color === '#00ff00', 'the original seven are unchanged');
    check(new Id(7, 'id_7').color === IDENTITY_COLORS[7], 'no color: the current default');
}

console.log('\n10. Behavior colors (pose/behavior-ethogram.js) tell behaviors apart and read on a pill');
{
    // A behavior color fills a chip above an animal's name and a bar on the
    // timeline. Each behavior has its own color, never an animal's, so the
    // rule is only that they stay apart from each other and light enough for
    // the chip's dark text and the dark timeline.
    const be = await import(pathToFileURL(path.resolve('pose/behavior-ethogram.js')).href);
    const B = be.BEHAVIOR_COLORS;
    const MIN_BETWEEN_BEHAVIORS = 12;
    let worst = { d: Infinity };
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
        const d = dE(B[i], B[j]);
        if (d < worst.d) worst = { d, a: B[i], b: B[j] };
    }
    check(worst.d >= MIN_BETWEEN_BEHAVIORS,
        `every pair of behavior colors >= ${MIN_BETWEEN_BEHAVIORS} apart (closest ${worst.a} / ${worst.b}: ${worst.d.toFixed(1)})`);
    const dark = B.filter(h => hexToLab(h)[0] < 60);
    check(dark.length === 0, `every behavior color is L* >= 60, light enough for dark chip text (${dark.join(', ') || 'none darker'})`);
    check(new Set(B.map(h => h.toLowerCase())).size === B.length, 'no color is listed twice');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
