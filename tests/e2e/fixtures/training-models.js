/**
 * Shared by the Training panel e2e tests: the Models modal (Training ▸ Edit models…, `ui/training-models-modal.js`)
 * holds every model's settings and the run settings; the panel shows a summary. These open it, apply it, and set
 * the (first) model's type through it.
 */

/** Open the Models modal; `o.run`: through the Run summary's Edit (the Run settings fold opens). */
export async function openModels(page, o) {
    await page.click(o && o.run ? '#trnEditRun' : '#trnEditModels');
    await page.waitForSelector('#trnModelsModal');
    if (o && o.run) await page.waitForFunction(() => document.getElementById('trnMmRunFold').open);
}

/** Apply the modal's edits and wait for it to close. */
export async function applyModels(page) {
    await page.click('#trnMmApply');
    await page.waitForFunction(() => !document.getElementById('trnModelsModal'));
}

/** Set the shown model's Model Type in the modal and apply. */
export async function setModelType(page, type) {
    await openModels(page);
    await page.selectOption('#trnModelType', type);
    await applyModels(page);
}

/** Set a number field of the shown model in the open modal (e.g. '#trnMaxEpochs'). */
export async function setModelNumber(page, sel, value) {
    await page.fill(sel, String(value));
    await page.dispatchEvent(sel, 'change');
}
