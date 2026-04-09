# Decoder Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Chrome crashes during multi-session loading by maintaining a fixed pool of 3 reusable video decoders instead of creating/destroying them per session.

**Architecture:** A `state.decoderPool` array holds persistent `OnDemandVideoDecoder` instances created during first session load. On session switch, pool decoders swap their source via `switchSource()` — same `<video>` elements, new content. No video elements are ever created or destroyed after initialization. Annotations for all sessions load upfront.

**Tech Stack:** Vanilla JS, OnDemandVideoDecoder (video.js), index.html inline script

---

### Task 1: Add decoderPool to state and populate it during first session load

**Files:**
- Modify: `index.html:719-740` (state object)
- Modify: `index.html:11081-11130` (video loading in handleLoadSessionFolderPerCamera, non-deferred path)

- [ ] **Step 1: Add decoderPool to state object**

In `index.html`, find the state object (line ~719) and add `decoderPool`:

```javascript
// Find this line:
            colorByIdentity: false,     // false = color by track, true = color by identity

// Add after it:
            decoderPool: [],            // Persistent OnDemandVideoDecoder instances, reused across session switches
```

- [ ] **Step 2: Register decoders into pool during first session load**

In `handleLoadSessionFolderPerCamera`, after a decoder is created in the non-deferred path (line ~11084-11085), add it to the pool. Find:

```javascript
                            showLoading('Loading video: ' + videoFile.name + '...');
                            try {
                                var decoder = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10 });
                                await decoder.init(videoFile);
                                var vw = decoder.videoTrack.video.width;
                                var vh = decoder.videoTrack.video.height;
```

Add pool registration right after `await decoder.init(videoFile);`:

```javascript
                            showLoading('Loading video: ' + videoFile.name + '...');
                            try {
                                var decoder = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10 });
                                await decoder.init(videoFile);
                                state.decoderPool.push(decoder);
                                var vw = decoder.videoTrack.video.width;
                                var vh = decoder.videoTrack.video.height;
```

- [ ] **Step 3: Verify first session still loads correctly**

Open `localhost:1099`, use Load Multi-Session, pick the parent folder. First session should load with 3 video panes showing video. Check browser console for errors.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Add decoderPool to state, register decoders during first session load"
```

---

### Task 2: Rewrite switchSession to use pool decoders via switchSource

**Files:**
- Modify: `index.html:13602-13710` (switchSession function)

- [ ] **Step 1: Replace switchSession with pool-based implementation**

Replace the entire `switchSession` function (from `async function switchSession(newIdx)` through the closing of the 3D viewport restoration block). The function starts at line ~13602. Replace it with:

```javascript
        async function switchSession(newIdx) {
            if (newIdx === state.activeSessionIdx) return;
            if (newIdx < 0 || newIdx >= state.sessions.length) return;

            // Save current session state
            var oldSession = state.sessions[state.activeSessionIdx];
            oldSession.lastFrame = state.currentFrame;
            oldSession.totalFrames = state.totalFrames;
            oldSession.fps = state.fps;
            oldSession.triangulationResults = state.triangulationResults;
            oldSession._views = null;
            oldSession._videoController = null;

            // Save 3D viewport state
            if (viewport3d && viewport3d.threeCamera && viewport3d.controls) {
                oldSession._viewport3dState = {
                    cameraPosition: viewport3d.threeCamera.position.toArray(),
                    cameraUp: viewport3d.threeCamera.up.toArray(),
                    controlsTarget: viewport3d.controls.target.toArray(),
                };
            }

            // Pause old session
            if (videoController && state.isPlaying) {
                videoController.stopPlayback();
            }

            // Null out old session's decoder references (decoders stay alive in pool)
            for (var ovfi = 0; ovfi < state.videoFiles.length; ovfi++) {
                if (state.videoFiles[ovfi].sessionIdx === state.activeSessionIdx) {
                    state.videoFiles[ovfi].decoder = null;
                }
            }

            // Switch active session
            state.activeSessionIdx = newIdx;
            var newSession = state.sessions[newIdx];
            state.session = newSession;
            state.triangulationResults = newSession.triangulationResults || new Map();

            // Sync trust track labels toggle
            var trustCheck = document.getElementById('menuTrustTracksCheck');
            if (trustCheck) trustCheck.textContent = newSession.trustTracks ? '\u2611' : '\u2610';

            // Rebuild views using pool decoders via switchSource
            videoController = null;
            state.views = [];
            paneManager.clearAll();

            if (newSession.videoFileIndices.length === 0) {
                for (var nvi = 0; nvi < state.videoFiles.length; nvi++) {
                    if (state.videoFiles[nvi].sessionIdx === newIdx) {
                        newSession.videoFileIndices.push(nvi);
                    }
                }
            }

            for (var vi = 0; vi < newSession.videoFileIndices.length; vi++) {
                var vfIdx = newSession.videoFileIndices[vi];
                var vf = state.videoFiles[vfIdx];
                if (vf && vf.file) {
                    showLoading('Loading video: ' + vf.file.name + '...');
                    try {
                        if (vi < state.decoderPool.length) {
                            // Reuse pool decoder — swap source, no new video element
                            await state.decoderPool[vi].switchSource(vf.file);
                            vf.decoder = state.decoderPool[vi];
                        } else {
                            // More cameras than pool size — grow pool
                            var newDec = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10 });
                            await newDec.init(vf.file);
                            state.decoderPool.push(newDec);
                            vf.decoder = newDec;
                        }
                        vf.videoWidth = vf.decoder.videoTrack.video.width;
                        vf.videoHeight = vf.decoder.videoTrack.video.height;
                        vf.frameCount = vf.decoder.samples.length;
                    } catch (e) {
                        console.error('[switchSession] Video load failed:', e);
                    }
                }
                if (vf && vf.decoder) {
                    createViewForVideoFile(vf);
                }
            }
            hideLoading();

            updateTotalFrames();
            paneManager.addAllViewsAsGrid();
            rebuildVideoController();

            var targetFrame = newSession.lastFrame || 0;
            setTimeout(function() {
                fitCanvasesToCells();
                refreshPaneInteractions();
                state.currentFrame = targetFrame;
                if (videoController && state.views.length > 0) {
                    videoController.seekToFrame(targetFrame);
                }
                drawAllOverlays(targetFrame);
            }, 50);
```

Keep everything after this point (the `populateViewStrip()`, `populateSessionStrip()`, 3D viewport restoration, etc.) unchanged.

**Important**: The key difference from the current code is:
- Uses `state.decoderPool[vi]` by index instead of collecting `oldDecoders` from views
- Never calls `close()` on any decoder
- Pool grows if a session has more cameras than pool size

- [ ] **Step 2: Test session switching**

Load multi-session with the 19-session dataset. Click through sessions 1-5 quickly. Verify:
- No Chrome crash
- Videos load in ~1-2s per switch
- Annotations/overlays display correctly
- Frame position is restored when returning to a previously visited session

- [ ] **Step 3: Test clicking through all 19 sessions**

Click through all 19 sessions sequentially. This is the critical test — previously crashed around session 10-11. Should now work because no new video elements are created.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Rewrite switchSession to use decoder pool via switchSource"
```

---

### Task 3: Add switchSession call after multi-session load to display first session

**Files:**
- Modify: `index.html:10136-10140` (end of handleLoadMultiSession loop)

- [ ] **Step 1: Switch to first session after loading completes**

Currently after the multi-session loop finishes, the last session's deferred state is active but has no views. We need to switch to session 0 which has live decoders. Find:

```javascript
                hideLoading();
                setStatus('Loaded ' + sessionDirs.length + ' sessions', 'success');
                populateSessionStrip();
```

Replace with:

```javascript
                hideLoading();
                setStatus('Loaded ' + sessionDirs.length + ' sessions', 'success');

                // Display first session's grid (it has live decoders from eager load)
                if (state.sessions.length > 1) {
                    state.activeSessionIdx = state.sessions.length - 1;
                    await switchSession(0);
                }
                populateSessionStrip();
```

- [ ] **Step 2: Test that first session displays automatically**

Load multi-session. After loading completes, the first session's 3 video panes should appear automatically in a grid without clicking anything. The first frame should be visible.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Auto-display first session grid after multi-session load"
```

---

### Task 4: Update removeSession to work with decoder pool

**Files:**
- Modify: `index.html:13538-13600` (removeSession, view restoration section)

- [ ] **Step 1: Fix removeSession's view rebuild to use pool decoders**

The `removeSession` function has a "first visit — build views" branch (line ~13577-13593) that calls `createViewForVideoFile(vf)` but the video files may have `decoder: null` for deferred sessions. It needs to use the pool. Find:

```javascript
            } else {
                // First visit — build views
                videoController = null;
                state.views = [];
                paneManager.clearAll();
                for (var nvi = 0; nvi < state.session.videoFileIndices.length; nvi++) {
                    var vf = state.videoFiles[state.session.videoFileIndices[nvi]];
                    if (vf && vf.assignedCamera) createViewForVideoFile(vf);
                }
                updateTotalFrames();
                paneManager.addAllViewsAsGrid();
                rebuildVideoController();
                setTimeout(function () {
                    fitCanvasesToCells();
                    refreshPaneInteractions();
                    drawAllOverlays(state.currentFrame);
                }, 50);
            }
```

Replace with:

```javascript
            } else {
                // Build views using pool decoders
                videoController = null;
                state.views = [];
                paneManager.clearAll();
                var rmVi = 0;
                for (var nvi = 0; nvi < state.session.videoFileIndices.length; nvi++) {
                    var vf = state.videoFiles[state.session.videoFileIndices[nvi]];
                    if (vf && vf.file && rmVi < state.decoderPool.length) {
                        // switchSource is async but removeSession is sync — use init for safety
                        // This path is rare (only when removing the active session)
                        vf.decoder = state.decoderPool[rmVi];
                        rmVi++;
                        createViewForVideoFile(vf);
                    }
                }
                updateTotalFrames();
                paneManager.addAllViewsAsGrid();
                rebuildVideoController();
                // Async: swap pool decoders to correct sources
                (async function() {
                    for (var rvi = 0; rvi < state.session.videoFileIndices.length; rvi++) {
                        var rvf = state.videoFiles[state.session.videoFileIndices[rvi]];
                        if (rvf && rvf.file && rvf.decoder) {
                            try {
                                await rvf.decoder.switchSource(rvf.file);
                                rvf.videoWidth = rvf.decoder.videoTrack.video.width;
                                rvf.videoHeight = rvf.decoder.videoTrack.video.height;
                                rvf.frameCount = rvf.decoder.samples.length;
                            } catch (e) { console.error('[removeSession] switchSource failed:', e); }
                        }
                    }
                    updateTotalFrames();
                    if (videoController) videoController.seekToFrame(state.currentFrame);
                })();
                setTimeout(function () {
                    fitCanvasesToCells();
                    refreshPaneInteractions();
                    drawAllOverlays(state.currentFrame);
                }, 50);
            }
```

- [ ] **Step 2: Test session removal**

Load multi-session. Switch to session 3. Delete session 3. Verify the next session loads without crash. Delete a few more sessions to verify stability.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Update removeSession to use decoder pool for view rebuild"
```

---

### Task 5: Verify switchSource handles mp4box re-init correctly

**Files:**
- Modify: `video.js:786-787` (switchSource mp4box call)

- [ ] **Step 1: Check that _initMp4box doesn't crash on re-init**

In `switchSource()` (video.js line ~786), `_initMp4box()` is called without `await` and without a try/catch wrapper. The method creates a new MP4Box instance but the old one wasn't cleaned up. Add cleanup and error handling. Find:

```javascript
        // Re-init mp4box in background
        this._initMp4box();

        videoLog("Source switched: " + (source.name || "file") + " (" + width + "x" + height + ", ~" + totalFrames + " frames)");
```

Replace with:

```javascript
        // Re-init mp4box in background (non-blocking, metadata only)
        try {
            this._initMp4box();
        } catch (e) {
            videoLog("MP4Box re-init failed (HTML5 fallback will be used): " + e.message, "warn");
        }

        videoLog("Source switched: " + (source.name || "file") + " (" + width + "x" + height + ", ~" + totalFrames + " frames)");
```

- [ ] **Step 2: Test that frame-accurate seeking works after source switch**

Load multi-session. Switch to session 2. Wait 3 seconds for mp4box to init in background. Scrub through frames. The frame counter should be accurate (not drifting due to 30fps assumption). Compare frame count in the seekbar to the actual video.

- [ ] **Step 3: Commit**

```bash
git add video.js
git commit -m "Add error handling for mp4box re-init in switchSource"
```

---

### Task 6: End-to-end test — load 19 sessions, click through all of them

**Files:** None (testing only)

- [ ] **Step 1: Full load test**

1. Open `localhost:1099`
2. File → Load Multi-Session
3. Pick `/root/vast/eric/keewui_labels_3dgui/`
4. Wait for all 19 sessions to load (annotations for all, video for first)
5. First session should display automatically with 3 video panes

- [ ] **Step 2: Sequential click test**

Click through all 19 sessions in order (session 1 through 19). For each:
- Videos should load in ~1-2s
- No Chrome crash
- Annotation overlays should appear on correct frames

- [ ] **Step 3: Rapid switching test**

Click back and forth between sessions rapidly (e.g., 1→5→2→8→1→12). Verify:
- No crash
- Videos always load correctly for the target session
- Frame positions are restored

- [ ] **Step 4: Return to first session test**

After visiting several sessions, switch back to session 1. Verify videos load and annotations display correctly — confirms pool decoders successfully swap back to previously-used files.
