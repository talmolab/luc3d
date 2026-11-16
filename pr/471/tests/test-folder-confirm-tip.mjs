/**
 * test-folder-confirm-tip.mjs — who sees the macOS folder-confirm tip
 * (ui/folder-confirm-tip.js).
 *
 * The tip exists because Chromium's folder prompts default to Cancel and, on
 * a Mac, Tab reaches the other button only with Keyboard navigation on — a
 * setting no page can read. So the rule is: a Chromium browser on macOS, not
 * automated, and not dismissed. The module touches the DOM only when the tip
 * is SHOWN, so Node can import it. The modal itself is covered by
 * tests/e2e/folder-confirm-tip.mjs.
 */
import {
    isChromiumOnMac, shouldShowFolderConfirmTip, FOLDER_TIP_STORAGE_KEY,
} from '../ui/folder-confirm-tip.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};

const nav = (platform, extra) => Object.assign(
    platform === undefined ? {} : { userAgentData: { platform } }, extra || {});
const store = (value) => ({
    getItem: (k) => (k === FOLDER_TIP_STORAGE_KEY ? value : null),
    setItem: () => {},
});
const throwing = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); },
};

console.log('\n1. Platform');
check(isChromiumOnMac(nav('macOS')) === true, 'Chromium on macOS');
check(isChromiumOnMac(nav('Windows')) === false, 'Chromium on Windows: no');
check(isChromiumOnMac(nav('Linux')) === false, 'Chromium on Linux: no');
check(isChromiumOnMac(nav(undefined)) === false, 'no userAgentData (Safari, Firefox): no');

console.log('\n2. Whether to show it');
check(shouldShowFolderConfirmTip(nav('macOS'), store(null)) === true, 'Mac, never dismissed: shown');
check(shouldShowFolderConfirmTip(nav('macOS'), store('1')) === false, 'Mac, dismissed: not shown');
check(shouldShowFolderConfirmTip(nav('Windows'), store(null)) === false, 'Windows: not shown');
check(shouldShowFolderConfirmTip(nav('macOS', { webdriver: true }), store(null)) === false,
    'automated Mac browser: not shown (the e2e suites would stall on it)');
check(shouldShowFolderConfirmTip(nav('macOS'), throwing) === true,
    'storage that throws (private window): shown, not an exception');

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
