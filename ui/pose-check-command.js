/**
 * ui/pose-check-command.js — Tracks ▸ Check Poses: the 2D pose check
 * (pose/pose-check.js) on its own, without tracking anything.
 *
 * Track All scores every prediction it offers the tracker, but its verdicts are
 * never saved, so a reopened project has no ?/✕ marks, no tooltip line and no
 * counts until the next Track All. This command brings them back: it fits each
 * camera's model and scores every prediction of the project
 * (`checkSessionPoses`, pose/pose-check-session.js), with the Tracking Wizard's
 * current thresholds, then puts the result on `session.poseCheck`, redraws the
 * views and says what it found in the status bar.
 *
 * It changes no annotation and no identity — nothing is left out of tracking,
 * because nothing is tracked — so it does NOT mark the project dirty. It runs
 * whatever the "Check 2D poses during tracking" toggle says: that toggle is
 * about Track All, and this is an explicit request.
 */

import { state, getActiveSession } from './app-state.js';
import { getTrackingThreshold } from './settings.js';
import { setStatus } from '../import-export/save-load.js';
import { showLoadingProgress, createProgressPacer, yieldToPaint, hideLoading } from './loading-overlay.js';
import { drawAllOverlays } from './rendering.js';
import { loadAllLazyFrames } from '../pose/triangulation.js';
import { checkSessionPoses, describePoseCheck } from '../pose/pose-check-session.js';

var TITLE = 'Check Poses';

/**
 * Run Tracks ▸ Check Poses on the active session.
 * @returns {Promise<Object|null>} the result now on `session.poseCheck`, or null
 *   when there was nothing to check or the check failed (the status bar says which)
 */
export async function checkPoses() {
    var session = getActiveSession();
    if (!session || !session.cameras || session.cameras.length === 0) {
        setStatus('No session with cameras loaded', 'error');
        return null;
    }
    var loader = session.lazyLoader;
    var windowed = !!(loader && loader.isSync && typeof loader.releaseWindow === 'function');
    if (windowed ? !(loader.nFrames > 0) : (!loader && session.frameIndices.length === 0)) {
        setStatus('No frames to check', 'error');
        return null;
    }
    try {
        showLoadingProgress('Learning each camera\'s poses', 0, 1, { title: TITLE });
        await yieldToPaint();
        // A worker-backed lazy loader keeps no window to read from: hold every
        // frame first, as Track All does for the same loader.
        if (loader && !windowed) {
            await loadAllLazyFrames(function (msg, done, total) {
                showLoadingProgress('Loading frames', done, total, { title: TITLE });
            });
        }
        var pacer = createProgressPacer();
        var res = await checkSessionPoses(session, session.cameras,
            getTrackingThreshold('poseUncommonZ'), getTrackingThreshold('poseOutlierZ'), {
                onProgress: function (done, total) {
                    if (!pacer.due() && done < total) return undefined;
                    showLoadingProgress('Checking 2D poses', done, total, { title: TITLE });
                    return pacer.yield();
                },
            });
        session.poseCheck = res;
        hideLoading();
        drawAllOverlays(state.currentFrame);
        setStatus(describePoseCheck(res), 'success');
        return res;
    } catch (e) {
        hideLoading();
        console.error('[CheckPoses] failed:', e);
        setStatus(TITLE + ' failed: ' + e.message, 'error');
        return null;
    }
}
