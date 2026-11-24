/**
 * track-setup.js — answer the dialog Track All / Track Frame open the first
 * time they run on a session (ui/track-setup-modal.js: the animal count, with
 * the node weights for review). It replaced a native `prompt()`, which tests
 * answered with `page.on('dialog', d => d.accept('2'))`; this is the one-line
 * replacement for that.
 *
 * Node-side (Playwright), unlike its neighbours: it installs a page script
 * that watches for the dialog and, whenever one opens, types `animals` into
 * the count and clicks Continue — leaving the node weights as shown. It covers
 * every later navigation of the page (`addInitScript`) and the document
 * already loaded, and calling it again only changes the answer.
 */

/**
 * @param {import('playwright').Page} page
 * @param {string|number} animals  the count to type; '' answers auto-detect
 */
export async function answerTrackSetup(page, animals) {
    const install = (answer) => {
        window.__trackSetupAnswer = answer;
        if (window.__trackSetupWatcher) return;
        window.__trackSetupWatcher = new MutationObserver(() => {
            const modal = document.querySelector('.track-setup-modal');
            if (!modal || modal.dataset.autoAnswered) return;
            modal.dataset.autoAnswered = '1';
            const input = modal.querySelector('#trackSetupAnimals');
            input.value = window.__trackSetupAnswer;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            modal.querySelector('#trackSetupContinue').click();
        });
        window.__trackSetupWatcher.observe(document, { childList: true, subtree: true });
    };
    const answer = String(animals == null ? '' : animals);
    await page.addInitScript(install, answer);
    // The document already loaded, if there is one (about:blank before the
    // first goto is fine too: the init script covers what comes after it).
    await page.evaluate(install, answer).catch(() => {});
}
