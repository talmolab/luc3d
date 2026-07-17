/**
 * tracker-worker.js - Web Worker for batch cross-view tracking.
 * Processes all frames sequentially, posts progress back to main thread.
 *
 * NOTE (Pass 2 Step 4): converted from a classic worker to a module worker.
 * The original `importScripts('pose-data.js', 'triangulation.js', 'tracker.js')`
 * line was removed. No project-file imports were added in its place because
 * this worker is currently dead code (no `new Worker(...)` spawn site exists)
 * and its body references symbols (`CrossViewTracker`, `Detection2D`) that
 * are NOT defined in any current project file. See ISSUES.md I-3 for context.
 *
 * When this worker is wired in for real, it will need:
 *   - real implementations of CrossViewTracker and Detection2D (currently
 *     missing from `./tracker.js`); and
 *   - explicit `import` statements here, e.g.:
 *       import { CrossViewTracker, Detection2D } from './tracker.js';
 *   - the spawn site (in app.js or wherever) updated to:
 *       new Worker(new URL('./pose/tracker-worker.js', import.meta.url),
 *                  { type: 'module' });
 */

var cancelled = false;

self.onmessage = function (e) {
    var msg = e.data;
    if (msg.type === 'cancel') {
        cancelled = true;
        return;
    }
    if (msg.type === 'start') {
        cancelled = false;
        try {
            runTracker(msg.data);
        } catch (err) {
            self.postMessage({ type: 'error', message: err.message + '\n' + err.stack });
        }
    }
};

function runTracker(data) {
    var frames = data.frames;          // [{frameIdx, detections: {camName: [{points, trackIdx}]}}]
    var camerasData = data.cameras;    // [{name, projectionMatrix}]
    var hyperparams = data.hyperparameters || {};
    var total = frames.length;

    var tracker = new CrossViewTracker(hyperparams);

    // Build camera lookup by name
    var camerasByName = {};
    for (var i = 0; i < camerasData.length; i++) {
        camerasByName[camerasData[i].name] = camerasData[i];
    }

    var identityAssignments = [];

    for (var f = 0; f < total; f++) {
        if (cancelled) {
            self.postMessage({ type: 'cancelled', frame: f });
            return;
        }

        var frame = frames[f];

        // Convert plain objects to Detection2D per camera
        var detectionsByCamera = {};
        for (var camName in frame.detections) {
            var camData = camerasByName[camName];
            if (!camData) continue;
            var dets = frame.detections[camName];
            var detection2ds = [];
            for (var d = 0; d < dets.length; d++) {
                detection2ds.push(new Detection2D(
                    dets[d].points,
                    frame.frameIdx,
                    camName,
                    camData.projectionMatrix,
                    null,
                    dets[d].trackIdx
                ));
            }
            detectionsByCamera[camName] = detection2ds;
        }

        // Run tracking per view
        var cameraNames = Object.keys(detectionsByCamera);
        var frameTargetSnapshots = [];

        for (var ci = 0; ci < cameraNames.length; ci++) {
            var cn = cameraNames[ci];
            tracker.prevUnmatchedDetections.delete(cn);
            tracker.algorithmIteration_(detectionsByCamera[cn]);

            frameTargetSnapshots.push(tracker.prevTargets.map(function (t) {
                return {
                    trackId: t.trackId,
                    points: t.points.map(function (p) { return p ? p.slice() : null; })
                };
            }));
        }

        tracker.aggregateKeypoints(frameTargetSnapshots);
        tracker.frameIdx++;

        // Collect identity assignments for this frame
        for (var ti = 0; ti < tracker.prevTargets.length; ti++) {
            var target = tracker.prevTargets[ti];
            target.detectionsByCamera.forEach(function (entry, cn2) {
                if (entry.trackIdx != null) {
                    identityAssignments.push({
                        cameraName: cn2,
                        trackIdx: entry.trackIdx,
                        frameIdx: frame.frameIdx,
                        trackId: target.trackId
                    });
                }
            });
        }

        // Post progress every 100 frames or on last frame
        if (f % 100 === 0 || f === total - 1) {
            self.postMessage({ type: 'progress', frame: f + 1, total: total });
        }
    }

    self.postMessage({
        type: 'complete',
        results: {
            identityAssignments: identityAssignments,
            numTargets: tracker.prevTargets.length
        }
    });
}
