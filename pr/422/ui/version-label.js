// ui/version-label.js — which build this is, at the right end of the menu bar,
// beside Settings: "v1.0.5" on the live page.
//
// Nothing in the repo knows a version number. scripts/stamp-version.mjs fills
// two <meta> tags in the DEPLOYED copy of index.html (never the working tree):
// `lucid-commit`, the commit the copy was built from, and `lucid-release`, the
// label the deploy workflow chose — the release tag when the deployed ref IS a
// release tag, `dev` for a push to main, `PR #<n>` for a preview. A tag says
// everything; anything else gets the commit beside it, because `dev` alone
// cannot tell two deploys apart and that is exactly what someone checking for
// a stale cache needs to see. A working tree served locally has both tags
// empty, so the label stays hidden rather than inventing a number.

/** The deploy workflows' tag format: vX.Y.Z, or vX.Y.Z-N for a pre-release. */
const RELEASE_TAG = /^v\d+\.\d+\.\d+(-\d+)?$/;

/**
 * What the label says, and its tooltip, for a stamped release label and
 * commit; null when nothing was stamped.
 * @returns {{text: string, title: string} | null}
 */
export function formatVersionLabel(release, commit) {
    release = (release || '').trim();
    commit = (commit || '').trim();
    const of = commit ? ` (commit ${commit})` : '';
    if (RELEASE_TAG.test(release)) return { text: release, title: `LUCID ${release}${of}` };
    const short = commit.slice(0, 8);
    if (release) return { text: short ? `${release} · ${short}` : release, title: `LUCID ${release} build${of}` };
    if (short) return { text: short, title: `LUCID build${of}` };
    return null;
}

/** Fill #menuBarVersion from the stamped <meta> tags, or hide it if there are none. */
export function showVersionLabel(doc = document) {
    const el = doc.getElementById('menuBarVersion');
    if (!el) return;
    const meta = (name) => doc.querySelector(`meta[name="${name}"]`)?.content || '';
    const label = formatVersionLabel(meta('lucid-release'), meta('lucid-commit'));
    el.textContent = label ? label.text : '';
    el.title = label ? label.title : '';
    el.hidden = !label;
}
