"""Checks on Fig 7's ARTWORK and its TEXT, not on the benchmark that produced it.

`fig7_calib_verify.py` asserts the measurement is sound (same inputs, same
observations, no leakage). This file asserts the things that went wrong while the
figure was being assembled and captioned, each of which was silent:

  * `assemble.py` keeps panel TITLES in a table keyed by (figure, letter), separate
    from the panel PDFs. After a re-lettering every title was one slot out of step,
    so panel c carried the 18-camera title over Mouse-Dyad data. Nothing errored.
  * `assemble.py` LAYOUTS named two panel slugs no panel script emits any more, so
    the composite was built from 5 of 7 panels and simply came out shorter. Nothing
    errored, and the stale two-rig PDF stayed on disk looking plausible.
  * A caption number went stale relative to the deposit (2,701 frames for a rig the
    panels had already been re-pooled to 9,029), and a quoted range excluded one of
    the three values it claimed to bound.
  * A panel axis label said "centre", and a row label said "as shipped".
  * `\'` reached the .tex, which LaTeX reads as an acute accent, not an apostrophe.
  * Two supplementary panels rendered with 0 rows of data and were still written.

    python3 figs/fig7_verify_figure.py
"""
import json, os, re, sys, glob

HERE = os.path.dirname(os.path.abspath(__file__))
FIG = 7
PASS, FAIL = [], []


def check(name, ok, detail=''):
    (PASS if ok else FAIL).append(name)
    print(f'  [{"PASS" if ok else "FAIL"}] {name}' + (f'  {detail}' if detail else ''))


def load_assemble():
    """LAYOUTS and TITLES for this figure, read from the source without importing it."""
    src = open(os.path.join(HERE, 'assemble.py')).read()
    i = src.index('LAYOUTS')
    layouts = eval(src[src.index('{', i):src.index('\n}\n', i) + 2])   # noqa: S307
    j = src.index('TITLES = {')
    titles = eval(src[src.index('{', j):src.index('\n}\n', j) + 2])    # noqa: S307
    return layouts[FIG], titles


rows, titles = load_assemble()
letters = [l for row in rows for l, _ in row]
slugs = {l: s for row in rows for l, s in row}

# ---- layout integrity ------------------------------------------------------------
check('panel letters are unique', len(letters) == len(set(letters)),
      f'{"".join(letters)}')
check('panel letters are contiguous from a',
      letters == [chr(ord('a') + i) for i in range(len(letters))],
      f'{"".join(letters)}')

# The bug that mislabeled every plot: a title table keyed independently of the layout.
have = {l for (f, l) in titles if f == FIG}
check('every panel letter has a title', set(letters) <= have,
      f'missing {sorted(set(letters) - have)}' if set(letters) - have else '')
check('no title for a letter the layout does not use', have <= set(letters),
      f'extra {sorted(have - set(letters))}' if have - set(letters) else '')

# A title naming the wrong rig is exactly what a re-letter produces. Tie each title to
# its own slug, which is the only thing that knows which dataset the panel drew.
RIG_IN_SLUG = {'slap8': 'SLAP-2M', 'md10': 'Mouse-Dyad-10M', 'calib18': '18-camera'}
for l in letters:
    slug, title = slugs[l], titles.get((FIG, l), '')
    for key, name in RIG_IN_SLUG.items():
        if slug.endswith(key):
            check(f'title of {l} names the rig its slug draws ({key})', name in title,
                  f'slug {slug!r} title {title!r}')

# ---- the panel files the layout promises -----------------------------------------
fdir = os.path.join(HERE, 'figures', f'fig{FIG}')
for l in letters:
    p = os.path.join(fdir, f'fig{FIG}{l}_{slugs[l]}.pdf')
    check(f'panel {l} pdf exists', os.path.exists(p), os.path.basename(p))

on_disk = {os.path.basename(p) for p in glob.glob(os.path.join(fdir, f'fig{FIG}[a-z]_*.pdf'))}
promised = {f'fig{FIG}{l}_{slugs[l]}.pdf' for l in letters}
supp = {b for b in on_disk if re.match(rf'fig{FIG}s\d', b)}
orphans = on_disk - promised - supp
check('no orphan single-letter panel pdfs', not orphans, f'{sorted(orphans)}')

# ---- composite ------------------------------------------------------------------
import fitz  # noqa: E402

comp = os.path.join(fdir, f'fig{FIG}.pdf')
check('composite exists', os.path.exists(comp))
if os.path.exists(comp):
    pg = fitz.open(comp)[0]
    h_mm = pg.rect.height / 72 * 25.4
    w_mm = pg.rect.width / 72 * 25.4
    check('composite is under the 200 mm ceiling', h_mm <= 200.0, f'{w_mm:.0f} x {h_mm:.0f} mm')
    txt = ' '.join(w[4] for w in pg.get_text('words'))
    drawn = sorted({w for w in txt.split() if len(w) == 1 and w.isalpha() and w.islower()})
    check('composite draws every panel letter', set(letters) <= set(drawn),
          f'drew {"".join(drawn)}')
    BANNED = re.compile(r'\b(centre|colour|grey|metres?|labelled|behaviour|shipped)\b', re.I)
    hits = sorted(set(BANNED.findall(txt)))
    check('no British spellings or banned words rendered', not hits, f'{hits}')

# ---- deposited data --------------------------------------------------------------
ddir = os.path.join(HERE, 'data', f'fig{FIG}')
for p in sorted(glob.glob(os.path.join(ddir, f'fig{FIG}*.csv'))):
    n = sum(1 for line in open(p) if line.strip() and not line.startswith('#'))
    check(f'{os.path.basename(p)} has data rows', n > 1, f'{n - 1} rows')

# A re-letter renames a panel's deposited CSV too. The old file is not overwritten,
# so the pre-change numbers sit beside the new ones under a name that still looks
# current (fig7ac_error_cdf.csv next to fig7ace_error_cdf.csv). Five of these were on
# disk after the three-rig re-letter.
csvs = {os.path.basename(p) for p in glob.glob(os.path.join(ddir, f'fig{FIG}*.csv'))}
mains = {b for b in csvs if not re.match(rf'fig{FIG}s\d', b)}
expect_letters = set()
for b in mains:
    m = re.match(rf'fig{FIG}([a-z]+)_', b)
    if m:
        expect_letters.add(m.group(1))
stale = {b for b in mains
         if (m := re.match(rf'fig{FIG}([a-z]+)_', b)) and not set(m.group(1)) <= set(letters)}
# A CSV whose letter-set is a strict subset of another's for the same slug is the
# pre-re-letter twin: same measurement, fewer panels, older numbers.
by_slug = {}
for b in mains:
    m = re.match(rf'fig{FIG}([a-z]+)_(.+)\.csv', b)
    if m:
        by_slug.setdefault(m.group(2), []).append((m.group(1), b))
for slug, got in by_slug.items():
    if len(got) > 1:
        stale |= {b for _, b in sorted(got, key=lambda t: len(t[0]))[:-1]}
check('no stale duplicate data csvs', not stale, f'{sorted(stale)}')

dep = os.path.join(HERE, 'out', f'fig{FIG}_calibration.json')
check('deposit exists', os.path.exists(dep))
if os.path.exists(dep):
    rec = json.load(open(dep))
    ds = rec['datasets']
    check('deposit has all three rigs', {'slap8', 'md10', 'calib18'} <= set(ds),
          f'{sorted(ds)}')
    EXPECT_CAMS = {'slap8': 8, 'md10': 5, 'calib18': 18}
    for k, n in EXPECT_CAMS.items():
        if k in ds:
            check(f'{k} has {n} cameras', ds[k]['n_cameras'] == n, f'{ds[k]["n_cameras"]}')
    for k in ('slap8', 'md10', 'calib18'):
        if k in ds:
            arms = ds[k]['detsets']['anipose']['arms']
            check(f'{k} has both arms', {'calibrat3_800', 'anipose'} <= set(arms),
                  f'{sorted(arms)}')
    # The OpenCV pin is the reason every number moved; a deposit that does not record
    # it cannot be told apart from the mixed-version one it replaced.
    check('deposit records the OpenCV version', bool(rec.get('opencv')), f'{rec.get("opencv")!r}')
    if 'calib18' in ds:
        abl = ds['calib18'].get('ablation', {})
        check('ablation has an all-frames block', bool(abl.get('all')))
        check('ablation has a held-out block', bool(abl.get('heldout')),
              'panel g silently drops its open rings and mis-states its legend without it')

# ---- the caption and the text ----------------------------------------------------
TEX = os.path.join(HERE, 'figures', 'drafts', 'latex_newest.tex')
if not os.path.exists(TEX):
    check('manuscript draft found', False, TEX)
else:
    tex = open(TEX).read()
    check("no LaTeX acute accent where an apostrophe was meant", "\\'s" not in tex,
          "\\'s typesets as an accented s")
    i = tex.find(r'\caption{\textbf{Calibration accuracy of calibrat3 and Anipose')
    check('fig8 caption found', i >= 0)
    if i >= 0:
        cap = tex[i:tex.index('\\label{fig8}', i)]
        for l in letters:
            check(f'caption describes panel {l.upper()}', f'\\textbf{{{l.upper()}}}' in cap)
        # "A to X are scored on Anipose's detections" must stop before the first panel
        # that is not scored at all. Timing is wall clock and the synthetic panel is
        # compared to known cameras, so both are outside the range. This exact claim
        # has now been wrong twice, at two different letterings.
        NOT_SCORED = {'runtime', 'ground_truth'}
        last_scored = max(l for l in letters if slugs[l] not in NOT_SCORED)
        # Matches the range wherever it is phrased, not one fixed sentence.
        m = re.search(r'\bA to ([A-Z])\b', cap)
        check('caption scored-range stops at the last scored panel',
              bool(m) and m.group(1) == last_scored.upper(),
              f'caption says {m.group(1) if m else "?"}, last scored panel is '
              f'{last_scored.upper()} ({slugs[last_scored]})')
        for bad in (' -- ', '\u2014', ';'):
            check(f'caption free of {bad.strip() or "em dash"!r}', bad not in cap)
        # Caption numbers against the deposit: the failure mode is a number that was
        # right when it was written and was never revisited.
        if os.path.exists(dep):
            for key, name in (('slap8', 'SLAP-2M'), ('md10', 'Mouse-Dyad-10M'),
                              ('calib18', '18-camera')):
                if key not in ds:
                    continue
                a = ds[key]['detsets']['anipose']['arms']
                for arm in ('calibrat3_800', 'anipose'):
                    med = a[arm]['overall']['med']
                    want = f'{med:.2f}'
                    check(f'caption quotes {key} {arm} median {want}', want in cap,
                          f'deposit says {med:.4f}')
    # Every \ref in the calibration block must resolve, or it prints as ??
    blk_i = tex.find(r'\subsection{Calibration benchmark}')
    if blk_i >= 0:
        blk = tex[blk_i:tex.find(r'\begin{figure}', blk_i)]
        for lab in sorted(set(re.findall(r'\\ref\{([a-z0-9-]+)\}', blk))):
            check(f'\\ref{{{lab}}} resolves', f'\\label{{{lab}}}' in tex)

print(f'\n{len(PASS)} passed, {len(FAIL)} failed')
if FAIL:
    print('FAILED:')
    for f in FAIL:
        print(f'  - {f}')
sys.exit(1 if FAIL else 0)
