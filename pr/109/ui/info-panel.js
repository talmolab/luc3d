// ui/info-panel.js — info-panel tables (videos, cameras, skeleton, sessions, frame info)
// Pass 3d-2 extraction. Holds the panel-tab switching, every "populate" call
// for the right-hand info panel, the skeleton editor wiring, and the per-frame
// instance-group / unlinked-instance tables (updateFrameInfo).

import {
    Skeleton, Camera, Session,
} from '../pose/pose-data.js';
import { getInstanceGroupsForFrame } from '../pose/triangulation.js';
import { REPROJECTION_COLOR, getTrackColor } from './overlays.js';
import { drawAllOverlays, updateFrameCounters } from './rendering.js';
import { isInteractiveClickTarget } from './interaction.js';
import { state, timeline, interactionManager, rememberSkeleton, buildRememberedSkeleton } from './app-state.js';
import { setStatus, markDirty } from '../import-export/save-load.js';
import { buildSkeletonJSON, parseSkeletonJSON } from '../import-export/skeleton-json.js';
import {
    handleLoadVideos, handleLoadCalibration, autoAssignVideosToCameras,
    createViewForVideoFile, rebuildVideoController, fitCanvasesToCells,
    loadSingleSessionFromCache,
} from '../loading/session-loader.js';

// Circular import — these are still defined in app.js for now. They will be
// retargeted as later passes land:
// - swapAssignTrack, propagateIdentityForward, unlinkGroup, showGroupContextMenu
//   → ui/identity-assignment.js (Pass 3f)
// Pass 3e-1: unlinkGroup + showGroupContextMenu moved to ui-wiring.js.
import { unlinkGroup, showGroupContextMenu } from './ui-wiring.js';
// Pass 3f: swapAssignTrack + propagateIdentityForward moved to identity-assignment.js.
import { swapAssignTrack, propagateIdentityForward } from './identity-assignment.js';
// Pass 3h: populateSessionsPanel / populateViewStrip / populateSessionStrip moved to sessions-panes.js.
import {
    populateSessionsPanel, populateViewStrip, populateSessionStrip,
} from './sessions-panes.js';
// Block 2 (Prompt 4): per-session timeline visibility toggles.
import {
    toggleCameraVisibility,
    toggleTrackVisibility,
    toggleIdentityVisibility,
    getCameraVisibilityList,
    getTrackVisibilityList,
    getIdentityVisibilityList,
} from './timeline-visibility.js';

// ============================================
// Inline name entry for "+ New Track" / "+ New ID"
// ============================================

// Replace a track/identity <select> with an inline text box so the user can
// type a new name and accept it with Enter (Esc or blur cancels). On commit,
// onCommit(name) is responsible for creating + assigning and re-rendering the
// panel (which restores the normal <select>); on cancel we just re-render.
function startInlineNameEntry(selectEl, defaultName, onCommit) {
    var input = document.createElement('input');
    input.type = 'text';
    input.value = defaultName;
    input.style.cssText = selectEl.style.cssText;
    selectEl.replaceWith(input);
    input.focus();
    input.select();

    var done = false;
    function finish(commit) {
        if (done) return;
        done = true;
        var name = input.value.trim();
        if (commit && name) {
            onCommit(name);
        } else {
            // Cancel — rebuild the panel to restore the original dropdown.
            updateInfoPanel();
        }
    }
    input.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function () { finish(false); });
    input.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('mousedown', function (e) { e.stopPropagation(); });
}

// ============================================
// Panel tab switching
// ============================================

export function setupPanelTabs() {
    const tabs = document.querySelectorAll('.panel-tab');
    tabs.forEach(function (tab) {
        tab.addEventListener('click', function () {
            // Deactivate all
            tabs.forEach(function (t) { t.classList.remove('active'); });
            document.querySelectorAll('.panel-tab-content').forEach(function (c) {
                c.classList.remove('active');
            });
            // Activate clicked
            tab.classList.add('active');
            const target = document.getElementById(tab.getAttribute('data-tab'));
            if (target) target.classList.add('active');
        });
    });
}

// ============================================
// Block 2 (Prompt 4): Timeline visibility toggles (Visibility tab)
// ============================================

/**
 * Build a single Views / Tracks / Identities toggle row.
 *
 * @param {{name:string, visible:boolean, color?:string}} entry
 * @param {function(string):void} onChange  Called with `entry.name` when
 *     the checkbox changes; the caller is expected to flip the relevant
 *     hidden-set, refresh the timeline, and re-render this list.
 * @param {{ showColor?: boolean }} [opts]
 */
function buildVisToggleRow(entry, onChange, opts) {
    var showColor = !!(opts && opts.showColor && entry.color);
    // Outer wrapper is a div (not a label) so the inner toggle-switch
    // <label> is the sole click-target. Hover styling lives in styles.css.
    var row = document.createElement('div');
    row.className = 'vis-toggle-row';
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:2px 4px;font-size:11px;';

    if (showColor) {
        var swatch = document.createElement('span');
        swatch.className = 'vis-color-swatch';
        swatch.style.cssText = 'display:inline-block;width:10px;height:10px;border-radius:2px;background:' + entry.color + ';flex-shrink:0;';
        row.appendChild(swatch);
    }

    var lbl = document.createElement('span');
    lbl.className = 'vis-toggle-label';
    lbl.textContent = entry.name;
    // Truncate long names with ellipsis so the toggle-switch stays
    // fully visible on the right edge of narrow Info Panel widths.
    lbl.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    row.appendChild(lbl);

    // Toggle-switch on the right (matches the "Select All Videos" pattern
    // elsewhere in the Visibility tab — cleaner than a bare checkbox).
    var toggle = document.createElement('label');
    toggle.className = 'toggle-switch';
    toggle.style.cssText = 'margin-left:auto;';

    var input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('data-name', entry.name);
    if (entry.visible) input.checked = true;
    input.addEventListener('change', function () {
        onChange(entry.name);
    });
    toggle.appendChild(input);

    var slider = document.createElement('span');
    slider.className = 'slider';
    toggle.appendChild(slider);

    row.appendChild(toggle);

    return row;
}

/**
 * Populate the Visibility-tab Timeline section's three toggle lists:
 *   - Views  (one row per camera)
 *   - Tracks (one row per track)
 *   - Identities (one row per identity, with a color swatch)
 *
 * Source-of-truth is the session itself (live read each call) so newly
 * added entries appear immediately and deleted ones drop out. Toggling
 * a checkbox flips the per-session hidden-set, calls the existing
 * `timeline.refreshTracks` path to re-render the timeline, and recurses
 * into this function so the new checked-state is reflected.
 *
 * @param {Session} session
 */
export function populateTimelineVisibility(session) {
    var hostCams = document.getElementById('visTimelineCameras');
    var hostTracks = document.getElementById('visTimelineTracks');
    var hostIds = document.getElementById('visTimelineIdentities');
    if (!hostCams || !hostTracks || !hostIds) return;

    hostCams.innerHTML = '';
    hostTracks.innerHTML = '';
    hostIds.innerHTML = '';

    if (!session) return;

    var camList = getCameraVisibilityList(session);
    var trackList = getTrackVisibilityList(session);
    var idList = getIdentityVisibilityList(session);

    function refreshAfterChange() {
        if (timeline && typeof timeline.refreshTracks === 'function') {
            // `keepSize: true` — visibility toggles must not resize the
            // outer container OR the inner canvas. Without this, hiding
            // rows would let `resize()` shrink the canvas (via the
            // `max(natural, availableH)` term going down with fewer
            // rows), pulling the playhead / markers / frame labels up
            // and visibly "shortening" the timeline even though the
            // outer frame is unchanged.
            try { timeline.refreshTracks(session, { keepSize: true }); }
            catch (e) { /* non-fatal */ }
        }
        populateTimelineVisibility(session);
    }

    var i;
    for (i = 0; i < camList.length; i++) {
        hostCams.appendChild(buildVisToggleRow(camList[i], function (name) {
            toggleCameraVisibility(session, name);
            refreshAfterChange();
        }));
    }
    for (i = 0; i < trackList.length; i++) {
        // `getTrackVisibilityList` returns names in the same order as
        // `session.tracks`, so the list index is the trackIdx that
        // `getTrackColor` uses for its palette lookup. Mirrors what the
        // timeline canvas itself paints next to each track row, and
        // matches the swatch behavior already in place for identities.
        trackList[i].color = getTrackColor(i);
        hostTracks.appendChild(buildVisToggleRow(trackList[i], function (name) {
            toggleTrackVisibility(session, name);
            refreshAfterChange();
        }, { showColor: true }));
    }
    for (i = 0; i < idList.length; i++) {
        hostIds.appendChild(buildVisToggleRow(idList[i], function (name) {
            toggleIdentityVisibility(session, name);
            refreshAfterChange();
        }, { showColor: true }));
    }
}

// ============================================
// Videos table
// ============================================

export function populateVideosTable() {
    const tbody = document.querySelector('#videosTable tbody');
    const empty = document.getElementById('videosEmpty');
    tbody.textContent = '';

    // Use videoFiles if available, otherwise fall back to views
    const videoList = state.videoFiles.length > 0 ? state.videoFiles : state.views.map(function (v) {
        return {
            name: v.name, decoder: v.decoder, videoWidth: v.videoWidth, videoHeight: v.videoHeight,
            frameCount: v.decoder ? v.decoder.samples.length : 0, assignedCamera: v.name
        };
    });

    if (videoList.length === 0) {
        document.getElementById('videosTable').style.display = 'none';
        empty.style.display = '';
        return;
    }

    document.getElementById('videosTable').style.display = '';
    empty.style.display = 'none';

    videoList.forEach(function (vf, i) {
        const tr = document.createElement('tr');
        tr.addEventListener('click', function () {
            tbody.querySelectorAll('tr').forEach(function (r) { r.classList.remove('selected'); });
            tr.classList.add('selected');
            document.getElementById('btnRemoveVideo').disabled = false;
            showVideoFileDetail(vf);
        });

        // Name
        const tdName = document.createElement('td');
        tdName.textContent = vf.name;

        // Path
        const tdPath = document.createElement('td');
        tdPath.textContent = vf.videoPath || '';
        tdPath.style.cssText = 'font-size:10px;color:var(--text-muted);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        tdPath.title = vf.videoPath || '';

        // Frames
        const tdFrames = document.createElement('td');
        tdFrames.className = 'mono';
        tdFrames.textContent = vf.frameCount || (vf.decoder ? vf.decoder.samples.length : '-');

        // Size
        const tdSize = document.createElement('td');
        tdSize.className = 'mono';
        tdSize.textContent = vf.videoWidth + 'x' + vf.videoHeight;

        // Labeled frames count - search using camera name (assignedCamera or name)
        var camName = vf.assignedCamera || vf.name;
        let labelCount = 0;
        let groupCount = 0;
        let scoreSum = 0;
        let scoreCount = 0;
        if (state.session) {
            for (const [frameIdx, fg] of state.session.frameGroups) {
                const instances = fg.getInstances(camName);
                const unlinked = fg.getUnlinkedInstances(camName);
                if (instances.length > 0 || unlinked.length > 0) labelCount++;
                for (let j = 0; j < instances.length; j++) {
                    if (instances[j].score > 0) {
                        scoreSum += instances[j].score;
                        scoreCount++;
                    }
                }
            }
            for (const [frameIdx, groups] of state.session.instanceGroups) {
                for (const g of groups) {
                    if (g.getInstance(camName)) groupCount++;
                }
            }
        }

        const tdLabeled = document.createElement('td');
        tdLabeled.className = 'mono';
        tdLabeled.textContent = labelCount;

        const tdGroups = document.createElement('td');
        tdGroups.className = 'mono';
        tdGroups.textContent = groupCount;

        const tdScore = document.createElement('td');
        tdScore.className = 'mono';
        tdScore.textContent = scoreCount > 0 ? (scoreSum / scoreCount).toFixed(2) : '-';

        tr.appendChild(tdName);
        tr.appendChild(tdPath);
        tr.appendChild(tdFrames);
        tr.appendChild(tdSize);
        tr.appendChild(tdLabeled);
        tr.appendChild(tdGroups);
        tr.appendChild(tdScore);
        tbody.appendChild(tr);
    });
}

export function showVideoFileDetail(vf) {
    const div = document.getElementById('videoDetail');
    div.innerHTML = '';

    var camName = vf.assignedCamera || vf.name;
    var labeledFrames = 0, totalInstances = 0, unlinkedCount = 0, userCount = 0, predictedCount = 0, scoreSum = 0, scoreN = 0;
    if (state.session) {
        for (const [frameIdx, fg] of state.session.frameGroups) {
            const instances = fg.getInstances(camName);
            const unlinked = fg.getUnlinkedInstances(camName);
            if (instances.length > 0 || unlinked.length > 0) labeledFrames++;
            totalInstances += instances.length;
            unlinkedCount += unlinked.length;
            for (let j = 0; j < instances.length; j++) {
                if (instances[j].type === 'user') userCount++;
                else predictedCount++;
                if (instances[j].score > 0) { scoreSum += instances[j].score; scoreN++; }
            }
        }
    }

    const rows = [
        ['Name', vf.name],
        ['Resolution', vf.videoWidth + ' x ' + vf.videoHeight + ' px'],
        ['Frames', vf.frameCount || '-'],
        ['Assigned Camera', vf.assignedCamera || 'Unassigned'],
        ['Has View', state.views.some(function (v) { return v.name === camName; }) ? 'Yes' : 'No'],
        ['Labeled frames', labeledFrames],
        ['Instances', totalInstances + ' (user: ' + userCount + ', pred: ' + predictedCount + ')'],
        ['Unlinked', unlinkedCount],
        ['Mean score', scoreN > 0 ? (scoreSum / scoreN).toFixed(3) : '-'],
    ];
    rows.forEach(function (row) {
        var r = document.createElement('div');
        r.className = 'session-info-row';
        var label = document.createElement('span');
        label.className = 'label';
        label.textContent = row[0];
        var value = document.createElement('span');
        value.className = 'value';
        value.style.fontSize = '11px';
        value.textContent = row[1];
        r.appendChild(label);
        r.appendChild(value);
        div.appendChild(r);
    });
}

// ============================================
// Cameras table
// ============================================

export function populateCamerasTable() {
    if (!state.session) return;
    const tbody = document.querySelector('#camerasTable tbody');
    tbody.textContent = '';

    state.session.cameras.forEach(function (cam, i) {
        const tr = document.createElement('tr');
        tr.addEventListener('click', function () {
            // Select row
            tbody.querySelectorAll('tr').forEach(function (r) { r.classList.remove('selected'); });
            tr.classList.add('selected');
            showCameraDetail(cam);
        });

        const tdName = document.createElement('td');
        tdName.textContent = cam.name;

        const tdSize = document.createElement('td');
        tdSize.className = 'mono';
        tdSize.textContent = cam.size[0] + 'x' + cam.size[1];

        const tdFocal = document.createElement('td');
        tdFocal.className = 'mono';
        const fx = cam.matrix[0][0];
        tdFocal.textContent = fx.toFixed(0);

        tr.appendChild(tdName);
        tr.appendChild(tdSize);
        tr.appendChild(tdFocal);
        tbody.appendChild(tr);
    });
}

export function showCameraDetail(cam) {
    const div = document.getElementById('cameraDetail');
    const R = cam.rotationMatrix;
    // Camera position in world: -R^T * t
    const pos = [
        -(R[0][0] * cam.tvec[0] + R[1][0] * cam.tvec[1] + R[2][0] * cam.tvec[2]),
        -(R[0][1] * cam.tvec[0] + R[1][1] * cam.tvec[1] + R[2][1] * cam.tvec[2]),
        -(R[0][2] * cam.tvec[0] + R[1][2] * cam.tvec[1] + R[2][2] * cam.tvec[2])
    ];

    div.innerHTML = '';
    const rows = [
        ['Name', cam.name],
        ['Size', cam.size[0] + ' x ' + cam.size[1] + ' px'],
        ['Focal (fx, fy)', cam.matrix[0][0].toFixed(1) + ', ' + cam.matrix[1][1].toFixed(1)],
        ['Principal pt', cam.matrix[0][2].toFixed(1) + ', ' + cam.matrix[1][2].toFixed(1)],
        ['Distortion', cam.dist.map(function (d) { return d.toFixed(3); }).join(', ')],
        ['Rotation (rvec)', cam.rvec.map(function (r) { return r.toFixed(3); }).join(', ')],
        ['Translation', cam.tvec.map(function (t) { return t.toFixed(1); }).join(', ')],
        ['World position', pos.map(function (p) { return p.toFixed(1); }).join(', ')],
    ];
    rows.forEach(function (row) {
        const r = document.createElement('div');
        r.className = 'session-info-row';
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = row[0];
        const value = document.createElement('span');
        value.className = 'value';
        value.style.fontSize = '11px';
        value.textContent = row[1];
        r.appendChild(label);
        r.appendChild(value);
        div.appendChild(r);
    });
}

// ============================================
// Skeleton table
// ============================================

export function populateSkeletonTable() {
    if (!state.session) return;
    const sk = state.session.skeleton;

    // Remember this skeleton for the current app session so newly loaded videos
    // inherit it (rememberSkeleton ignores empty skeletons, so viewing a blank
    // session never clobbers a good remembered one). Called here because this is
    // the single refresh point after every skeleton mutation (add/remove node or
    // edge, Load Skeleton) and after a loaded project repopulates the panel.
    rememberSkeleton(sk);

    // Nodes
    const nodesTbody = document.querySelector('#skeletonNodesTable tbody');
    nodesTbody.textContent = '';
    sk.nodes.forEach(function (name, i) {
        const tr = document.createElement('tr');
        const tdIdx = document.createElement('td');
        tdIdx.className = 'mono';
        tdIdx.textContent = i;

        const tdName = document.createElement('td');
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = name;
        nameInput.style.cssText = 'width:100%;padding:1px 3px;font-size:12px;background:var(--bg-tertiary);border:1px solid var(--border);color:var(--text-primary);border-radius:2px;box-sizing:border-box;';
        nameInput.addEventListener('change', function () {
            const newName = nameInput.value.trim();
            if (!newName) { nameInput.value = sk.nodes[i]; return; }
            sk.nodes[i] = newName;
            populateSkeletonTable();
            drawAllOverlays(state.currentFrame);
        });
        tdName.appendChild(nameInput);

        const tdDel = document.createElement('td');
        const delBtn = document.createElement('button');
        delBtn.textContent = '\u00d7';
        delBtn.className = 'panel-btn';
        delBtn.style.cssText = 'padding:0 5px;font-size:14px;line-height:1;min-width:0;color:var(--error);';
        delBtn.title = 'Remove node';
        delBtn.addEventListener('click', function () {
            sk.removeNode(i);
            populateSkeletonTable();
            drawAllOverlays(state.currentFrame);
        });
        tdDel.appendChild(delBtn);

        tr.appendChild(tdIdx);
        tr.appendChild(tdName);
        tr.appendChild(tdDel);
        nodesTbody.appendChild(tr);
    });

    // Edges
    const edgesTbody = document.querySelector('#skeletonEdgesTable tbody');
    edgesTbody.textContent = '';
    sk.edges.forEach(function (edge, edgeIdx) {
        const tr = document.createElement('tr');
        const tdSrc = document.createElement('td');
        tdSrc.textContent = sk.nodes[edge[0]];
        const tdDst = document.createElement('td');
        tdDst.textContent = sk.nodes[edge[1]];

        const tdDel = document.createElement('td');
        const delBtn = document.createElement('button');
        delBtn.textContent = '\u00d7';
        delBtn.className = 'panel-btn';
        delBtn.style.cssText = 'padding:0 5px;font-size:14px;line-height:1;min-width:0;color:var(--error);';
        delBtn.title = 'Remove edge';
        delBtn.addEventListener('click', function () {
            sk.removeEdge(edgeIdx);
            populateSkeletonTable();
            drawAllOverlays(state.currentFrame);
        });
        tdDel.appendChild(delBtn);

        tr.appendChild(tdSrc);
        tr.appendChild(tdDst);
        tr.appendChild(tdDel);
        edgesTbody.appendChild(tr);
    });

    // Populate edge source/destination dropdowns
    const srcSelect = document.getElementById('edgeSrcSelect');
    const dstSelect = document.getElementById('edgeDstSelect');
    srcSelect.textContent = '';
    dstSelect.textContent = '';
    sk.nodes.forEach(function (name, i) {
        const opt1 = document.createElement('option');
        opt1.value = i;
        opt1.textContent = name;
        srcSelect.appendChild(opt1);
        const opt2 = document.createElement('option');
        opt2.value = i;
        opt2.textContent = name;
        dstSelect.appendChild(opt2);
    });
}

// Ensure a session exists (creates a minimal empty one if needed)
export function ensureSession() {
    if (!state.session) {
        var cameras = state.videoFiles.map(function (vf) {
            return new Camera(vf.name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
        });
        state.session = new Session(cameras, buildRememberedSkeleton() || new Skeleton('skeleton', [], []), ['track_0']);
        if (state.sessions.indexOf(state.session) < 0) {
            state.sessions.push(state.session);
            state.activeSessionIdx = state.sessions.length - 1;
        }
    }
}

export function setupSkeletonEditing() {
    // Add Node button
    document.getElementById('btnAddNode').addEventListener('click', function () {
        ensureSession();
        const input = document.getElementById('nodeNameInput');
        const name = input.value.trim();
        if (!name) { setStatus('Enter a node name', 'warning'); return; }
        // Check for duplicate
        if (state.session.skeleton.nodes.indexOf(name) >= 0) {
            setStatus('Node "' + name + '" already exists', 'warning');
            return;
        }
        state.session.skeleton.addNode(name);
        input.value = '';
        populateSkeletonTable();
        drawAllOverlays(state.currentFrame);
    });

    // Allow Enter key in the node name input
    document.getElementById('nodeNameInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('btnAddNode').click();
        }
    });

    // Add Edge button
    document.getElementById('btnAddEdge').addEventListener('click', function () {
        ensureSession();
        const src = parseInt(document.getElementById('edgeSrcSelect').value, 10);
        const dst = parseInt(document.getElementById('edgeDstSelect').value, 10);
        if (isNaN(src) || isNaN(dst)) return;
        if (!state.session.skeleton.addEdge(src, dst)) {
            setStatus('Cannot add edge: duplicate or same node', 'warning');
            return;
        }
        populateSkeletonTable();
        drawAllOverlays(state.currentFrame);
    });

    // Save Skeleton button
    document.getElementById('btnSaveSkeleton').addEventListener('click', function () {
        if (!state.session || !state.session.skeleton) {
            setStatus('No skeleton to save', 'warning');
            return;
        }
        const sk = state.session.skeleton;
        if (sk.nodes.length === 0) {
            setStatus('Skeleton has no nodes', 'warning');
            return;
        }
        exportSkeletonJSON(sk);
    });

    // Load Skeleton button
    document.getElementById('btnLoadSkeleton').addEventListener('click', function () {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = function () {
            if (!input.files || input.files.length === 0) return;
            var reader = new FileReader();
            reader.onload = function (ev) {
                try {
                    var sk = parseSkeletonJSON(ev.target.result);
                    if (!sk) {
                        setStatus('Could not parse skeleton file', 'error');
                        return;
                    }
                    ensureSession();
                    state.session.skeleton = sk;
                    populateSkeletonTable();
                    drawAllOverlays(state.currentFrame);
                    updateInfoPanel();
                    setStatus('Loaded skeleton: ' + sk.nodes.length + ' nodes, ' + sk.edges.length + ' edges', 'success');
                } catch (err) {
                    console.error('Failed to load skeleton:', err);
                    setStatus('Skeleton load error: ' + err.message, 'error');
                }
            };
            reader.readAsText(input.files[0]);
        };
        input.click();
    });
}

/**
 * Export skeleton in SLEAP-compatible jsonpickle format (.skeleton.json) by
 * downloading the object built by buildSkeletonJSON (import-export/skeleton-json.js).
 */
export function exportSkeletonJSON(skeleton) {
    var skeletonJSON = buildSkeletonJSON(skeleton);

    // Download as JSON file
    var jsonStr = JSON.stringify(skeletonJSON, null, 2);
    var blob = new Blob([jsonStr], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (skeleton.name || 'skeleton') + '.skeleton.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setStatus('Saved skeleton: ' + skeleton.nodes.length + ' nodes, ' + skeleton.edges.length + ' edges', 'success');
}

// ============================================
// Session info (static, updated once)
// ============================================

export function updateInfoPanel() {
    if (!state.session) {
        document.getElementById('infoCameras').textContent = '-';
        document.getElementById('infoSkeleton').textContent = '-';
        document.getElementById('infoTracks').textContent = '-';
        document.getElementById('infoFrames').textContent = '-';
        return;
    }

    document.getElementById('infoCameras').textContent = state.session.cameras.map(function (c) { return c.name; }).join(', ');
    document.getElementById('infoSkeleton').textContent = state.session.skeleton.name +
        ' (' + state.session.skeleton.nodes.length + ' nodes)';
    document.getElementById('infoTracks').textContent = state.session.tracks.join(', ');
    document.getElementById('infoFrames').textContent = state.session.numFrames;

    // Rebuild instance detail panel (track/identity dropdowns)
    updateFrameInfo(state.currentFrame, getInstanceGroupsForFrame(state.currentFrame));

    // Also populate static tables
    populateVideosTable();
    populateCamerasTable();
    populateSkeletonTable();
    populateSessionsPanel();
    // Block 2 (Prompt 4): refresh the per-session Timeline visibility
    // toggle lists in the Visibility tab.
    populateTimelineVisibility(state.session);

    // Wire Videos tab buttons
    document.getElementById('btnAddVideos').onclick = function () { handleLoadVideos(); };
    document.getElementById('btnRemoveVideo').onclick = function () {
        // Get selected row
        const selected = document.querySelector('#videosTable tbody tr.selected');
        if (!selected) return;
        const idx = Array.from(selected.parentNode.children).indexOf(selected);
        var videoList = state.videoFiles.length > 0 ? state.videoFiles : state.views;
        if (idx >= 0 && idx < videoList.length) {
            var removed = videoList[idx];
            videoList.splice(idx, 1);
            // Also remove the view if it exists
            if (removed.assignedCamera || removed.name) {
                var viewName = removed.assignedCamera || removed.name;
                var viewIdx = -1;
                for (var vi = 0; vi < state.views.length; vi++) {
                    if (state.views[vi].name === viewName) { viewIdx = vi; break; }
                }
                if (viewIdx >= 0) {
                    var viewEl = state.views[viewIdx].canvas.closest('.video-cell');
                    if (viewEl) viewEl.remove();
                    state.views.splice(viewIdx, 1);
                }
            }
            populateVideosTable();
            populateSessionAssignTable();
            document.getElementById('btnRemoveVideo').disabled = true;
        }
    };

    // Wire Session tab buttons
    document.getElementById('btnAutoAssign').onclick = function () {
        autoAssignVideosToCameras();
        populateSessionAssignTable();
        populateVideosTable();
        setStatus('Auto-assigned videos to cameras', 'success');
    };
    document.getElementById('btnAddAllViews').onclick = function () {
        var created = 0;
        for (var i = 0; i < state.videoFiles.length; i++) {
            var vf = state.videoFiles[i];
            if (vf.assignedCamera && !state.views.some(function (v) { return v.name === vf.assignedCamera; })) {
                createViewForVideoFile(vf);
                created++;
            }
        }
        if (created > 0) {
            populateViewStrip();
            populateSessionStrip();
            rebuildVideoController();
            fitCanvasesToCells();
            populateSessionAssignTable();
            setStatus('Created ' + created + ' new view(s)', 'success');
        } else {
            setStatus('All assigned cameras already have views', 'warning');
        }
    };

    populateSessionAssignTable();

    // Wire Sessions list buttons
    var btnAddFolder = document.getElementById('btnAddSessionFolder');
    if (btnAddFolder) btnAddFolder.onclick = function() { loadSingleSessionFromCache(); };
    var btnAddCalib = document.getElementById('btnAddSessionCalib');
    if (btnAddCalib) btnAddCalib.onclick = function() { handleLoadCalibration(); };
}

export function populateSessionAssignTable() {
    var tbody = document.querySelector('#sessionAssignTable tbody');
    var empty = document.getElementById('sessionAssignEmpty');
    tbody.textContent = '';

    if (!state.session || state.session.cameras.length === 0) {
        document.getElementById('sessionAssignTable').style.display = 'none';
        empty.style.display = '';
        populateUnassignedVideos(null);
        return;
    }

    document.getElementById('sessionAssignTable').style.display = '';
    empty.style.display = 'none';

    // Get video files belonging to the active session
    var sessionVideos = state.videoFiles.filter(function (vf) {
        return vf.sessionIdx === state.activeSessionIdx || vf.sessionIdx === undefined;
    });

    state.session.cameras.forEach(function (cam) {
        var tr = document.createElement('tr');

        // Camera name
        var tdCam = document.createElement('td');
        tdCam.textContent = cam.name;

        // Video assignment dropdown
        var tdVideo = document.createElement('td');
        var select = document.createElement('select');
        select.style.cssText = 'width:100%;padding:2px;font-size:11px;background:var(--bg-tertiary);border:1px solid var(--border);color:var(--text-primary);border-radius:2px;';

        // Option: unassigned
        var optNone = document.createElement('option');
        optNone.value = '';
        optNone.textContent = 'None';
        select.appendChild(optNone);

        // Options from session's videoFiles only
        sessionVideos.forEach(function (vf) {
            var opt = document.createElement('option');
            opt.value = vf.name;
            opt.textContent = vf.name;
            if (vf.assignedCamera === cam.name) {
                opt.selected = true;
            }
            select.appendChild(opt);
        });

        select.addEventListener('change', function () {
            // Unassign any session video previously assigned to this camera
            sessionVideos.forEach(function (vf) {
                if (vf.assignedCamera === cam.name) vf.assignedCamera = null;
            });
            // Assign the selected video
            if (select.value) {
                var vf = sessionVideos.find(function (v) { return v.name === select.value; });
                if (vf) vf.assignedCamera = cam.name;
            }
            populateSessionAssignTable();
            populateVideosTable();
        });
        tdVideo.appendChild(select);

        // Status
        var tdStatus = document.createElement('td');
        var hasView = state.views.some(function (v) { return v.name === cam.name; });
        var hasSessionAssignment = sessionVideos.some(function (vf) { return vf.assignedCamera === cam.name; });
        if (!hasSessionAssignment) {
            select.value = '';
        }

        if (hasView) {
            tdStatus.innerHTML = '<span style="color:var(--success-color);font-size:11px;">Active</span>';
        } else if (hasSessionAssignment) {
            var addBtn = document.createElement('button');
            addBtn.textContent = 'Add View';
            addBtn.className = 'panel-btn';
            addBtn.style.cssText = 'padding:1px 6px;font-size:10px;min-width:0;';
            addBtn.addEventListener('click', function () {
                var vf = state.videoFiles.find(function (v) { return v.assignedCamera === cam.name; });
                if (vf) {
                    createViewForVideoFile(vf);
                    rebuildVideoController();
                    fitCanvasesToCells();
                    populateSessionAssignTable();
                }
            });
            tdStatus.appendChild(addBtn);
        } else {
            tdStatus.innerHTML = '<span style="color:var(--text-muted);font-size:11px;">Unassigned</span>';
        }

        tr.appendChild(tdCam);
        tr.appendChild(tdVideo);
        tr.appendChild(tdStatus);
        tbody.appendChild(tr);
    });

    populateUnassignedVideos(sessionVideos);
}

export function populateUnassignedVideos(sessionVideos) {
    var section = document.getElementById('unassignedVideosSection');
    var tbody = document.querySelector('#unassignedVideosTable tbody');
    if (!section || !tbody) return;
    tbody.textContent = '';

    if (!sessionVideos) {
        sessionVideos = state.videoFiles.filter(function (vf) {
            return vf.sessionIdx === state.activeSessionIdx || vf.sessionIdx === undefined;
        });
    }

    var unassigned = sessionVideos.filter(function (vf) { return !vf.assignedCamera; });

    if (unassigned.length === 0) {
        section.style.display = 'none';
        return;
    }
    section.style.display = '';

    for (var i = 0; i < unassigned.length; i++) {
        var tr = document.createElement('tr');
        var td = document.createElement('td');
        td.style.cssText = 'white-space:nowrap;overflow-x:auto;overflow-y:hidden;display:block;max-width:100%;scrollbar-width:thin;';
        td.textContent = unassigned[i].file ? unassigned[i].file.name : unassigned[i].name;
        tr.appendChild(td);
        tbody.appendChild(tr);
    }
}

export function updateFrameInfo(frameIdx, instanceGroups) {
    // Reprojection error display
    const results = state.triangulationResults.get(frameIdx);
    let meanError = null;
    let meanErrorUndist = null;
    let maxError = 0;

    if (results) {
        let totalErr = 0;
        let totalCount = 0;
        let totalErrUndist = 0;
        let totalCountUndist = 0;
        for (const r of results) {
            if (r.meanError != null) {
                for (const camName in r.errors) {
                    for (const err of r.errors[camName]) {
                        if (err != null) {
                            totalErr += err;
                            if (err > maxError) maxError = err;
                            totalCount++;
                        }
                    }
                }
            }
            // Undistorted-space errors (the space BA optimizes in), aggregated the
            // same way so the two headline averages are directly comparable.
            if (r.errorsUndistorted) {
                for (const camName in r.errorsUndistorted) {
                    for (const err of r.errorsUndistorted[camName]) {
                        if (err != null) {
                            totalErrUndist += err;
                            totalCountUndist++;
                        }
                    }
                }
            }
        }
        if (totalCount > 0) meanError = totalErr / totalCount;
        if (totalCountUndist > 0) meanErrorUndist = totalErrUndist / totalCountUndist;
    }

    // Renders a "<value> px" (colour-coded) headline value into an element, or
    // "-" when there is no value.
    const setErrorStat = function (el, value) {
        if (!el) return;
        if (value != null) {
            el.textContent = value.toFixed(2);
            el.className = 'error-display ' +
                (value < 2 ? 'low' : value < 5 ? 'medium' : 'high');
            const unitSpan = document.createElement('span');
            unitSpan.className = 'error-unit';
            unitSpan.textContent = ' px';
            el.appendChild(unitSpan);
        } else {
            el.textContent = '-';
            el.className = 'error-display';
        }
    };
    setErrorStat(document.getElementById('errorDisplay'), meanError);
    // Undistorted residual as a small subtitle below the distorted headline
    // (e.g. "undist 4.17 px"); blank when unavailable.
    const undistEl = document.getElementById('errorDisplayUndist');
    if (undistEl) {
        undistEl.textContent = meanErrorUndist != null
            ? ('undist ' + meanErrorUndist.toFixed(2) + ' px')
            : '';
    }

    // Triangulation method label ('DLT' or 'Bundle Adjustment'). Prefer the
    // per-result method; fall back to the group's recorded method.
    const errorMethodEl = document.getElementById('errorMethod');
    if (errorMethodEl) {
        let method = null;
        if (results && results.length > 0) {
            for (const r of results) {
                if (r.method) { method = r.method; break; }
                if (r.group && r.group.triangulationMethod) { method = r.group.triangulationMethod; break; }
            }
        }
        // Fall back to the frame's groups (e.g. after "Group by ... & Triangulate
        // All", which records the method on each group but not in results).
        if (!method && instanceGroups) {
            for (const g of instanceGroups) {
                if (g && g.triangulationMethod) { method = g.triangulationMethod; break; }
            }
        }
        if (method) {
            errorMethodEl.textContent = method === 'ba' ? 'Bundle Adjustment' : 'DLT';
            errorMethodEl.style.display = '';
        } else {
            errorMethodEl.style.display = 'none';
        }
    }

    // Per-camera errors
    const perCamDiv = document.getElementById('perCameraErrors');
    perCamDiv.textContent = '';
    if (results && results.length > 0) {
        for (const cam of state.session.cameras) {
            let camErr = 0, camCount = 0;
            for (const r of results) {
                if (r.errors && r.errors[cam.name]) {
                    for (const err of r.errors[cam.name]) {
                        if (err != null) { camErr += err; camCount++; }
                    }
                }
            }
            if (camCount > 0) {
                const row = document.createElement('div');
                row.className = 'session-info-row';
                const labelEl = document.createElement('span');
                labelEl.className = 'label';
                labelEl.textContent = cam.name;
                const valueEl = document.createElement('span');
                valueEl.className = 'value';
                valueEl.textContent = (camErr / camCount).toFixed(2) + ' px';
                row.appendChild(labelEl);
                row.appendChild(valueEl);
                perCamDiv.appendChild(row);
            }
        }
    }

    // ---- Per-node per-camera error breakdown table ----
    var breakdownDiv = document.getElementById('errorBreakdownTable');
    breakdownDiv.textContent = '';
    if (results && results.length > 0 && state.session && state.session.skeleton) {
        var nodeNames = state.session.skeleton.nodes;
        var cameras = state.session.cameras;
        var camNames = cameras.map(function(c) { return c.name; });

        // Accumulate errors: nodeErrors[nodeIdx][camName] = {sum, count}
        var nodeErrors = [];
        for (var ni = 0; ni < nodeNames.length; ni++) {
            nodeErrors[ni] = {};
            for (var ci = 0; ci < camNames.length; ci++) {
                nodeErrors[ni][camNames[ci]] = { sum: 0, count: 0 };
            }
        }
        for (var ri = 0; ri < results.length; ri++) {
            var r = results[ri];
            if (!r.errors) continue;
            for (var ci = 0; ci < camNames.length; ci++) {
                var camErrs = r.errors[camNames[ci]];
                if (!camErrs) continue;
                for (var ni = 0; ni < Math.min(camErrs.length, nodeNames.length); ni++) {
                    if (camErrs[ni] != null) {
                        nodeErrors[ni][camNames[ci]].sum += camErrs[ni];
                        nodeErrors[ni][camNames[ci]].count++;
                    }
                }
            }
        }

        // Build table
        var tbl = document.createElement('table');
        tbl.style.cssText = 'font-size:10px;border-collapse:collapse;width:100%;';
        var thead = document.createElement('thead');
        var hrow = document.createElement('tr');
        var th0 = document.createElement('th');
        th0.textContent = 'Node';
        th0.style.cssText = 'text-align:left;padding:2px 4px;border-bottom:1px solid var(--border-color);color:var(--text-muted);';
        hrow.appendChild(th0);
        for (var ci = 0; ci < camNames.length; ci++) {
            var th = document.createElement('th');
            th.textContent = camNames[ci];
            th.style.cssText = 'text-align:right;padding:2px 4px;border-bottom:1px solid var(--border-color);color:var(--text-muted);';
            hrow.appendChild(th);
        }
        var thAvg = document.createElement('th');
        thAvg.textContent = 'Avg';
        thAvg.style.cssText = 'text-align:right;padding:2px 4px;border-bottom:1px solid var(--border-color);color:var(--text-muted);font-weight:700;';
        hrow.appendChild(thAvg);
        thead.appendChild(hrow);
        tbl.appendChild(thead);

        var tbody = document.createElement('tbody');
        for (var ni = 0; ni < nodeNames.length; ni++) {
            var row = document.createElement('tr');
            var tdName = document.createElement('td');
            tdName.textContent = nodeNames[ni];
            tdName.style.cssText = 'padding:1px 4px;white-space:nowrap;color:var(--text-secondary);';
            row.appendChild(tdName);
            var rowSum = 0, rowCount = 0;
            for (var ci = 0; ci < camNames.length; ci++) {
                var td = document.createElement('td');
                td.style.cssText = 'text-align:right;padding:1px 4px;font-family:monospace;';
                var entry = nodeErrors[ni][camNames[ci]];
                if (entry.count > 0) {
                    var avg = entry.sum / entry.count;
                    td.textContent = avg.toFixed(1);
                    td.style.color = avg < 2 ? 'var(--success-color)' : avg < 5 ? 'var(--warning-color)' : 'var(--error-color)';
                    rowSum += entry.sum;
                    rowCount += entry.count;
                } else {
                    td.textContent = '-';
                    td.style.color = 'var(--text-muted)';
                }
                row.appendChild(td);
            }
            var tdAvg = document.createElement('td');
            tdAvg.style.cssText = 'text-align:right;padding:1px 4px;font-family:monospace;font-weight:700;';
            if (rowCount > 0) {
                var rowAvg = rowSum / rowCount;
                tdAvg.textContent = rowAvg.toFixed(1);
                tdAvg.style.color = rowAvg < 2 ? 'var(--success-color)' : rowAvg < 5 ? 'var(--warning-color)' : 'var(--error-color)';
            } else {
                tdAvg.textContent = '-';
                tdAvg.style.color = 'var(--text-muted)';
            }
            row.appendChild(tdAvg);
            tbody.appendChild(row);
        }
        tbl.appendChild(tbody);
        breakdownDiv.appendChild(tbl);
    }

    // ---- Linked Instance Groups table ----
    const groupsTbody = document.querySelector('#instanceGroupsTable tbody');
    const groupsEmpty = document.getElementById('instanceGroupsEmpty');
    groupsTbody.textContent = '';

    if (instanceGroups && instanceGroups.length > 0) {
        document.getElementById('instanceGroupsTable').style.display = '';
        groupsEmpty.style.display = 'none';

        // Sort by track name, then type priority: user > reprojected > predicted
        var sortedGroups = instanceGroups.slice().sort(function(a, b) {
            var trackA = state.session.tracks[a.trackIdx] || '';
            var trackB = state.session.tracks[b.trackIdx] || '';
            if (trackA !== trackB) return trackA.localeCompare(trackB);
            var typePriority = { 'user': 0, 'reprojected': 1, 'predicted': 2 };
            var typeA = a.instances.values().next().value;
            var typeB = b.instances.values().next().value;
            var priA = typePriority[typeA ? typeA.type : 'user'] || 0;
            var priB = typePriority[typeB ? typeB.type : 'user'] || 0;
            return priA - priB;
        });

        for (let i = 0; i < sortedGroups.length; i++) {
            const group = sortedGroups[i];
            const tr = document.createElement('tr');

            // Highlight if selected (but not when reprojected sub-entry is selected)
            if (interactionManager && interactionManager.selectedInstanceGroup === group &&
                !interactionManager.selectedReprojected) {
                tr.classList.add('selected');
            }

            // Track column (with color dot)
            const tdTrack = document.createElement('td');
            // Track dropdown
            var trackSelect = document.createElement('select');
            trackSelect.style.cssText = 'font-size:10px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border-color);border-radius:3px;padding:0 2px;max-width:90px;';
            // "(none)" — a trackless group. Must exist so a group with no track
            // shows as trackless instead of silently snapping to the first track.
            var noneTrackOpt = document.createElement('option');
            noneTrackOpt.value = '-1';
            noneTrackOpt.textContent = '(none)';
            trackSelect.appendChild(noneTrackOpt);
            for (var tsi = 0; tsi < (state.session.tracks || []).length; tsi++) {
                var tOpt = document.createElement('option');
                tOpt.value = tsi;
                tOpt.textContent = state.session.tracks[tsi];
                trackSelect.appendChild(tOpt);
            }
            var newTrackOpt = document.createElement('option');
            newTrackOpt.value = '__new__';
            newTrackOpt.textContent = '(+) New Track';
            trackSelect.appendChild(newTrackOpt);
            // Source the current track from the first instance's trackIdx, NOT
            // group.identityId. A trackless group (trackIdx == null — e.g. one
            // formed by grouping trackless instances) shows "(none)"; it must
            // NOT default to the first track (index 0).
            var firstGroupInst = group.instances.values().next().value;
            var groupDisplayTrackIdx = (firstGroupInst && firstGroupInst.trackIdx != null && firstGroupInst.trackIdx >= 0)
                ? firstGroupInst.trackIdx
                : -1;
            trackSelect.value = String(groupDisplayTrackIdx);
            (function (g, sel, curTrack) {
                function applyTrack(newTrack) {
                    if (newTrack < 0) {
                        // "(none)" → make the whole group trackless.
                        for (var [cnN, ginstN] of g.instances) ginstN.trackIdx = null;
                        state.session.assignIdentityToGroup(g, -1);
                        setStatus('Track → (none)', 'success');
                        drawAllOverlays(state.currentFrame);
                        updateInfoPanel();
                        if (timeline) timeline.refreshTracks(state.session, { keepSize: true });
                        return;
                    }
                    var totalProp = 0;
                    for (var [cn, ginst] of g.instances) {
                        totalProp += swapAssignTrack(state.currentFrame, cn, ginst, newTrack, state.session);
                    }
                    // Route through swap-aware setter so a sibling group in
                    // this frame that already held this identityId gets
                    // demoted (rather than silently doubling up the color).
                    state.session.assignIdentityToGroup(g, newTrack);
                    setStatus('Track → ' + (state.session.tracks[newTrack] || newTrack) +
                        (totalProp > 0 ? ' (propagated ' + totalProp + ')' : ''), 'success');
                    drawAllOverlays(state.currentFrame);
                    updateInfoPanel();
                    if (timeline) timeline.refreshTracks(state.session, { keepSize: true });
                }
                sel.addEventListener('change', function (ev) {
                    ev.stopPropagation();
                    if (sel.value === '__new__') {
                        startInlineNameEntry(sel, 'track_' + state.session.tracks.length, function (name) {
                            var idx = state.session.tracks.indexOf(name);
                            if (idx < 0) { state.session.tracks.push(name); idx = state.session.tracks.length - 1; }
                            applyTrack(idx);
                            populateTimelineVisibility(state.session);
                        });
                        return;
                    }
                    var newTrack = parseInt(sel.value);
                    if (newTrack === curTrack) return;
                    applyTrack(newTrack);
                });
                sel.addEventListener('click', function (ev) { ev.stopPropagation(); });
                sel.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
                sel.addEventListener('mouseup', function (ev) { ev.stopPropagation(); });
            })(group, trackSelect, groupDisplayTrackIdx);
            tdTrack.appendChild(trackSelect);
            if (group.dirty) {
                const dirtyDot = document.createElement('span');
                dirtyDot.style.cssText = 'width:5px;height:5px;border-radius:50%;background:var(--warning-color);display:inline-block;margin-left:4px;';
                dirtyDot.title = 'Needs re-triangulation';
                tdTrack.appendChild(dirtyDot);
            }

            // Identity column (separate td)
            const tdIdentity = document.createElement('td');
            const idSelect = document.createElement('select');
            idSelect.style.cssText = 'font-size:10px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border-color);border-radius:3px;padding:0 2px;max-width:90px;';
            const optNone = document.createElement('option');
            optNone.value = '-1';
            optNone.textContent = '(none)';
            idSelect.appendChild(optNone);
            if (state.session && state.session.identities) {
                for (var idIdx = 0; idIdx < state.session.identities.length; idIdx++) {
                    var ident = state.session.identities[idIdx];
                    var opt = document.createElement('option');
                    opt.value = String(ident.id);
                    opt.textContent = ident.name;
                    idSelect.appendChild(opt);
                }
            }
            var newIdOpt = document.createElement('option');
            newIdOpt.value = '__new__';
            newIdOpt.textContent = '(+) New ID';
            idSelect.appendChild(newIdOpt);
            idSelect.value = String(group.identityId != null ? group.identityId : -1);
            (function (g, sel) {
                function applyIdentity(newIdentityId) {
                    state.session.assignIdentityToGroup(g, newIdentityId);
                    // Propagate forward for all cameras in the group.
                    // Use assignTrackToIdentity (swap-aware) for the global
                    // map so two distinct trackIdx values can't both end up
                    // mapped to newIdentityId on the same camera.
                    for (var [cn, inst] of g.instances) {
                        state.session.assignTrackToIdentity(inst.trackIdx, newIdentityId, cn);
                        propagateIdentityForward(inst.trackIdx, newIdentityId, cn);
                    }
                    drawAllOverlays(state.currentFrame);
                    updateInfoPanel();
                    if (timeline) timeline.refreshTracks(state.session, { keepSize: true });
                }
                sel.addEventListener('change', function (e) {
                    e.stopPropagation();
                    if (sel.value === '__new__') {
                        startInlineNameEntry(sel, 'identity_' + state.session.identities.length, function (name) {
                            var existing = state.session.identities.find(function (id) { return id.name === name; });
                            var identity = existing || state.session.addIdentity(name);
                            applyIdentity(identity.id);
                            populateTimelineVisibility(state.session);
                        });
                        return;
                    }
                    applyIdentity(parseInt(sel.value));
                });
                sel.addEventListener('click', function (e) { e.stopPropagation(); });
                sel.addEventListener('mousedown', function (e) { e.stopPropagation(); });
                sel.addEventListener('mouseup', function (e) { e.stopPropagation(); });
            })(group, idSelect);
            tdIdentity.appendChild(idSelect);

            // Views column
            const tdViews = document.createElement('td');
            tdViews.className = 'mono';
            tdViews.textContent = group.cameraNames.length + '/' + state.session.cameras.length;
            var viewDetails = group.cameraNames.map(function (cn) {
                var inst = group.getInstance(cn);
                var tIdx = inst && inst.trackIdx != null ? inst.trackIdx : '?';
                return cn + ' (track ' + tIdx + ')';
            });
            tdViews.title = viewDetails.join(', ');

            // Type column
            const tdType = document.createElement('td');
            const firstInst = group.instances.values().next().value;
            if (firstInst) {
                const badge = document.createElement('span');
                badge.className = 'badge ' + (firstInst.type === 'predicted' ? 'badge-predicted' : 'badge-user');
                badge.textContent = firstInst.type === 'predicted' ? 'Pred' : 'User';
                if (firstInst.modified) badge.textContent += '*';
                tdType.appendChild(badge);
            }

            // Error column
            const tdError = document.createElement('td');
            tdError.className = 'mono reproj-error-col';
            if (!state.triangulationResults || state.triangulationResults.size === 0) {
                tdError.style.display = 'none';
            }
            if (results) {
                const groupResult = results.find(function (r) { return r.group === group; });
                if (groupResult && groupResult.meanError != null) {
                    tdError.textContent = groupResult.meanError.toFixed(1);
                } else {
                    tdError.textContent = '-';
                }
            } else {
                tdError.textContent = '-';
            }

            // Unlink button column
            const tdUnlink = document.createElement('td');
            tdUnlink.style.padding = '0';
            const unlinkBtn = document.createElement('button');
            unlinkBtn.textContent = '\u00d7';
            unlinkBtn.title = 'Unlink group';
            unlinkBtn.style.cssText = 'background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:14px;padding:2px 4px;line-height:1;';

            tr.appendChild(tdTrack);
            tr.appendChild(tdIdentity);
            tr.appendChild(tdViews);
            tr.appendChild(tdType);
            tr.appendChild(tdError);
            tr.appendChild(tdUnlink);
            tdUnlink.appendChild(unlinkBtn);

            // Click to toggle selection of this group. Skip when the
            // click originates inside a form control (track/identity
            // dropdown) — otherwise the DOM rebuild triggered here
            // would destroy the open <select> mid-interaction and
            // the user could never pick a new option.
            (function (g) {
                tr.addEventListener('click', function (ev) {
                    if (isInteractiveClickTarget(ev && ev.target)) return;
                    if (interactionManager) {
                        if (interactionManager.selectedInstanceGroup === g && !interactionManager.selectedReprojected) {
                            interactionManager.clearSelection();
                        } else {
                            interactionManager.select(g, -1);
                        }
                    }
                    drawAllOverlays(state.currentFrame);
                    updateFrameInfo(state.currentFrame, getInstanceGroupsForFrame(state.currentFrame));
                });
                unlinkBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    unlinkGroup(g);
                });
                tr.addEventListener('contextmenu', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    showGroupContextMenu(e.clientX, e.clientY, g);
                });
            })(group);

            groupsTbody.appendChild(tr);

            // Add reprojected instance row if this group has reprojected instances
            if (group.reprojectedInstances && group.reprojectedInstances.size > 0) {
                const rtr = document.createElement('tr');
                rtr.style.cursor = 'pointer';

                // Highlight only when reprojected sub-entry is specifically selected
                if (interactionManager && interactionManager.selectedInstanceGroup === group &&
                    interactionManager.selectedReprojected) {
                    rtr.classList.add('selected');
                }

                const rtdTrack = document.createElement('td');
                const rdot = document.createElement('span');
                rdot.className = 'track-indicator';
                rdot.style.backgroundColor = REPROJECTION_COLOR;
                rdot.style.marginRight = '4px';
                rtdTrack.appendChild(rdot);
                var reprojTrackName = (group.identityId >= 0 && state.session.tracks[group.identityId]) || ('Group ' + i);
                rtdTrack.appendChild(document.createTextNode(reprojTrackName));

                const rtdViews = document.createElement('td');
                rtdViews.className = 'mono';
                rtdViews.textContent = group.reprojectedInstances.size + '/' + state.session.cameras.length;
                rtdViews.title = Array.from(group.reprojectedInstances.keys()).join(', ');

                const rtdType = document.createElement('td');
                const rbadge = document.createElement('span');
                rbadge.className = 'badge badge-reproj';
                rbadge.textContent = 'Reproj';
                rtdType.appendChild(rbadge);

                const rtdError = document.createElement('td');
                rtdError.className = 'mono reproj-error-col';
                if (!state.triangulationResults || state.triangulationResults.size === 0) {
                    rtdError.style.display = 'none';
                }
                rtdError.textContent = '-';

                const rtdEmpty = document.createElement('td');
                rtdEmpty.style.padding = '0';

                rtr.appendChild(rtdTrack);
                rtr.appendChild(rtdViews);
                rtr.appendChild(rtdType);
                rtr.appendChild(rtdError);
                rtr.appendChild(rtdEmpty);

                // Click to select reprojected sub-entry; dblclick to create UserInstance
                (function (g) {
                    rtr.addEventListener('click', function () {
                        if (interactionManager) {
                            interactionManager.select(g, -1, true);
                        }
                        drawAllOverlays(state.currentFrame);
                        updateFrameInfo(state.currentFrame, getInstanceGroupsForFrame(state.currentFrame));
                    });
                    rtr.addEventListener('dblclick', function (e) {
                        e.preventDefault();
                        e.stopPropagation();
                        // Find the first view that has a reprojected instance but no main instance
                        var targetView = null;
                        if (g.reprojectedInstances) {
                            for (var [camName, reprojInst] of g.reprojectedInstances) {
                                var mainInst = g.getInstance(camName);
                                if (!mainInst) { targetView = camName; break; }
                            }
                        }
                        if (targetView && interactionManager && interactionManager.callbacks.onDoubleClickReprojected) {
                            interactionManager.callbacks.onDoubleClickReprojected(g, targetView);
                        }
                    });
                })(group);

                groupsTbody.appendChild(rtr);
            }
        }
    } else {
        document.getElementById('instanceGroupsTable').style.display = 'none';
        groupsEmpty.style.display = '';
    }

    // ---- Unlinked Instances table ----
    const ulTbody = document.querySelector('#unlinkedTable tbody');
    const ulEmpty = document.getElementById('unlinkedEmpty');
    ulTbody.textContent = '';

    const fg = state.session.getFrameGroup(frameIdx);
    let hasUnlinked = false;

    if (fg) {
        // Collect all unlinked instances, grouped by camera, filtered and sorted
        for (const cam of state.session.cameras) {
            const unlinkedList = fg.getUnlinkedInstances(cam.name);
            if (!unlinkedList || unlinkedList.length === 0) continue;

            // Filter out reprojected instances and sort: user above predicted
            var typePriority = { 'user': 0, 'predicted': 1 };
            var filtered = unlinkedList.filter(function (ul) {
                var t = ul.instance.type || 'user';
                return t !== 'reprojected';
            });
            filtered.sort(function (a, b) {
                var ta = typePriority[a.instance.type || 'user'] || 0;
                var tb = typePriority[b.instance.type || 'user'] || 0;
                return ta - tb;
            });

            if (filtered.length === 0) continue;
            hasUnlinked = true;

            // Camera header row
            var headerTr = document.createElement('tr');
            headerTr.className = 'unlinked-camera-header';
            var headerTd = document.createElement('td');
            headerTd.colSpan = 3;
            headerTd.textContent = cam.name;
            headerTd.style.cssText = 'font-weight:bold;color:var(--text-primary);font-size:11px;padding:4px 6px 2px;';
            headerTr.appendChild(headerTd);
            ulTbody.appendChild(headerTr);

            for (let u = 0; u < filtered.length; u++) {
                const ul = filtered[u];
                const tr = document.createElement('tr');

                // Highlight if in assignment selection
                if (interactionManager && interactionManager.assignmentSelection) {
                    for (let s = 0; s < interactionManager.assignmentSelection.length; s++) {
                        if (interactionManager.assignmentSelection[s].id === ul.id) {
                            tr.classList.add('selected');
                            break;
                        }
                    }
                }

                // Track column with dropdown. Includes a "—" (None)
                // option so trackless user instances (trackIdx == null,
                // e.g., reprojections imported from a 2D SLP with
                // track=null) are displayed distinctly from a real
                // track-0 instance instead of silently falling back
                // to the first track.
                const tdTrackUl = document.createElement('td');
                var trackSelect = document.createElement('select');
                trackSelect.style.cssText = 'font-size:10px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border-color);border-radius:3px;padding:0 2px;max-width:80px;';
                var noneTrackOpt = document.createElement('option');
                noneTrackOpt.value = '-1';
                noneTrackOpt.textContent = '—';
                trackSelect.appendChild(noneTrackOpt);
                for (var ti = 0; ti < (state.session.tracks || []).length; ti++) {
                    var tOpt = document.createElement('option');
                    tOpt.value = ti;
                    tOpt.textContent = state.session.tracks[ti];
                    trackSelect.appendChild(tOpt);
                }
                var newTrackOptUl = document.createElement('option');
                newTrackOptUl.value = '__new__';
                newTrackOptUl.textContent = '(+) New Track';
                trackSelect.appendChild(newTrackOptUl);
                trackSelect.value = ul.instance.trackIdx != null ? String(ul.instance.trackIdx) : '-1';
                (function (ulObj, inst, sel, camNameForUl) {
                    function applyTrack(newTrack) {
                        var propagated = swapAssignTrack(state.currentFrame, camNameForUl, inst, newTrack, state.session);
                        setStatus('Track → ' + (state.session.tracks[newTrack] || newTrack) + ' on ' + camNameForUl +
                            (propagated > 0 ? ' (propagated ' + propagated + ')' : ''), 'success');
                        drawAllOverlays(state.currentFrame);
                        updateInfoPanel();
                        if (timeline) timeline.refreshTracks(state.session, { keepSize: true });
                    }
                    sel.addEventListener('change', function (ev) {
                        ev.stopPropagation();
                        if (sel.value === '__new__') {
                            startInlineNameEntry(sel, 'track_' + state.session.tracks.length, function (name) {
                                var idx = state.session.tracks.indexOf(name);
                                if (idx < 0) { state.session.tracks.push(name); idx = state.session.tracks.length - 1; }
                                applyTrack(idx);
                                populateTimelineVisibility(state.session);
                            });
                            return;
                        }
                        var newTrack = parseInt(sel.value);
                        if (newTrack < 0) {
                            // User explicitly chose "None" — leave trackless.
                            if (inst.trackIdx == null) return;
                            inst.trackIdx = null;
                            setStatus('Track → — on ' + camNameForUl, 'success');
                            drawAllOverlays(state.currentFrame);
                            updateInfoPanel();
                            if (timeline) timeline.refreshTracks(state.session, { keepSize: true });
                            return;
                        }
                        if (newTrack === inst.trackIdx) return;
                        applyTrack(newTrack);
                    });
                    sel.addEventListener('click', function (ev) { ev.stopPropagation(); });
                    sel.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
                    sel.addEventListener('mouseup', function (ev) { ev.stopPropagation(); });
                })(ul, ul.instance, trackSelect, cam.name);
                tdTrackUl.appendChild(trackSelect);

                // Identity column for unlinked instances
                const tdIdUl = document.createElement('td');
                var idSelectUl = document.createElement('select');
                idSelectUl.style.cssText = 'font-size:10px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border-color);border-radius:3px;padding:0 2px;max-width:70px;';
                var optNoneUl = document.createElement('option');
                optNoneUl.value = '-1';
                optNoneUl.textContent = '—';
                idSelectUl.appendChild(optNoneUl);
                for (var idi = 0; idi < (state.session.identities || []).length; idi++) {
                    var idOpt = document.createElement('option');
                    idOpt.value = state.session.identities[idi].id;
                    idOpt.textContent = state.session.identities[idi].name;
                    idSelectUl.appendChild(idOpt);
                }
                var newIdOptUl = document.createElement('option');
                newIdOptUl.value = '__new__';
                newIdOptUl.textContent = '(+) New ID';
                idSelectUl.appendChild(newIdOptUl);
                // Pre-select based on the per-frame identity for this track.
                var currentIdForTrack = state.session.getIdentityIdForTrack(cam.name, ul.instance.trackIdx, state.currentFrame);
                idSelectUl.value = currentIdForTrack != null ? currentIdForTrack : '-1';
                (function (inst, sel, camNameForId) {
                    function applyIdentity(newIdVal) {
                        if (newIdVal >= 0) {
                            state.session.assignTrackToIdentity(inst.trackIdx, newIdVal, camNameForId);
                            markDirty();
                            propagateIdentityForward(inst.trackIdx, newIdVal, camNameForId);
                        } else {
                            state.session.clearTrackIdentity(inst.trackIdx, camNameForId);
                            markDirty();
                        }
                        drawAllOverlays(state.currentFrame);
                        updateInfoPanel();
                        if (timeline) timeline.refreshTracks(state.session, { keepSize: true });
                    }
                    sel.addEventListener('change', function (ev) {
                        ev.stopPropagation();
                        if (sel.value === '__new__') {
                            startInlineNameEntry(sel, 'identity_' + state.session.identities.length, function (name) {
                                var existing = state.session.identities.find(function (id) { return id.name === name; });
                                var identity = existing || state.session.addIdentity(name);
                                applyIdentity(identity.id);
                                populateTimelineVisibility(state.session);
                            });
                            return;
                        }
                        applyIdentity(parseInt(sel.value));
                    });
                    sel.addEventListener('click', function (ev) { ev.stopPropagation(); });
                    sel.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
                    sel.addEventListener('mouseup', function (ev) { ev.stopPropagation(); });
                })(ul.instance, idSelectUl, cam.name);
                tdIdUl.appendChild(idSelectUl);

                const tdType = document.createElement('td');
                var instType = ul.instance.type || 'user';
                var typeBadge = document.createElement('span');
                typeBadge.className = 'badge ' + (instType === 'predicted' ? 'badge-predicted' : 'badge-user');
                typeBadge.textContent = instType === 'predicted' ? 'Pred' : 'User';
                tdType.appendChild(typeBadge);

                const tdPoints = document.createElement('td');
                tdPoints.className = 'mono';
                const validPts = ul.instance.points.filter(function (p) { return p !== null; }).length;
                tdPoints.textContent = validPts + '/' + ul.instance.points.length;

                const tdScore = document.createElement('td');
                tdScore.className = 'mono';
                tdScore.textContent = ul.instance.score != null ? ul.instance.score.toFixed(2) : '-';

                tr.appendChild(tdTrackUl);
                tr.appendChild(tdIdUl);
                tr.appendChild(tdType);
                tr.appendChild(tdPoints);
                tr.appendChild(tdScore);

                // Click to toggle assignment selection for this unlinked instance.
                // Skip form-control clicks so the track/identity dropdowns
                // stay open until the user makes a selection.
                (function (unlinked) {
                    tr.addEventListener('click', function (ev) {
                        if (isInteractiveClickTarget(ev && ev.target)) return;
                        if (interactionManager) {
                            interactionManager.select(null, -1);
                            interactionManager.selectedUnlinked = unlinked;
                            if (!interactionManager.assignmentMode) {
                                interactionManager.assignmentMode = true;
                                interactionManager.assignmentSelection = [];
                            }
                            interactionManager.addToAssignmentSelection(unlinked);
                            drawAllOverlays(state.currentFrame);
                            updateInfoPanel();
                        }
                    });
                })(ul);

                ulTbody.appendChild(tr);
            }
        }
    }

    if (hasUnlinked) {
        document.getElementById('unlinkedTable').style.display = '';
        ulEmpty.style.display = 'none';
    } else {
        document.getElementById('unlinkedTable').style.display = 'none';
        ulEmpty.style.display = '';
    }

    // Status bar
    document.getElementById('statusError').textContent = 'Error: ' +
        (meanError != null ? meanError.toFixed(2) + ' px' : '-');

    updateFrameCounters();
}

export function updateTriangulationBadge(type, text) {
    const badge = document.getElementById('triangulationBadge');
    badge.style.display = 'inline-block';
    badge.className = 'triangulation-badge ' + type;
    badge.textContent = text;
    // Auto-hide after 3 seconds
    setTimeout(function () {
        badge.style.display = 'none';
    }, 3000);
}
