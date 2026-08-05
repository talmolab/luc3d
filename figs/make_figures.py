#!/usr/bin/env python3
"""
Build every panel, then assemble the composites.

    python3 figs/make_figures.py            # everything
    python3 figs/make_figures.py 2 4        # only figures 2 and 4
    python3 figs/make_figures.py --panels   # panels only, no assembly

Each panel script is run in its own subprocess. That is deliberate: they set
rcParams globally via `src.style.use()`, and a panel that leaves state behind must
not be able to change how the next one renders. It also means one broken panel
reports and the rest still build.

This does NOT run the measurement pass. `figs/out/*.json` and the app screenshots
come from the Playwright drivers and the bench scripts -- see figs/README.md.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

FIGS = Path(__file__).resolve().parent
PANELS = FIGS / "panels"


def panel_scripts(only: set[int] | None):
    for p in sorted(PANELS.glob("fig*_*.py")):
        m = re.match(r"fig(\d+)_", p.name)
        if m and (only is None or int(m.group(1)) in only):
            yield int(m.group(1)), p


def main(argv):
    do_assemble = "--panels" not in argv
    nums = {int(a) for a in argv if a.isdigit()} or None

    ok, failed = [], []
    for _, p in panel_scripts(nums):
        print(f"{p.name}")
        r = subprocess.run([sys.executable, str(p)], capture_output=True, text=True)
        if r.returncode:
            failed.append(p.name)
            # Show the real reason, not just a name: most failures here are a
            # missing figs/out/*.json, which the panel scripts explain precisely.
            tail = (r.stderr or r.stdout).strip().splitlines()[-4:]
            for line in tail:
                print(f"    ! {line}")
        else:
            ok.append(p.name)
            for line in r.stdout.strip().splitlines():
                print(line)

    if do_assemble:
        print("\nassembling")
        import assemble
        assemble.main([str(n) for n in sorted(nums)] if nums else [])

    print(f"\n{len(ok)} panels built, {len(failed)} failed")
    for f in failed:
        print(f"  FAILED {f}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.path.insert(0, str(FIGS))
    sys.exit(main(sys.argv[1:]))
