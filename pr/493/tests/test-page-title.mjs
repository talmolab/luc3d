/**
 * test-page-title.mjs — the browser tab's title (`ui/page-title.js`).
 *
 * "LUC3D" with nothing open, "<project> - LUC3D" once a project is, and a
 * leading "• " while there are unsaved changes. The module is import-free so
 * Node can load it; `document` is stubbed to watch what it writes.
 */
import { APP_TITLE, formatPageTitle, setPageProject, setPageDirty, pageProjectName }
    from '../ui/page-title.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const eq = (got, want, msg) => check(got === want, `${msg} (got ${JSON.stringify(got)})`);

console.log('\n1. formatPageTitle');
eq(APP_TITLE, 'LUC3D', 'the app name');
eq(formatPageTitle(null, false), 'LUC3D', 'nothing open');
eq(formatPageTitle('', false), 'LUC3D', 'an empty name is no name');
eq(formatPageTitle('   ', false), 'LUC3D', 'a blank name is no name');
eq(formatPageTitle(null, true), '• LUC3D', 'nothing open, unsaved');
eq(formatPageTitle('cage5.slp', false), 'cage5.slp - LUC3D', 'a project file');
eq(formatPageTitle(' rec_01 ', true), '• rec_01 - LUC3D', 'a folder, unsaved, trimmed');

console.log('\n2. setPageProject / setPageDirty write document.title');
globalThis.document = { title: 'LUC3D' };
setPageProject('cage5.slp');
eq(document.title, 'cage5.slp - LUC3D', 'opening a project names the tab');
eq(pageProjectName(), 'cage5.slp', 'pageProjectName reads it back');
setPageDirty(true);
eq(document.title, '• cage5.slp - LUC3D', 'an edit adds the dot, keeps the name');
setPageProject('cage5-copy.slp');
eq(document.title, '• cage5-copy.slp - LUC3D', 'a rename keeps the dot');
setPageDirty(false);
eq(document.title, 'cage5-copy.slp - LUC3D', 'a save drops the dot');
setPageProject(null);
eq(document.title, 'LUC3D', 'closing the project');
eq(pageProjectName(), null, 'no project name');
setPageProject('   ');
eq(pageProjectName(), null, 'a blank name stores none');
delete globalThis.document;
setPageDirty(false); // no document: no throw

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
