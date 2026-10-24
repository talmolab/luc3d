/**
 * ui/recording-info.js — the Session tab's "Recording" section: what a campy
 * recording's session.json says about it.
 *
 * Shown only for a session loaded from a campy recording folder
 * (`session.campyRecording`, read by `adoptCampyRecording` in
 * `loading/session-loader.js` from `loading/campy-session.js`); hidden for
 * every other session. It lists the recording's status (in the warning colour
 * unless "complete"), the experiment's name, animal IDs, notes and other
 * fields, the notes added afterwards, the frame rate and where it came from,
 * campy's version and start time, each camera's serial and video, and whether
 * the loaded calibration is the one campy-live tracked with.
 *
 * Animal IDs are display only: campy-live numbers animals in the order it
 * first matches them, so they never name LUC3D's identities.
 *
 * Its open/closed state is browser-local (`persistSectionState`), set once at
 * setup. Nothing here is written to the .slp.
 */
import {
    describeCampyStatus, calibrationMismatchText,
} from '../loading/campy-session.js?v=32e09b7b47a1';
import { persistSectionState } from './section-state.js?v=32e09b7b47a1';
import { setInfoTip } from './info-tip.js?v=32e09b7b47a1';
// Only read inside a function body, so the import cycle through the info
// panel is hoist-safe.
import { ICON_INFO } from './plane-definition.js?v=32e09b7b47a1';

export const RECORDING_SECTION_ID = 'recordingInfoSection';
const RECORDING_SECTIONS_KEY = 'recordingSectionOpen';

export const ANIMAL_IDS_INFO =
    'The animals campy recorded. LUC3D does not match them to its identities: ' +
    'campy-live numbers animals in the order it first finds them, which says ' +
    'nothing of which animal is which.';

/** Restore the section's open/closed state. Call once, at setup. */
export function setupRecordingInfo() {
    persistSectionState(RECORDING_SECTION_ID, RECORDING_SECTIONS_KEY);
}

/** campy's ISO time ("2026-10-23T14:05:11-04:00") as "2026-10-23 14:05:11". */
export function formatCampyTime(at) {
    if (!at) return '';
    return String(at).replace('T', ' ').replace(/(\.\d+)?([+-]\d\d:?\d\d|Z)?$/, '');
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
}

function row(body, label, value, cls) {
    const r = el('div', 'session-info-row recording-row' + (cls ? ' ' + cls : ''));
    r.appendChild(el('span', 'label', label));
    const v = el('span', 'value', value);
    r.appendChild(v);
    body.appendChild(r);
    return r;
}

function block(body, label, text, cls) {
    const b = el('div', 'recording-block' + (cls ? ' ' + cls : ''));
    if (label) b.appendChild(el('div', 'recording-block-label', label));
    if (text) b.appendChild(el('div', 'recording-block-text', text));
    body.appendChild(b);
    return b;
}

function fpsText(fps) {
    return (Math.round(fps * 1000) / 1000).toLocaleString('en-US') + ' fps';
}

/**
 * Fill (or hide) the Recording section for `session`.
 *
 * @param {Session|null} session
 */
export function renderRecordingInfo(session) {
    const section = document.getElementById(RECORDING_SECTION_ID);
    if (!section) return;
    const body = document.getElementById('recordingInfoBody');
    const rec = session && session.campyRecording;
    if (!rec) {
        section.hidden = true;
        if (body) body.textContent = '';
        return;
    }
    section.hidden = false;
    body.textContent = '';

    const st = describeCampyStatus(rec);
    row(body, 'Status', st.label, st.ok ? '' : 'recording-warn');
    if (st.detail) block(body, null, st.detail, 'recording-warn');

    const exp = rec.experiment;
    if (exp.name) row(body, 'Experiment', exp.name);
    if (exp.animalIds.length) {
        const r = row(body, 'Animal IDs', exp.animalIds.join(', '));
        const btn = el('button', 'plane-section-info recording-info-btn');
        btn.type = 'button';
        btn.id = 'recordingAnimalIdsInfo';
        btn.innerHTML = ICON_INFO;
        setInfoTip(btn, ANIMAL_IDS_INFO);
        r.querySelector('.label').appendChild(btn);
    }
    if (exp.notes) block(body, 'Notes', exp.notes);
    exp.fields.forEach(function (f) { row(body, f[0], f[1], 'recording-field'); });

    if (rec.annotations.length) {
        const b = block(body, 'Annotations');
        const list = el('ul', 'recording-annotations');
        rec.annotations.forEach(function (a) {
            const li = el('li');
            if (a.at) li.appendChild(el('span', 'recording-annotation-at', formatCampyTime(a.at)));
            li.appendChild(el('span', 'recording-annotation-text', a.text));
            list.appendChild(li);
        });
        b.appendChild(list);
    }

    if (rec.frameRate) {
        row(body, 'Frame rate', fpsText(rec.frameRate) + ' (session.json)');
        if (rec.videoFrameRate) {
            block(body, null, 'The video says ' + fpsText(rec.videoFrameRate)
                + '; LUC3D uses the rate in session.json.', 'recording-warn');
        }
    }
    if (rec.startedAt) row(body, 'Started', formatCampyTime(rec.startedAt));
    if (rec.campyVersion) row(body, 'campy', rec.campyVersion);

    const cc = rec.calibrationCheck;
    if (cc && cc.matches) {
        row(body, 'Calibration', 'same as campy-live\'s');
    } else if (cc) {
        block(body, 'Calibration', calibrationMismatchText(cc) + '.', 'recording-warn');
    }
    const cm = rec.cameraMismatch;
    if (cm) {
        const parts = [];
        if (cm.onlyInRecording.length) parts.push('In session.json but not the calibration: ' + cm.onlyInRecording.join(', ') + '.');
        if (cm.onlyInCalibration.length) parts.push('In the calibration but not session.json: ' + cm.onlyInCalibration.join(', ') + '.');
        block(body, 'Cameras', parts.join(' '), 'recording-warn');
    }

    if (rec.cameras.length) {
        const table = el('table', 'data-table recording-cameras');
        const head = el('tr');
        ['Camera', 'Serial', 'Video'].forEach(function (h) { head.appendChild(el('th', null, h)); });
        const thead = el('thead');
        thead.appendChild(head);
        table.appendChild(thead);
        const tbody = el('tbody');
        rec.cameras.forEach(function (c) {
            const tr = el('tr');
            tr.appendChild(el('td', null, c.name));
            tr.appendChild(el('td', 'mono', c.serial || '—'));
            tr.appendChild(el('td', 'mono', c.video || '—'));
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        body.appendChild(table);
    }
}
