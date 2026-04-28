// import-export/slp-import.js — full SLP/H5 project import + 3D points overlay import
// Pass 3c-2 extraction. Holds the three SLP-import workflows:
// - handleLoadSlpFile: load a fresh SLP project (replaces current state)
// - handleAddSlp: additive merge of an SLP into the current session
// - handleLoadPoints3dH5: overlay reprojected 3D points from an H5 file

import {
    Skeleton, Camera, Instance, UnlinkedInstance, FrameGroup, Identity,
    InstanceGroup, Session,
} from '../pose/pose-data.js?v=1';
import {
    reprojectPoints, computeReprojectionErrors,
    storeReprojectedInstances, getInstanceGroupsForFrame,
} from '../pose/triangulation.js?v=2';
import {
    parseSlpH5, instancePointsMatch, parsePoints3dH5, pickFiles,
} from './file-io.js?v=1';
import {
    validateSkeletonCompatibility, mergeTracksIntoSession,
    mergeSlpFramesIntoSession, rebuildInstanceGroupsForFrames,
} from './slp-merge.js?v=1';
import { OnDemandVideoDecoder, EmbeddedVideoDecoder } from '../loading/video.js?v=1';
import {
    state,
    videoController, interactionManager, viewport3d, timeline, paneManager,
    setVideoController,
} from '../ui/app-state.js?v=1';
import {
    autoAssignVideosToCameras, forceVideoSelection, forceVideoSelectionWithFolder,
    showParentDirMatchSummary, createViewForVideoFile, updateTotalFrames,
    updateGridLayout, createVideoPromptCell, fitCanvasesToCells,
    rebuildVideoController, resolveImportTrackIdx,
} from '../loading/session-loader.js?v=1';
import {
    showLoading, hideLoading, setStatus, clearDirty,
} from './save-load.js?v=1';

// Circular import — these are still defined in app.js for now. They are only
// invoked inside function bodies, never at module-init time, so live-binding
// lookup keeps them functional.
import {
    drawAllOverlays, updateInfoPanel, populateViewStrip, populateSessionStrip,
    fitTimelineToData, setup3DViewport, setReprojErrorVisible,
} from '../app.js?v=16';

export async function handleLoadSlpFile(slpFile) {
    try {

        showLoading('Reading SLP file (' + (slpFile.size / 1024 / 1024).toFixed(1) + ' MB)...');
        console.log('[load-slp] SLP:', slpFile.name);

        // Parse in Web Worker (non-blocking)
        var slpData;
        try {
            slpData = await parseSlpH5(slpFile, function (msg) {
                showLoading(msg);
            });
        } catch (parseErr) {
            console.error('[load-slp] Parse failed:', parseErr);
            hideLoading();
            setStatus('SLP parse error: ' + parseErr.message, 'error');
            return;
        }

        var totalFrames = slpData.frames.length;
        // Count instance types from parsed SLP data
        var slpUserCount = 0, slpPredCount = 0;
        for (var _ti = 0; _ti < slpData.frames.length; _ti++) {
            for (var _tj = 0; _tj < slpData.frames[_ti].instances.length; _tj++) {
                if (slpData.frames[_ti].instances[_tj].type === 'predicted') slpPredCount++;
                else slpUserCount++;
            }
        }
        console.log('[load-slp] Parsed OK:', {
            skeleton: slpData.skeleton ? slpData.skeleton.nodes.length + ' nodes' : 'none',
            tracks: slpData.tracks.length,
            frames: totalFrames,
            videos: slpData.videos.length,
            userInstances: slpUserCount,
            predictedInstances: slpPredCount,
        });

        showLoading('Building sessions...');
        await new Promise(function (r) { setTimeout(r, 0); });

        var skelData = slpData.skeleton || { name: 'skeleton', nodes: [], edges: [] };
        var skeleton = new Skeleton(skelData.name, skelData.nodes, skelData.edges);

        var numSlpSessions = (slpData.sessions && slpData.sessions.length > 0) ? slpData.sessions.length : 1;
        console.log('[load-slp] SLP contains', numSlpSessions, 'session(s)');

        // Pre-compute session names for parent directory matching
        var slpAllSessionNames = [];
        for (var sni = 0; sni < numSlpSessions; sni++) {
            var snName = 'Session ' + (sni + 1);
            if (slpData.sessions && slpData.sessions[sni]) {
                var snMeta = slpData.sessions[sni].metadata;
                if (snMeta && snMeta.lucid && snMeta.lucid.sessionName) snName = snMeta.lucid.sessionName;
                else if (slpData.sessions[sni].name) snName = slpData.sessions[sni].name;
            }
            slpAllSessionNames.push(snName);
        }
        var slpParentFilesMap = null; // Set after user picks parent directory

        // Clear previous state
        if (videoController) {
            if (state.isPlaying) videoController.pause();
            setVideoController(null);
        }
        state.views = [];
        state.videoFiles = [];
        state.sessions = [];
        paneManager.clearAll();

        for (var slpSessIdx = 0; slpSessIdx < numSlpSessions; slpSessIdx++) {
        showLoading('Building session ' + (slpSessIdx + 1) + '/' + numSlpSessions + '...');
        await new Promise(function (r) { setTimeout(r, 0); });

        // 1. Build session from raw worker data
        var cameras = [];
        var videoIdxToCameraName = {};
        if (slpData.sessions && slpData.sessions.length > slpSessIdx) {
            var sessData = slpData.sessions[slpSessIdx];
            var calib = sessData.calibration || {};
            var camMap = sessData.camcorder_to_video_idx_map || {};

            // Don't sort — preserve insertion order from the saved JSON
            var camKeys = Object.keys(calib).filter(function (k) { return k !== 'metadata'; });
            for (var ck = 0; ck < camKeys.length; ck++) {
                var cd = calib[camKeys[ck]];
                if (!cd || typeof cd !== 'object') continue;
                cameras.push(new Camera(
                    cd.name || camKeys[ck],
                    cd.matrix || [[1,0,0],[0,1,0],[0,0,1]],
                    cd.distortions || cd.dist || [0,0,0,0,0],
                    cd.rotation || cd.rvec || [0,0,0],
                    cd.translation || cd.tvec || [0,0,0],
                    cd.size || [640,480]
                ));
            }
            for (var cmk in camMap) {
                var vidIdx = camMap[cmk];
                // Keys may be camera names or numeric indices
                var matchedCam = null;
                for (var mci = 0; mci < cameras.length; mci++) {
                    if (cameras[mci].name === cmk) {
                        matchedCam = cameras[mci];
                        break;
                    }
                }
                if (!matchedCam) {
                    var cmkIdx = parseInt(cmk);
                    if (!isNaN(cmkIdx) && cmkIdx >= 0 && cmkIdx < cameras.length) {
                        matchedCam = cameras[cmkIdx];
                    }
                }
                if (matchedCam) {
                    videoIdxToCameraName[vidIdx] = matchedCam.name;
                }
            }
        }

        // Fallback: use video filenames as camera names
        if (cameras.length === 0) {
            for (var dvi = 0; dvi < Math.max(slpData.videos.length, 1); dvi++) {
                var vMeta = slpData.videos[dvi];
                var dName = vMeta ? (vMeta.sourceFilename || vMeta.filename) : null;
                if (dName && dName !== '.') {
                    dName = dName.replace(/\.[^.]+$/, '').split('/').pop().split('\\').pop();
                } else {
                    dName = 'cam_' + dvi;
                }
                cameras.push(new Camera(dName, [[1,0,0],[0,1,0],[0,0,1]],
                    [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]));
                videoIdxToCameraName[dvi] = dName;
            }
        }

        // Use per-session skeleton/tracks from lucid metadata if available,
        // otherwise fall back to global skeleton/tracks from SLP metadata
        var sessSkeleton = skeleton;
        var sessTracks = slpData.tracks.length > 0 ? slpData.tracks : ['track_0'];
        var sessName = 'Session ' + (slpSessIdx + 1);

        if (slpData.sessions && slpData.sessions[slpSessIdx]) {
            var earlyMeta = slpData.sessions[slpSessIdx].metadata;
            if (earlyMeta && earlyMeta.lucid) {
                if (earlyMeta.lucid.sessionName) sessName = earlyMeta.lucid.sessionName;
                if (earlyMeta.lucid.skeleton) {
                    var sk = earlyMeta.lucid.skeleton;
                    sessSkeleton = new Skeleton(sk.name || 'skeleton', sk.nodes || [], sk.edges || []);
                }
                if (earlyMeta.lucid.tracks) {
                    sessTracks = earlyMeta.lucid.tracks;
                }
            }
        }

        // Build set of video indices that belong to this session
        var sessVideoIndices = new Set();
        for (var svk in videoIdxToCameraName) {
            sessVideoIndices.add(parseInt(svk));
        }

        // Ensure enough track slots for instances in this session
        var maxTrack = 0;
        for (var fri = 0; fri < totalFrames; fri++) {
            var fd = slpData.frames[fri];
            if (sessVideoIndices.size > 0 && !sessVideoIndices.has(fd.videoIdx)) continue;
            for (var ii = 0; ii < fd.instances.length; ii++) {
                if (fd.instances[ii].trackIdx > maxTrack) maxTrack = fd.instances[ii].trackIdx;
            }
        }
        while (sessTracks.length <= maxTrack) sessTracks.push('track_' + sessTracks.length);

        var session = new Session(cameras, sessSkeleton, sessTracks);
        session.name = sessName;

        // Populate FrameGroups from worker's frames array (yield every 20K for UI)
        var BATCH = 20000;
        for (var fi = 0; fi < totalFrames; fi++) {
            var fd2 = slpData.frames[fi];

            // Skip frames that don't belong to this session's cameras
            if (sessVideoIndices.size > 0 && !sessVideoIndices.has(fd2.videoIdx)) continue;

            var camName = videoIdxToCameraName[fd2.videoIdx];
            if (!camName && cameras.length > 0) {
                camName = cameras[fd2.videoIdx % cameras.length].name;
            }
            if (!camName) camName = 'cam_' + fd2.videoIdx;

            var fg = session.frameGroups.get(fd2.frameIdx);
            if (!fg) {
                fg = new FrameGroup(fd2.frameIdx);
                session.addFrameGroup(fg);
            }
            for (var ii2 = 0; ii2 < fd2.instances.length; ii2++) {
                var instData = fd2.instances[ii2];
                var resolvedTi = resolveImportTrackIdx(session, instData.trackIdx, instData.type);
                var inst = new Instance(
                    instData.points,
                    resolvedTi,
                    instData.type || 'user',
                    instData.score || 0
                );
                if (instData.occluded) inst.occluded = instData.occluded;
                fg.addInstance(camName, inst);
            }
            if (fi > 0 && fi % BATCH === 0) {
                showLoading('Building session (' + fi + '/' + totalFrames + ')...');
                await new Promise(function (r) { setTimeout(r, 0); });
            }
        }

        // Restore identities from SLP
        if (slpData.identities && slpData.identities.length > 0) {
            session.identities = slpData.identities.map(function (idData, idx) {
                return new Identity(idx, idData.name || ('id_' + idx), idData.color || null);
            });
            console.log('[load-slp] Loaded', session.identities.length, 'identities');
        }

        // Build InstanceGroups from sessions_json if available (preserves
        // identity-based grouping), otherwise fall back to track-based grouping
        var hasSessionData = slpData.sessions && slpData.sessions.length > slpSessIdx
            && slpData.sessions[slpSessIdx].frame_group_dicts
            && slpData.sessions[slpSessIdx].frame_group_dicts.length > 0;

        if (hasSessionData) {
            // === Reconstruct InstanceGroups from sessions_json ===
            var sessData2 = slpData.sessions[slpSessIdx];
            var fgDicts = sessData2.frame_group_dicts || [];

            // Restore lucid session-level metadata
            var lucidMeta = (sessData2.metadata && sessData2.metadata.lucid) || {};
            if (lucidMeta.trustTracks != null) session.trustTracks = lucidMeta.trustTracks;
            if (lucidMeta.trackIdentityMap) {
                session.trackIdentityMap = new Map(lucidMeta.trackIdentityMap);
            }
            if (lucidMeta.frameIdentityMap) {
                session.frameIdentityMap = new Map(lucidMeta.frameIdentityMap);
            }

            // Build camera key → name map
            var camKeyToName = {};
            var calibKeys = Object.keys(sessData2.calibration || {}).filter(function (k) { return k !== 'metadata'; });
            for (var cki = 0; cki < calibKeys.length; cki++) {
                var ck2 = calibKeys[cki];
                var cd2 = sessData2.calibration[ck2];
                camKeyToName[ck2] = (cd2 && cd2.name) || ck2;
            }

            showLoading('Rebuilding instance groups from session data...');
            await new Promise(function (r) { setTimeout(r, 0); });

            // Build node name list for reconstructing points from dicts
            var nodeNames = session.skeleton.nodes.map(function (n) {
                return typeof n === 'string' ? n : (n.name || '');
            });
            var numNodes = nodeNames.length;

            var restoredGroups = 0, restoredWith3d = 0;
            for (var fdi = 0; fdi < fgDicts.length; fdi++) {
                var fgDict = fgDicts[fdi];
                var fgFrameIdx = fgDict.frame_idx != null ? fgDict.frame_idx : (fgDict.frameIdx || 0);
                var igDicts = fgDict.instance_groups || [];
                if (igDicts.length === 0) continue;

                // Ensure FrameGroup exists
                var fg3 = session.frameGroups.get(fgFrameIdx);
                if (!fg3) {
                    fg3 = new FrameGroup(fgFrameIdx);
                    session.addFrameGroup(fg3);
                }

                // Build groups by creating instances directly from session data
                var groups = [];
                for (var igi = 0; igi < igDicts.length; igi++) {
                    var igDict = igDicts[igi];
                    var identityId = igDict.identity_idx != null ? igDict.identity_idx : -1;
                    if (identityId >= 0 && identityId >= session.identities.length) {
                        console.warn('[load-slp] identity_idx ' + identityId + ' is out of bounds (only ' + session.identities.length + ' identities loaded) — dropping identity assignment');
                        identityId = -1;
                    }
                    var group = new InstanceGroup(Date.now() + Math.random() * 1000 + igi, identityId);

                    // Create instances directly from inline point dicts
                    var igInstances = igDict.instances || {};
                    var igLucid = (igDict.metadata && igDict.metadata.lucid) || {};
                    var instanceMetaMap = igLucid.instanceMeta || {};

                    for (var igCamKey in igInstances) {
                        var igCamName = camKeyToName[igCamKey];
                        if (!igCamName) {
                            console.warn('[load-slp] Camera key "' + igCamKey + '" not found in calibration — 2D instance will use raw key as camera name');
                            igCamName = igCamKey;
                        }
                        var igPointDict = igInstances[igCamKey];
                        var instMeta = instanceMetaMap[igCamName] || instanceMetaMap[igCamKey] || {};

                        // Reconstruct points array from node-name-keyed dict
                        var points = [];
                        var occluded = [];
                        for (var ni = 0; ni < numNodes; ni++) {
                            var ptArr = igPointDict[nodeNames[ni]];
                            if (ptArr && ptArr.length >= 2 && ptArr[0] != null && ptArr[1] != null && isFinite(ptArr[0])) {
                                points.push([ptArr[0], ptArr[1]]);
                                occluded.push(ptArr.length >= 3 && ptArr[2] === 0);
                            } else {
                                points.push(null);
                                occluded.push(false);
                            }
                        }

                        // Use precise metadata if available, otherwise infer from point data
                        var instTrackIdx = instMeta.trackIdx != null ? instMeta.trackIdx : 0;
                        var instType = instMeta.type || 'predicted';
                        var instScore = instMeta.score || 0;

                        var inst = new Instance(points, instTrackIdx, instType, instScore);
                        inst.occluded = occluded;
                        inst.modified = instMeta.modified || false;
                        if (instMeta.nulledNodes) {
                            inst.nulledNodes = new Set(instMeta.nulledNodes);
                        }
                        if (instMeta.occluded) {
                            inst.occluded = instMeta.occluded;
                        }

                        // Pass 1 (above) already added a raw-SLP instance
                        // for this frame/cam to `fg3.instances`. Leaving
                        // it there would leave two Instance objects at
                        // the same position — the group references the
                        // new one (metadata-driven) while the pass-1 one
                        // lingers in fg.instances with whatever trackIdx
                        // the raw SLP had. After a dropdown track swap,
                        // swapAssignTrack only touches the group's ref,
                        // so the pass-1 duplicate keeps its old trackIdx
                        // and (a) contributes a phantom timeline bar and
                        // (b) draws an extra skeleton in the old track
                        // color. Remove the matching pass-1 duplicate
                        // before adding the metadata-driven replacement.
                        var _dupCamInsts = fg3.instances.get(igCamName);
                        if (_dupCamInsts && _dupCamInsts.length > 0) {
                            for (var _dpi = 0; _dpi < _dupCamInsts.length; _dpi++) {
                                if (instancePointsMatch(_dupCamInsts[_dpi].points, points)) {
                                    _dupCamInsts.splice(_dpi, 1);
                                    break;
                                }
                            }
                        }

                        // Add to both the group and the FrameGroup
                        group.addInstance(igCamName, inst);
                        fg3.addInstance(igCamName, inst);
                    }

                    // Restore 3D points
                    if (igDict.points && Array.isArray(igDict.points)) {
                        group.points3d = igDict.points;
                        restoredWith3d++;
                    }

                    groups.push(group);
                    restoredGroups++;
                }

                session.instanceGroups.set(fgFrameIdx, groups);

                if (fdi > 0 && fdi % BATCH === 0) {
                    showLoading('Rebuilding instance groups (' + fdi + '/' + fgDicts.length + ')...');
                    await new Promise(function (r) { setTimeout(r, 0); });
                }
            }
            console.log('[load-slp] Rebuilt', restoredGroups, 'instance groups from session data,', restoredWith3d, 'with 3D points');

        } else {
            // === Fallback: no session_json → treat as a flat 2D SLP
            // and move every loaded instance into the unlinked pool,
            // matching handleLoadSessionFolderPerCamera (line ~12810).
            // Previous behavior grouped by trackIdx unconditionally,
            // which wrapped every single-camera 2D-SLP instance in a
            // trivial one-view InstanceGroup — inconsistent with the
            // session-folder path where the same file loads as
            // ungrouped. Users run the Assign menu when they want
            // cross-view grouping from track/identity data.
            showLoading('Preparing unlinked instances...');
            await new Promise(function (r) { setTimeout(r, 0); });
            var ulFgCount = 0;
            for (var [frameIdx2, fg2] of session.frameGroups) {
                for (var [cn, instances] of fg2.instances) {
                    for (var ulItem of instances) {
                        fg2.addUnlinkedInstance(cn, new UnlinkedInstance(ulItem, cn));
                    }
                    fg2.instances.set(cn, []);
                }
                ulFgCount++;
                if (ulFgCount % BATCH === 0) {
                    showLoading('Preparing unlinked instances (' + ulFgCount + '/' + session.frameGroups.size + ')...');
                    await new Promise(function (r) { setTimeout(r, 0); });
                }
            }
        }

        // Move non-grouped instances into unlinkedInstances so they are
        // interactive (clickable/draggable). Instances in fg.instances that
        // are NOT referenced by any InstanceGroup are "orphan" predictions —
        // they need to be in fg.unlinkedInstances for hit testing to find them.
        var movedToUnlinked = 0;
        for (var [ulFrameIdx, ulFg] of session.frameGroups) {
            var frameGroups = session.instanceGroups.get(ulFrameIdx) || [];
            // Collect all instances that belong to a group
            var groupedInstances = new Set();
            for (var ulGi = 0; ulGi < frameGroups.length; ulGi++) {
                for (var [, gInst] of frameGroups[ulGi].instances) {
                    groupedInstances.add(gInst);
                }
            }
            // Move ungrouped instances to unlinked
            for (var [ulCam, ulInsts] of ulFg.instances) {
                var remaining = [];
                for (var ulI = 0; ulI < ulInsts.length; ulI++) {
                    if (!groupedInstances.has(ulInsts[ulI])) {
                        ulFg.addUnlinkedInstance(ulCam, new UnlinkedInstance(ulInsts[ulI], ulCam));
                        movedToUnlinked++;
                    } else {
                        remaining.push(ulInsts[ulI]);
                    }
                }
                ulFg.instances.set(ulCam, remaining);
            }
        }
        if (movedToUnlinked > 0) {
            console.log('[load-slp] Moved', movedToUnlinked, 'ungrouped instances to unlinked pool');
        }

        // Belt-and-suspenders: drop any unlinked instance whose
        // points align with a grouped instance on the same frame
        // and camera. Pass-2 dedup in the metadata-driven loader
        // catches the common case, but in some SLP files the
        // pass-1 raw points and pass-2 metadata points diverge
        // enough (e.g. null-node distribution, micro precision)
        // to slip past the match — those leftovers render as a
        // second skeleton in the pre-proofreading track color
        // and contribute a phantom track bar on the timeline.
        var extraDedup = 0;
        for (var [ddFrameIdx, ddFg] of session.frameGroups) {
            var ddGroups = session.instanceGroups.get(ddFrameIdx) || [];
            if (ddGroups.length === 0) continue;
            // Build camera → list-of-grouped-points for fast dup detection.
            var groupedByCam = {};
            for (var ddGi = 0; ddGi < ddGroups.length; ddGi++) {
                for (var [ddCam, ddInst] of ddGroups[ddGi].instances) {
                    if (!groupedByCam[ddCam]) groupedByCam[ddCam] = [];
                    groupedByCam[ddCam].push(ddInst.points);
                }
            }
            for (var [ddUlCam, ddUls] of ddFg.unlinkedInstances) {
                var camGrouped = groupedByCam[ddUlCam];
                if (!camGrouped || camGrouped.length === 0) continue;
                var keptUls = [];
                for (var ddUi = 0; ddUi < ddUls.length; ddUi++) {
                    var dup = false;
                    for (var ddGp = 0; ddGp < camGrouped.length; ddGp++) {
                        if (instancePointsMatch(ddUls[ddUi].instance.points, camGrouped[ddGp])) {
                            dup = true;
                            break;
                        }
                    }
                    if (dup) { extraDedup++; continue; }
                    keptUls.push(ddUls[ddUi]);
                }
                ddFg.unlinkedInstances.set(ddUlCam, keptUls);
            }
        }
        if (extraDedup > 0) {
            console.log('[load-slp] Dropped', extraDedup, 'unlinked duplicates that matched grouped instances by position');
        }

        // Recompute reprojections from stored 3D points + calibration
        if (session.cameras.length >= 2) {
            var hasAny3d = false;
            for (var [, groups3d] of session.instanceGroups) {
                for (var g3d of groups3d) {
                    if (g3d.points3d && g3d.points3d.some(function (p) { return p != null; })) {
                        hasAny3d = true;
                        break;
                    }
                }
                if (hasAny3d) break;
            }
            if (hasAny3d) {
                showLoading('Recomputing reprojections from 3D data...');
                await new Promise(function (r) { setTimeout(r, 0); });
                var sessTriResults = new Map();
                for (var [frameIdx3, groups3] of session.instanceGroups) {
                    var frameTriResults = [];
                    for (var grp of groups3) {
                        if (!grp.points3d || !grp.points3d.some(function (p) { return p != null; })) continue;
                        // Build reprojections from 3D points for each camera
                        var reprojResult = { reprojections: {}, points3d: grp.points3d };
                        for (var ci2 = 0; ci2 < session.cameras.length; ci2++) {
                            var cam2 = session.cameras[ci2];
                            if (cam2.projectionMatrix) {
                                reprojResult.reprojections[cam2.name] = reprojectPoints(grp.points3d, cam2.projectionMatrix);
                            }
                        }
                        grp.reprojections = reprojResult.reprojections;
                        storeReprojectedInstances(grp, reprojResult, session.cameras);

                        // Build observedPoints from group's 2D instances
                        grp.observedPoints = {};
                        for (var ci3 = 0; ci3 < session.cameras.length; ci3++) {
                            var obsInst = grp.getInstance(session.cameras[ci3].name);
                            if (obsInst) grp.observedPoints[session.cameras[ci3].name] = obsInst.points;
                        }

                        // Compute per-camera reprojection errors
                        var trErrors = {};
                        var trTotalErr = 0, trTotalCount = 0;
                        for (var trCamName in grp.reprojections) {
                            var trObs = grp.observedPoints[trCamName];
                            var trRep = grp.reprojections[trCamName];
                            if (trObs && trRep) {
                                trErrors[trCamName] = computeReprojectionErrors(trObs, trRep);
                                for (var ei = 0; ei < trErrors[trCamName].length; ei++) {
                                    if (trErrors[trCamName][ei] != null) {
                                        trTotalErr += trErrors[trCamName][ei];
                                        trTotalCount++;
                                    }
                                }
                            }
                        }

                        frameTriResults.push({
                            group: grp,
                            points3d: grp.points3d,
                            reprojections: grp.reprojections,
                            errors: trErrors,
                            meanError: trTotalCount > 0 ? trTotalErr / trTotalCount : null
                        });

                        grp.markClean();
                    }
                    if (frameTriResults.length > 0) {
                        sessTriResults.set(frameIdx3, frameTriResults);
                    }
                }
                session.triangulationResults = sessTriResults;
                console.log('[load-slp] Recomputed reprojections from 3D data (' + sessTriResults.size + ' frames with results)');
            }
        }

        console.log('[load-slp] Session', slpSessIdx, 'name:', session.name,
            'skeleton:', session.skeleton.nodes.length, 'nodes,', session.skeleton.edges.length, 'edges');

        state.sessions.push(session);
        state.session = session;
        state.activeSessionIdx = state.sessions.length - 1;

        console.log('[load-slp] Session', slpSessIdx + 1, ':', session.numFrames, 'frames,',
            cameras.length, 'cameras, tracks:', session.tracks);

        // 2. Video loading — embedded or external
        var hasEmbedded = slpData.videos.some(function (v) { return v.embedded; });

        if (hasEmbedded) {
            // --- Embedded videos: use frame-worker for on-demand extraction ---
            showLoading('Loading embedded video frames...');

            var frameWorker = new Worker(new URL('../loading/frame-worker.js', import.meta.url), { type: 'module' });
            var embeddedVideoInfos = await new Promise(function (resolve, reject) {
                frameWorker.onmessage = function (e) {
                    var msg = e.data;
                    if (msg.type === 'ready') {
                        frameWorker.postMessage({ type: 'loadFile', file: slpFile });
                    } else if (msg.type === 'loaded') {
                        resolve(msg.videos || []);
                    } else if (msg.type === 'error') {
                        reject(new Error(msg.error || 'Frame worker error'));
                    }
                };
                frameWorker.onerror = function (err) {
                    reject(new Error('Frame worker failed: ' + (err.message || 'unknown')));
                };
            });

            console.log('[load-slp] Frame worker loaded, embedded videos:', embeddedVideoInfos.length);

            for (var evi = 0; evi < embeddedVideoInfos.length; evi++) {
                var evInfo = embeddedVideoInfos[evi];
                var evCamName = videoIdxToCameraName[evInfo.idx] || ('cam_' + evInfo.idx);
                var evWidth = evInfo.width || 0;
                var evHeight = evInfo.height || 0;

                // Probe first frame for dimensions if needed
                if (!evWidth || !evHeight) {
                    try {
                        showLoading('Probing dimensions for ' + evInfo.key + '...');
                        var probeResult = await new Promise(function (res) {
                            var handler = function (e2) {
                                if (e2.data.type === 'frame' && e2.data.videoKey === evInfo.key) {
                                    frameWorker.removeEventListener('message', handler);
                                    res(e2.data);
                                }
                            };
                            frameWorker.addEventListener('message', handler);
                            frameWorker.postMessage({ type: 'getFrame', videoKey: evInfo.key, embeddedIdx: 0 });
                        });
                        var probeMime = (probeResult.format === 'jpg' || probeResult.format === 'jpeg')
                            ? 'image/jpeg' : 'image/png';
                        var probeBmp = await createImageBitmap(new Blob([probeResult.pngBytes], { type: probeMime }));
                        evWidth = probeBmp.width;
                        evHeight = probeBmp.height;
                        probeBmp.close();
                    } catch (probeErr) {
                        console.warn('[load-slp] Could not probe frame dimensions:', probeErr);
                        evWidth = evWidth || 640;
                        evHeight = evHeight || 480;
                    }
                }

                var decoder = new EmbeddedVideoDecoder({
                    worker: frameWorker,
                    videoInfo: evInfo,
                    cacheSize: 60,
                });
                if (evWidth && evHeight) {
                    decoder.videoTrack.video.width = evWidth;
                    decoder.videoTrack.video.height = evHeight;
                }

                var evSlpVideo = slpData.videos[evInfo.idx];
                var evVideoPath = evSlpVideo
                    ? (evSlpVideo.sourceFilename || evSlpVideo.filename || null)
                    : null;
                if (evVideoPath === '.') evVideoPath = null;

                state.videoFiles.push({
                    file: null, name: evCamName, decoder: decoder,
                    videoWidth: evWidth, videoHeight: evHeight,
                    frameCount: decoder.samples.length,
                    assignedCamera: evCamName,
                    // slpFilename intentionally null — the loaded
                    // LUCID project SLP is not a per-camera SLP, so
                    // the 2D export modal should fall back to
                    // video/camera name (there's no directory to
                    // scan for real per-camera SLPs in the embedded
                    // case).
                    slpFilename: null,
                    videoPath: evVideoPath || (evCamName + '.mp4'),
                });
            }

            state._frameWorker = frameWorker;

            for (var evi2 = 0; evi2 < state.videoFiles.length; evi2++) {
                createViewForVideoFile(state.videoFiles[evi2]);
            }
        } else {
            // --- No embedded videos: prompt for session folder ---
            hideLoading();

            // Extract camera names for the folder prompt
            var slpCameraNames = cameras.map(function (c) { return c.name; });
            var refInfo = slpCameraNames.length > 0
                ? 'Cameras: ' + slpCameraNames.join(', ')
                : '(select folder with video files)';
            console.log('[load-slp] Prompting for session folder, cameras:', slpCameraNames);

            // Prompt for session folder — with parent directory option for multi-session
            var videoFiles;
            var currentSessName = session.name || 'Session';
            if (slpParentFilesMap && slpParentFilesMap.has(currentSessName)) {
                // Already resolved from parent directory pick
                videoFiles = slpParentFilesMap.get(currentSessName);
            } else if (slpParentFilesMap) {
                // Parent dir was picked but this session wasn't matched — prompt individually
                videoFiles = await forceVideoSelectionWithFolder(refInfo, currentSessName);
                if (videoFiles && videoFiles.parentResult) videoFiles = [];
            } else {
                // Offer parent directory option on first prompt
                var slpPromptResult = await forceVideoSelectionWithFolder(
                    refInfo, currentSessName,
                    numSlpSessions > 1 ? { allSessionNames: slpAllSessionNames } : null
                );

                if (slpPromptResult && slpPromptResult.parentResult) {
                    slpParentFilesMap = slpPromptResult.parentResult.matched;
                    var slpUnmatched = slpPromptResult.parentResult.unmatched;
                    await showParentDirMatchSummary(slpParentFilesMap, slpUnmatched);
                    videoFiles = slpParentFilesMap.has(currentSessName) ? slpParentFilesMap.get(currentSessName) : [];
                } else {
                    videoFiles = slpPromptResult;
                }
            }

            if (videoFiles && videoFiles.length > 0) {
                // Filter to video files only
                var vidExts = ['.mp4', '.avi', '.mov', '.mkv', '.webm'];
                var vidFiles = Array.from(videoFiles).filter(function (f) {
                    var ext = f.name.substring(f.name.lastIndexOf('.')).toLowerCase();
                    return vidExts.indexOf(ext) >= 0;
                });
                var cameraNames = cameras.map(function (c) { return c.name; });

                for (var mvi = 0; mvi < vidFiles.length; mvi++) {
                    var vFile = vidFiles[mvi];
                    var stem = vFile.name.replace(/\.[^.]+$/, '');
                    showLoading('Loading ' + vFile.name + ' (' + (mvi + 1) + '/' + vidFiles.length + ')...');
                    try {
                        var vdec = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10 });
                        await vdec.init(vFile);

                        // Match to camera by parent directory name or filename
                        var assignedCam = null;
                        var relPath = vFile.webkitRelativePath || vFile.name;
                        var pathParts = relPath.split('/');
                        var parentDir = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : null;

                        // Try parent directory name → camera name
                        if (parentDir && cameraNames.indexOf(parentDir) >= 0) {
                            assignedCam = parentDir;
                        }
                        // Try video stem → camera name
                        if (!assignedCam && cameraNames.indexOf(stem) >= 0) {
                            assignedCam = stem;
                        }
                        // Try matching against SLP video references
                        if (!assignedCam) {
                            for (var cmi in videoIdxToCameraName) {
                                var camN = videoIdxToCameraName[cmi];
                                var vMeta = slpData.videos[cmi];
                                if (!vMeta) continue;
                                var refPath = vMeta.sourceFilename || vMeta.filename || '';
                                if (refPath === '.') continue;
                                var refBase = refPath.replace(/^.*[\/\\]/, '').replace(/\.[^.]+$/, '').toLowerCase();
                                if (stem.toLowerCase() === refBase || stem.toLowerCase().indexOf(refBase) >= 0) {
                                    assignedCam = camN;
                                    break;
                                }
                            }
                        }

                        state.videoFiles.push({
                            file: vFile, name: stem, decoder: vdec,
                            videoWidth: vdec.videoTrack.video.width,
                            videoHeight: vdec.videoTrack.video.height,
                            frameCount: vdec.samples.length,
                            assignedCamera: assignedCam,
                            // slpFilename resolved below after scanning
                            // the picked directory for per-camera SLPs.
                            slpFilename: null,
                            videoPath: vFile.webkitRelativePath || vFile.name,
                            sessionIdx: slpSessIdx,
                        });
                    } catch (videoErr) {
                        console.error('[load-slp] Failed to load ' + vFile.name + ':', videoErr);
                    }
                }

                // Scan the picked directory for per-camera .slp files
                // (sibling to each camera's video), picking the
                // highest-version one per camera. This drives the 2D
                // export modal's default filename (modal reads
                // vf.slpFilename and increments the _vNN suffix) so
                // LUCID-project-loaded sessions match the behavior of
                // session-folder-loaded sessions.
                var camSlpMap = {};
                for (var dfi = 0; dfi < videoFiles.length; dfi++) {
                    var df = videoFiles[dfi];
                    if (!df || !df.name) continue;
                    if (!/\.slp$/i.test(df.name)) continue;
                    var drel = df.webkitRelativePath || df.name;
                    var dparts = drel.split('/');
                    var dparent = dparts.length >= 2 ? dparts[dparts.length - 2] : null;
                    if (!dparent || cameraNames.indexOf(dparent) < 0) continue;
                    if (!camSlpMap[dparent]) camSlpMap[dparent] = [];
                    camSlpMap[dparent].push(df.name);
                }
                function _highestVersionSlp(names) {
                    var best = null, bestVer = -1;
                    for (var ni = 0; ni < names.length; ni++) {
                        var nm = names[ni];
                        var nstem = nm.replace(/\.[^.]+$/, '');
                        var vm = nstem.match(/_(?:3D_)?v(\d+)$/);
                        var ver = vm ? parseInt(vm[1]) : 0;
                        if (ver > bestVer) { bestVer = ver; best = nm; }
                        else if (best === null) { best = nm; }
                    }
                    return best;
                }
                for (var ufi = 0; ufi < state.videoFiles.length; ufi++) {
                    var uvf = state.videoFiles[ufi];
                    if (uvf.sessionIdx !== slpSessIdx) continue;
                    var ucam = uvf.assignedCamera;
                    if (!ucam) continue;
                    var names = camSlpMap[ucam];
                    if (names && names.length > 0) {
                        uvf.slpFilename = _highestVersionSlp(names);
                    }
                }

                autoAssignVideosToCameras();

                // Don't create views yet — wait until after session loop
                // so we only create views for the active session
            }
        }

        // Track which video file indices belong to this session
        session.videoFileIndices = [];
        for (var svfi = 0; svfi < state.videoFiles.length; svfi++) {
            if (state.videoFiles[svfi].sessionIdx === slpSessIdx) {
                session.videoFileIndices.push(svfi);
            }
        }

        } // end session loop

        // Set active session to the first one
        if (state.sessions.length > 0) {
            state.activeSessionIdx = 0;
            state.session = state.sessions[0];
        }

        // Create views for the active session only
        showLoading('Creating views...');
        for (var vi2 = 0; vi2 < state.videoFiles.length; vi2++) {
            var vf3 = state.videoFiles[vi2];
            if (vf3.sessionIdx !== state.activeSessionIdx) continue;
            if (vf3.assignedCamera) {
                var hasView = state.views.some(function (v) { return v.name === vf3.assignedCamera; });
                if (!hasView) createViewForVideoFile(vf3);
            }
        }

        updateTotalFrames();
        if (state.views.length > 0) {
            populateViewStrip();
            populateSessionStrip();
            paneManager.addAllViewsAsGrid();
            rebuildVideoController();
            fitCanvasesToCells();
        }

        // Seek to first labeled frame
        if (videoController && state.views.length > 0 && state.session) {
            var firstFrame = 0;
            var sortedFrames = state.session.frameIndices;
            if (sortedFrames.length > 0) firstFrame = sortedFrames[0];
            state.currentFrame = firstFrame;
            await videoController.seekToFrame(firstFrame);
        }

        // 3. Set up 3D viewport
        if (state.session && state.session.cameras.length > 0) {
            if (viewport3d) {
                viewport3d.cameras = state.session.cameras;
                viewport3d.skeleton = skeleton;
                viewport3d.addCameraPyramids();
                viewport3d.setFrame(getInstanceGroupsForFrame(state.currentFrame));
                viewport3d.fitToScene();
            } else {
                setup3DViewport();
            }
        }

        // 4. Restore triangulation results for the active session
        state.triangulationResults = (state.session && state.session.triangulationResults) || new Map();
        if (state.triangulationResults.size > 0) {
            setReprojErrorVisible(true);
        }

        // 5. Draw overlays and update UI
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) {
            timeline.setData(state.session);
            // Grow the container to fit every track row — otherwise
            // the collapse-priority layout in _computeLayout hides
            // all tracks (showTracks=false) when the natural track
            // block exceeds the default container height. Without
            // this the timeline looks "empty" after an SLP load.
            fitTimelineToData();
        }

        if (interactionManager && state.views.length > 0) {
            interactionManager.detach();
            interactionManager.attach(state.views);
        }

        clearDirty();
        hideLoading();
        var statusParts = [state.sessions.length + ' session(s)', skeleton.nodes.length + ' nodes'];
        if (state.session) statusParts.push(state.session.numFrames + ' labeled frames');
        if (state.views.length > 0) statusParts.push(state.views.length + ' views');
        setStatus('SLP loaded (' + statusParts.join(', ') + ')', 'success');
    } catch (err) {
        console.error('[load-slp] FATAL:', err);
        hideLoading();
        setStatus('SLP load error: ' + err.message, 'error');
    }
}

// ============================================
// Add SLP (Additive Merge)
// ============================================

export async function handleAddSlp() {
    try {
        setStatus('Pick SLP file to add...', 'warning');
        var slpFiles = await pickFiles({ accept: '.slp,.h5' });
        if (slpFiles.length === 0) {
            setStatus('No file selected', 'warning');
            return;
        }
        var slpFile = slpFiles[0];

        showLoading('Reading SLP file (' + (slpFile.size / 1024 / 1024).toFixed(1) + ' MB)...');
        console.log('[add-slp] SLP:', slpFile.name);

        var slpData;
        try {
            slpData = await parseSlpH5(slpFile, function (msg) {
                showLoading(msg);
            });
        } catch (parseErr) {
            console.error('[add-slp] Parse failed:', parseErr);
            hideLoading();
            setStatus('SLP parse error: ' + parseErr.message, 'error');
            return;
        }

        var addSlpUserCount = 0, addSlpPredCount = 0;
        for (var _ai = 0; _ai < slpData.frames.length; _ai++) {
            for (var _aj = 0; _aj < slpData.frames[_ai].instances.length; _aj++) {
                if (slpData.frames[_ai].instances[_aj].type === 'predicted') addSlpPredCount++;
                else addSlpUserCount++;
            }
        }
        console.log('[add-slp] Parsed OK:', {
            skeleton: slpData.skeleton ? slpData.skeleton.nodes.length + ' nodes' : 'none',
            tracks: slpData.tracks.length,
            frames: slpData.frames.length,
            videos: slpData.videos.length,
            userInstances: addSlpUserCount,
            predictedInstances: addSlpPredCount,
        });

        showLoading('Merging into session...');
        await new Promise(function (r) { setTimeout(r, 0); });

        // Build incoming skeleton, cameras, tracks
        var skelData = slpData.skeleton || { name: 'skeleton', nodes: [], edges: [] };
        var skeleton = new Skeleton(skelData.name, skelData.nodes, skelData.edges);

        var cameras = [];
        var videoIdxToCameraName = {};
        if (slpData.sessions && slpData.sessions.length > 0) {
            var sessData = slpData.sessions[0];
            var calib = sessData.calibration || {};
            var camMap = sessData.camcorder_to_video_idx_map || {};
            // Don't sort — preserve insertion order from the saved JSON
            var camKeys = Object.keys(calib).filter(function (k) { return k !== 'metadata'; });
            for (var ck = 0; ck < camKeys.length; ck++) {
                var cd = calib[camKeys[ck]];
                if (!cd || typeof cd !== 'object') continue;
                cameras.push(new Camera(
                    cd.name || camKeys[ck],
                    cd.matrix || [[1,0,0],[0,1,0],[0,0,1]],
                    cd.distortions || cd.dist || [0,0,0,0,0],
                    cd.rotation || cd.rvec || [0,0,0],
                    cd.translation || cd.tvec || [0,0,0],
                    cd.size || [640,480]
                ));
            }
            for (var cmk in camMap) {
                var vidIdx = camMap[cmk];
                // Keys may be camera names or numeric indices
                var matchedCam = null;
                for (var mci = 0; mci < cameras.length; mci++) {
                    if (cameras[mci].name === cmk) {
                        matchedCam = cameras[mci];
                        break;
                    }
                }
                if (!matchedCam) {
                    var cmkIdx = parseInt(cmk);
                    if (!isNaN(cmkIdx) && cmkIdx >= 0 && cmkIdx < cameras.length) {
                        matchedCam = cameras[cmkIdx];
                    }
                }
                if (matchedCam) {
                    videoIdxToCameraName[vidIdx] = matchedCam.name;
                }
            }
        }

        // Fallback: use video filenames as camera names
        if (cameras.length === 0) {
            for (var dvi = 0; dvi < Math.max(slpData.videos.length, 1); dvi++) {
                var vMeta = slpData.videos[dvi];
                var dName = vMeta ? (vMeta.sourceFilename || vMeta.filename) : null;
                if (dName && dName !== '.') {
                    dName = dName.replace(/\.[^.]+$/, '').split('/').pop().split('\\').pop();
                } else {
                    dName = 'cam_' + dvi;
                }
                cameras.push(new Camera(dName, [[1,0,0],[0,1,0],[0,0,1]],
                    [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]));
                videoIdxToCameraName[dvi] = dName;
            }
        }

        var tracks = slpData.tracks.length > 0 ? slpData.tracks : ['track_0'];
        var maxTrack = 0;
        for (var fri = 0; fri < slpData.frames.length; fri++) {
            var fd = slpData.frames[fri];
            for (var ii = 0; ii < fd.instances.length; ii++) {
                if (fd.instances[ii].trackIdx > maxTrack) maxTrack = fd.instances[ii].trackIdx;
            }
        }
        while (tracks.length <= maxTrack) tracks.push('track_' + tracks.length);

        // Validate skeleton compatibility (set-based, allows reordering)
        var skelResult = validateSkeletonCompatibility(state.session.skeleton, skeleton);
        console.log('[add-slp] Skeleton validation:', skelResult);
        if (skelResult.error) {
            hideLoading();
            setStatus('Skeleton mismatch: ' + skelResult.error, 'error');
            return;
        }
        var nodeReorderMap = skelResult.reorderMap;

        // Auto-rename duplicate camera names
        for (var aci = 0; aci < cameras.length; aci++) {
            var addCamName = cameras[aci].name;
            var isDuplicate = state.session.cameras.some(function (c) { return c.name === addCamName; });
            if (isDuplicate) {
                var suffix = 2;
                while (state.session.cameras.some(function (c) { return c.name === addCamName + '_' + suffix; })) {
                    suffix++;
                }
                var newName = addCamName + '_' + suffix;
                console.log('[add-slp] Camera "' + addCamName + '" already exists, renaming to "' + newName + '"');
                cameras[aci].name = newName;
                for (var vk in videoIdxToCameraName) {
                    if (videoIdxToCameraName[vk] === addCamName) {
                        videoIdxToCameraName[vk] = newName;
                    }
                }
            }
        }

        // Merge tracks
        var trackRemap = mergeTracksIntoSession(state.session, tracks);

        // Add cameras to session
        for (var aci2 = 0; aci2 < cameras.length; aci2++) {
            state.session.cameras.push(cameras[aci2]);
        }

        // Merge frames (with node reorder map if needed)
        var affectedFrames = mergeSlpFramesIntoSession(state.session, slpData, videoIdxToCameraName, cameras, trackRemap, nodeReorderMap);

        // Rebuild instance groups for affected frames
        rebuildInstanceGroupsForFrames(state.session, affectedFrames);

        console.log('[add-slp] Merged ' + cameras.length + ' camera(s), ' + affectedFrames.length + ' frames affected');

        // Create video views or prompt cells for new cameras
        var hasEmbedded = slpData.videos.some(function (v) { return v.embedded; });

        if (hasEmbedded) {
            showLoading('Loading embedded video frames...');

            var frameWorker = new Worker(new URL('../loading/frame-worker.js', import.meta.url), { type: 'module' });
            var embeddedVideoInfos = await new Promise(function (resolve, reject) {
                frameWorker.onmessage = function (e) {
                    var msg = e.data;
                    if (msg.type === 'ready') {
                        frameWorker.postMessage({ type: 'loadFile', file: slpFile });
                    } else if (msg.type === 'loaded') {
                        resolve(msg.videos || []);
                    } else if (msg.type === 'error') {
                        reject(new Error(msg.error || 'Frame worker error'));
                    }
                };
                frameWorker.onerror = function (err) {
                    reject(new Error('Frame worker failed: ' + (err.message || 'unknown')));
                };
            });

            for (var mevi = 0; mevi < embeddedVideoInfos.length; mevi++) {
                var mevInfo = embeddedVideoInfos[mevi];
                var mevCamName = videoIdxToCameraName[mevInfo.idx] || ('cam_' + mevInfo.idx);
                var mevWidth = mevInfo.width || 0;
                var mevHeight = mevInfo.height || 0;

                if (!mevWidth || !mevHeight) {
                    try {
                        showLoading('Probing frame dimensions...');
                        var mProbeResult = await new Promise(function (res) {
                            var handler = function (e2) {
                                if (e2.data.type === 'frame' && e2.data.videoKey === mevInfo.key) {
                                    frameWorker.removeEventListener('message', handler);
                                    res(e2.data);
                                }
                            };
                            frameWorker.addEventListener('message', handler);
                            frameWorker.postMessage({ type: 'getFrame', videoKey: mevInfo.key, embeddedIdx: 0 });
                        });
                        var mProbeMime = (mProbeResult.format === 'jpg' || mProbeResult.format === 'jpeg')
                            ? 'image/jpeg' : 'image/png';
                        var mProbeBmp = await createImageBitmap(new Blob([mProbeResult.pngBytes], { type: mProbeMime }));
                        mevWidth = mProbeBmp.width;
                        mevHeight = mProbeBmp.height;
                        mProbeBmp.close();
                    } catch (mProbeErr) {
                        console.warn('[add-slp] Could not probe frame dimensions:', mProbeErr);
                        mevWidth = mevWidth || 640;
                        mevHeight = mevHeight || 480;
                    }
                }

                var mDecoder = new EmbeddedVideoDecoder({
                    worker: frameWorker,
                    videoInfo: mevInfo,
                    cacheSize: 60,
                });
                if (mevWidth && mevHeight) {
                    mDecoder.videoTrack.video.width = mevWidth;
                    mDecoder.videoTrack.video.height = mevHeight;
                }

                var mevSlpVideo = slpData.videos[mevInfo.idx];
                var mevVideoPath = mevSlpVideo
                    ? (mevSlpVideo.sourceFilename || mevSlpVideo.filename || null)
                    : null;
                if (mevVideoPath === '.') mevVideoPath = null;

                var mVideoEntry = {
                    file: null, name: mevCamName, decoder: mDecoder,
                    videoWidth: mevWidth, videoHeight: mevHeight,
                    frameCount: mDecoder.samples.length,
                    assignedCamera: mevCamName,
                    videoPath: mevVideoPath || (mevCamName + '.mp4'),
                };
                state.videoFiles.push(mVideoEntry);
                createViewForVideoFile(mVideoEntry);
            }

            populateViewStrip();
            populateSessionStrip();
            updateTotalFrames();
            rebuildVideoController();
            requestAnimationFrame(function () { fitCanvasesToCells(); });

            if (videoController) {
                await videoController.seekToFrame(state.currentFrame);
            }
        } else {
            // --- No embedded videos: prompt for video files ---
            hideLoading();

            // Extract video basenames from SLP metadata
            var addSlpVideoRefs = slpData.videos.map(function (v) {
                var fn = v.sourceFilename || v.filename || '';
                if (fn === '.') return '';
                return fn.replace(/^.*[\/\\]/, '');
            });
            var addRefInfo = addSlpVideoRefs.filter(function (r) { return r; }).join(', ') || '(unknown)';
            console.log('[add-slp] SLP references videos:', addSlpVideoRefs);

            // Show blocking overlay forcing user to select video files
            var addVideoFiles = await forceVideoSelection(addRefInfo);

            if (addVideoFiles.length > 0) {
                for (var amvi = 0; amvi < addVideoFiles.length; amvi++) {
                    var amvFile = addVideoFiles[amvi];
                    var amvStem = amvFile.name.replace(/\.[^.]+$/, '');
                    showLoading('Loading ' + amvFile.name + ' (' + (amvi + 1) + '/' + addVideoFiles.length + ')...');
                    try {
                        var amvDec = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10 });
                        await amvDec.init(amvFile);

                        // Match to SLP video reference by filename
                        var amvCam = null;
                        var amvMatchedVideoPath = null;
                        var amvStemLower = amvStem.toLowerCase();
                        for (var arvi = 0; arvi < addSlpVideoRefs.length; arvi++) {
                            var aRefName = addSlpVideoRefs[arvi];
                            if (!aRefName) continue;
                            var aRefStem = aRefName.replace(/\.[^.]+$/, '').toLowerCase();
                            if (amvFile.name.toLowerCase() === aRefName.toLowerCase() ||
                                amvStemLower === aRefStem ||
                                amvStemLower.indexOf(aRefStem) >= 0 ||
                                aRefStem.indexOf(amvStemLower) >= 0) {
                                if (videoIdxToCameraName[arvi]) {
                                    amvCam = videoIdxToCameraName[arvi];
                                }
                                var amvMeta = slpData.videos[arvi];
                                if (amvMeta) {
                                    var amvOrigPath = amvMeta.sourceFilename || amvMeta.filename || null;
                                    if (amvOrigPath && amvOrigPath !== '.') amvMatchedVideoPath = amvOrigPath;
                                }
                                break;
                            }
                        }
                        // Fallback: match by camera name (exact)
                        if (!amvCam) {
                            for (var aci3 = 0; aci3 < cameras.length; aci3++) {
                                if (cameras[aci3].name.toLowerCase() === amvStemLower) {
                                    amvCam = cameras[aci3].name;
                                    break;
                                }
                            }
                        }
                        // Fallback: substring match between video name and camera name
                        if (!amvCam) {
                            for (var aci4 = 0; aci4 < cameras.length; aci4++) {
                                var aci4Lower = cameras[aci4].name.toLowerCase();
                                var aci4Used = state.videoFiles.some(function (o) { return o.assignedCamera === cameras[aci4].name; });
                                if (aci4Used) continue;
                                if (amvStemLower.indexOf(aci4Lower) >= 0 || aci4Lower.indexOf(amvStemLower) >= 0) {
                                    amvCam = cameras[aci4].name;
                                    console.log('[add-slp] Substring-matched video "' + amvStem + '" to camera "' + amvCam + '"');
                                    break;
                                }
                            }
                        }
                        // Fallback: assign to first newly-added camera that has no video yet
                        if (!amvCam) {
                            for (var aci5 = 0; aci5 < cameras.length; aci5++) {
                                var aci5Used = state.videoFiles.some(function (o) { return o.assignedCamera === cameras[aci5].name; });
                                if (!aci5Used) {
                                    amvCam = cameras[aci5].name;
                                    console.log('[add-slp] Index-fallback assigned video "' + amvStem + '" to camera "' + amvCam + '"');
                                    break;
                                }
                            }
                        }

                        var amvEntry = {
                            file: amvFile, name: amvStem, decoder: amvDec,
                            videoWidth: amvDec.videoTrack.video.width,
                            videoHeight: amvDec.videoTrack.video.height,
                            frameCount: amvDec.samples.length,
                            assignedCamera: amvCam,
                            videoPath: amvMatchedVideoPath || amvFile.webkitRelativePath || amvFile.name,
                        };
                        state.videoFiles.push(amvEntry);
                        if (amvCam) createViewForVideoFile(amvEntry);
                    } catch (amvErr) {
                        console.error('[add-slp] Failed to load ' + amvFile.name + ':', amvErr);
                    }
                }
                populateViewStrip();
                populateSessionStrip();
                updateTotalFrames();
                rebuildVideoController();
                requestAnimationFrame(function () { fitCanvasesToCells(); });
                if (videoController) {
                    await videoController.seekToFrame(state.currentFrame);
                }
            } else {
                // No videos selected — show per-cell prompts
                console.log('[add-slp] Creating ' + cameras.length + ' prompt cells');
                for (var mpci = 0; mpci < cameras.length; mpci++) {
                    var mpCamName = cameras[mpci].name;
                    var mpVideoMeta = slpData.videos[mpci];
                    var mpRefFilename = mpVideoMeta ? (mpVideoMeta.sourceFilename || mpVideoMeta.filename || null) : null;
                    if (mpRefFilename === '.') mpRefFilename = null;
                    createVideoPromptCell(mpCamName, mpRefFilename);
                }
                updateGridLayout();
                requestAnimationFrame(function () { fitCanvasesToCells(); });
            }
        }

        // Dock empty message is hidden by addVideoPanel when user drags videos in

        // Validate currentFrame is still valid
        if (!state.session.frameGroups.has(state.currentFrame)) {
            var firstAvail = 0;
            for (var [fk] of state.session.frameGroups) {
                firstAvail = fk;
                break;
            }
            state.currentFrame = firstAvail;
        }

        // Update 3D viewport
        if (viewport3d) {
            viewport3d.cameras = state.session.cameras;
            viewport3d.skeleton = state.session.skeleton;
            viewport3d.addCameraPyramids();
            viewport3d.setFrame(getInstanceGroupsForFrame(state.currentFrame));
            viewport3d.fitToScene();
        }

        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) timeline.setData(state.session);

        hideLoading();
        var dockPanelCount = paneManager.api ? paneManager.api.panels.length : 0;
        console.log('[add-slp] Done. Dock panels: ' + dockPanelCount + ', Views: ' + state.views.length);
        setStatus('Added SLP: ' + cameras.length + ' camera(s), ' + affectedFrames.length + ' frames merged. Panels: ' + dockPanelCount, 'success');
    } catch (err) {
        console.error('[add-slp] FATAL:', err);
        hideLoading();
        setStatus('Add SLP error: ' + err.message, 'error');
    }
}

// ============================================
// Points3d H5 Import
// ============================================

export async function handleLoadPoints3dH5() {
    try {
        if (!state.session) {
            setStatus('Load an SLP or session first before loading 3D points', 'error');
            return;
        }

        setStatus('Picking 3D points file...', 'warning');
        var files = await pickFiles({ accept: '.h5,.hdf5' });
        if (files.length === 0) {
            setStatus('No file selected', 'warning');
            return;
        }

        showLoading('Reading 3D points file...');
        var arrayBuffer = await files[0].arrayBuffer();

        showLoading('Parsing 3D points...');
        var ptsData = await parsePoints3dH5(arrayBuffer);

        // Verify skeleton compatibility
        var sessionNodes = state.session.skeleton.nodes;
        if (ptsData.nodeNames.length > 0 && ptsData.nodeNames.length !== sessionNodes.length) {
            console.warn('Node count mismatch: H5 has ' + ptsData.nodeNames.length + ' nodes, session has ' + sessionNodes.length);
        }

        // Ensure enough tracks
        while (state.session.tracks.length < ptsData.trackNames.length) {
            state.session.tracks.push(ptsData.trackNames[state.session.tracks.length] || ('track_' + state.session.tracks.length));
        }

        // Populate InstanceGroups with 3D data
        var framesUpdated = 0;
        for (var [frameIdx, trackMap] of ptsData.points3d) {
            // Ensure instanceGroups entry exists for this frame
            if (!state.session.instanceGroups.has(frameIdx)) {
                state.session.instanceGroups.set(frameIdx, []);
            }
            var frameGroupsList = state.session.instanceGroups.get(frameIdx);

            for (var [trackIdx, pts3d] of trackMap) {
                // Find or create InstanceGroup for this track (identity)
                var existingGroup = null;
                for (var egi = 0; egi < frameGroupsList.length; egi++) {
                    if (frameGroupsList[egi].identityId === trackIdx) {
                        existingGroup = frameGroupsList[egi];
                        break;
                    }
                }
                if (existingGroup) {
                    // Assign 3D points to existing group
                    existingGroup.points3d = pts3d;
                    existingGroup.markClean();
                } else {
                    // Create a new InstanceGroup with just 3D data
                    var newGroup = new InstanceGroup(Date.now() + frameIdx * 100 + trackIdx, trackIdx); // identityId = trackIdx
                    newGroup.points3d = pts3d;
                    newGroup.markClean();
                    frameGroupsList.push(newGroup);
                }
            }
            framesUpdated++;
        }

        // Refresh 3D viewport
        if (viewport3d) {
            viewport3d.skeleton = state.session.skeleton;
            viewport3d.setFrame(getInstanceGroupsForFrame(state.currentFrame));
        }

        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) timeline.setData(state.session);

        hideLoading();
        setStatus('3D points loaded: ' + framesUpdated + ' frames, ' + ptsData.trackNames.length + ' tracks', 'success');
    } catch (err) {
        console.error('Failed to load 3D points:', err);
        hideLoading();
        setStatus('3D points error: ' + err.message, 'error');
    }
}
