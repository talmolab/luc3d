/**
 * ui/connect/pair-worker-form.js — the "Pair with a worker" form.
 *
 * Port of sleap-app src/components/connect/PairWorkerForm.tsx @ 683a159: paste
 * the one-line code `sleap-connect serve` printed (or a legacy JSON ticket);
 * the live plan line (`planPairingForText`, the store's `readCodeInfo` +
 * `planPairing`) says how it will connect; the address box stays under
 * "Advanced: connect by address" unless the code can't be used without one;
 * Pair calls the store's `pairWithCode`. Every string is sleap-app's.
 *
 * LUCID changes: vanilla DOM instead of React (state lives in the closure, one
 * stale-guarded async plan per keystroke); `pairWithCode` (read + plan + pair
 * in one store action) in place of `pairWithTicket` + the form's own plan.
 *
 * `reset()` returns the form to its first state (empty boxes, no plan line,
 * Advanced closed, no error): sleap-app UNMOUNTS the form on Cancel / once a
 * worker is paired, so reopening it starts blank; the panel calls `reset()`
 * whenever the form is hidden.
 *
 * LUCID addition (not in sleap-app): Enter in either box pairs when Pair is
 * enabled (LUCID's keyboard convention for dialogs and forms).
 *
 * The iroh cases of sleap-app's `pairWorkerFormIroh.test.tsx` (relay code ->
 * iroh route, typed address over a relay code -> ws) need the desktop iroh
 * transport and belong to P8; the web build only plans `ws`.
 *
 * Used by `ui/connect/connect-panel.js` (and, later, the Connect window).
 */
import { useConnectStore, planPairingForText } from '../../pose/connect/store.js';
import { railIconSvg } from '../panel-rail-icons.js';

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function icon(name, cls) {
    const s = el('span', 'connect-icon' + (cls ? ' ' + cls : ''));
    s.innerHTML = railIconSvg(name);
    return s;
}

function codeTag(text) {
    return el('code', 'connect-code', text);
}

/**
 * @param {{onPaired?: () => void, onCancel?: () => void, showCancel?: boolean}} [opts]
 * @returns {{el: HTMLElement, setShowCancel: (v: boolean) => void, reset: () => void}}
 */
export function createPairWorkerForm(opts) {
    opts = opts || {};
    let showCancel = !!opts.showCancel;
    let advancedOpen = false;
    let pairing = false;
    let pairError = null;
    let plan = null;           // null = nothing pasted yet
    let planSeq = 0;
    let resetGen = 0;          // a pairing that finishes after reset() must not touch the blank form

    const root = el('div', 'connect-card connect-pair-form');
    root.appendChild(el('h3', 'connect-card-title', 'Pair with a worker'));

    const help = el('p', 'connect-hint');
    help.append('Paste the code ', codeTag('sleap-connect serve'),
        ' printed on the worker, or get a new one there with ', codeTag('sleap-connect pair'), '.');
    root.appendChild(help);

    const codeInput = el('input', 'connect-input connect-mono');
    codeInput.type = 'text';
    codeInput.id = 'connectPairCode';
    codeInput.placeholder = 'sleap1…';
    codeInput.setAttribute('aria-label', 'Pairing code');
    codeInput.autocomplete = 'off';
    codeInput.spellcheck = false;
    root.appendChild(codeInput);

    const planLine = el('p', 'connect-plan');
    planLine.id = 'connectPairPlan';
    root.appendChild(planLine);

    const advBtn = el('button', 'connect-link-btn');
    advBtn.type = 'button';
    advBtn.id = 'connectPairAdvanced';
    const advChevron = icon('chevron-right', 'connect-chevron');
    advBtn.appendChild(advChevron);
    advBtn.append('Advanced: connect by address');
    root.appendChild(advBtn);

    const addrWrap = el('div', 'connect-addr');
    const addrLabel = el('label', 'connect-hint', 'Worker address (e.g. its Tailscale IP)');
    addrLabel.htmlFor = 'connectPairAddress';
    const addrInput = el('input', 'connect-input connect-mono');
    addrInput.type = 'text';
    addrInput.id = 'connectPairAddress';
    addrInput.placeholder = 'ws://192.168.1.42:9631';
    addrInput.autocomplete = 'off';
    addrInput.spellcheck = false;
    addrWrap.append(addrLabel, addrInput);
    root.appendChild(addrWrap);

    const errLine = el('p', 'connect-error-text');
    errLine.id = 'connectPairError';
    root.appendChild(errLine);

    const row = el('div', 'connect-btn-row');
    const pairBtn = el('button', 'connect-btn connect-btn-primary connect-grow');
    pairBtn.type = 'button';
    pairBtn.id = 'connectPairBtn';
    const cancelBtn = el('button', 'connect-btn connect-btn-ghost', 'Cancel');
    cancelBtn.type = 'button';
    cancelBtn.id = 'connectPairCancel';
    row.append(pairBtn, cancelBtn);
    root.appendChild(row);

    function render() {
        // Plan line: ready = green check + detail, needs-address = amber alert + reason, error = red x + message.
        planLine.textContent = '';
        planLine.hidden = !plan;
        if (plan) {
            const [ic, cls, text] = plan.kind === 'ready'
                ? ['circle-check', 'connect-ok', plan.detail]
                : plan.kind === 'needs-address'
                    ? ['triangle-alert', 'connect-warn', plan.reason]
                    : ['circle-x', 'connect-bad', plan.message];
            planLine.className = 'connect-plan ' + cls;
            planLine.dataset.kind = plan.kind;
            planLine.appendChild(icon(ic));
            planLine.appendChild(el('span', '', text));
        }
        const needsAddr = !!plan && plan.kind === 'needs-address';
        const showAddress = advancedOpen || needsAddr;
        advBtn.hidden = needsAddr;
        advBtn.classList.toggle('open', showAddress);
        addrWrap.hidden = !showAddress;
        errLine.hidden = !pairError;
        errLine.textContent = pairError || '';
        // Not editable while pairing: what is typed now would be wiped when it finishes.
        codeInput.readOnly = pairing;
        addrInput.readOnly = pairing;
        pairBtn.disabled = pairing || !plan || plan.kind !== 'ready';
        pairBtn.textContent = '';
        if (pairing) pairBtn.appendChild(icon('loader-circle', 'connect-spin'));
        pairBtn.append(pairing ? 'Pairing…' : 'Pair');
        cancelBtn.hidden = !showCancel;
    }

    // Async (a code's checksum check needs Web Crypto): a stale plan for a
    // since-edited value must never overwrite a newer one.
    function replan() {
        const n = ++planSeq;
        // Editing is a new attempt: the last attempt's failure no longer applies.
        if (pairError) { pairError = null; render(); }
        const text = codeInput.value;
        if (!text.trim()) {
            plan = null;
            render();
            return;
        }
        planPairingForText(text, addrInput.value).then(function (p) {
            if (n !== planSeq) return;
            plan = p;
            render();
        });
    }

    codeInput.addEventListener('input', replan);
    addrInput.addEventListener('input', replan);
    advBtn.addEventListener('click', function () { advancedOpen = !advancedOpen; render(); });
    cancelBtn.addEventListener('click', function () { if (opts.onCancel) opts.onCancel(); });
    function submitOnEnter(e) {
        if (e.key === 'Enter' && !pairBtn.disabled) { e.preventDefault(); pairBtn.click(); }
    }
    codeInput.addEventListener('keydown', submitOnEnter);
    addrInput.addEventListener('keydown', submitOnEnter);

    pairBtn.addEventListener('click', async function () {
        if (!plan || plan.kind !== 'ready' || pairing) return;
        pairing = true;
        pairError = null;
        const gen = resetGen;
        render();
        try {
            await useConnectStore.getState().pairWithCode(codeInput.value.trim(), addrInput.value.trim() || undefined);
            if (gen !== resetGen) return;
            codeInput.value = '';
            addrInput.value = '';
            advancedOpen = false;
            plan = null;
            planSeq++;
            pairing = false;
            render();
            if (opts.onPaired) opts.onPaired();
        } catch (err) {
            if (gen !== resetGen) return;
            pairError = err instanceof Error ? err.message : 'Failed to pair with worker';
            pairing = false;
            render();
        }
    });

    render();
    return {
        el: root,
        reset: function () {
            resetGen++;
            planSeq++;
            codeInput.value = '';
            addrInput.value = '';
            advancedOpen = false;
            pairing = false;
            pairError = null;
            plan = null;
            render();
        },
        setShowCancel: function (v) { showCancel = !!v; render(); },
    };
}
