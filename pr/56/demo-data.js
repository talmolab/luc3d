// demo-data.js - Generates synthetic demo data for the multi-view GUI.
// Depends on pose-data.js being loaded first (Skeleton, Camera, Instance,
// FrameGroup, InstanceGroup, Session classes plus mat helpers).

/**
 * Create 4 calibrated cameras positioned around a central point.
 *
 * The cameras approximate a typical 4-view mouse recording rig:
 *   back  - behind the mouse, slightly elevated
 *   mid   - front-right, slightly elevated
 *   side  - left side, roughly level
 *   top   - directly above, looking straight down
 *
 * The arena center is at the world origin. Cameras are placed ~300-400 mm
 * away, looking toward the origin. Image size is 640x480.
 *
 * @returns {Camera[]}
 */
function createDemoCalibration() {
    const W = 640;
    const H = 480;

    // Shared intrinsic parameters (reasonable for a 640x480 sensor)
    // Focal length ~600 px, principal point at image center.
    function makeK(fx, fy, cx, cy) {
        return [
            [fx, 0, cx],
            [0, fy, cy],
            [0, 0, 1]
        ];
    }

    // Negligible distortion for the demo.
    const dist = [0, 0, 0, 0, 0];

    // Helper: given a camera position (eye) and a target point, compute rvec
    // (Rodrigues) that orients the camera so its -Z axis points at the target.
    //
    // OpenCV camera convention:
    //   X -> right, Y -> down, Z -> into the scene (viewing direction).
    // So the camera looks along its +Z axis.
    function lookAt(eye, target) {
        // Compute rotation + translation that orients the camera at `eye`
        // to look toward `target`.
        //
        // World coordinate system: Z-up.
        // OpenCV camera convention: X-right, Y-down, Z-into-scene.
        //
        // Strategy:
        //   Z_cam = normalize(target - eye)           (viewing direction)
        //   X_cam = normalize(worldUp x Z_cam)        (right)
        //   Y_cam = Z_cam x X_cam                     (down, completing RH frame)
        //
        // The rotation matrix R (world-to-camera) has these as rows:
        //   R = [X_cam^T; Y_cam^T; Z_cam^T]
        // Translation: t = -R * eye

        // Forward direction (camera +Z)
        let fwd = [
            target[0] - eye[0],
            target[1] - eye[1],
            target[2] - eye[2]
        ];
        const fwdLen = Math.sqrt(fwd[0] ** 2 + fwd[1] ** 2 + fwd[2] ** 2);
        fwd = [fwd[0] / fwdLen, fwd[1] / fwdLen, fwd[2] / fwdLen];

        const z = fwd; // unit viewing direction

        // World up direction (Z-up convention)
        // When the camera looks nearly straight down/up, the cross product
        // with [0,0,1] degenerates, so fall back to world -Y as up hint.
        let up = [0, 0, 1];
        if (Math.abs(fwd[2]) > 0.95) {
            up = [0, -1, 0];
        }

        // camera X = normalize(up x Z)   -- this makes X point right when up is world-up
        let x = cross(up, z);
        const xLen = Math.sqrt(x[0] ** 2 + x[1] ** 2 + x[2] ** 2);
        x = [x[0] / xLen, x[1] / xLen, x[2] / xLen];

        // camera Y = Z x X  -- completes right-handed frame, points "down"
        let y = cross(z, x);
        // y should already be unit since z and x are orthonormal, but normalize anyway
        const yLen = Math.sqrt(y[0] ** 2 + y[1] ** 2 + y[2] ** 2);
        y = [y[0] / yLen, y[1] / yLen, y[2] / yLen];

        // Rotation matrix R: columns are camera axes expressed in world coordinates.
        // R takes a point from world coords to camera coords:
        //   p_cam = R * p_world + t
        // The ROWS of R are the camera axes (since R^T has them as columns):
        //   R = [ x^T ]
        //       [ y^T ]
        //       [ z^T ]
        const R = [
            [x[0], x[1], x[2]],
            [y[0], y[1], y[2]],
            [z[0], z[1], z[2]]
        ];

        // Translation: t = -R * eye
        const t = [
            -(R[0][0] * eye[0] + R[0][1] * eye[1] + R[0][2] * eye[2]),
            -(R[1][0] * eye[0] + R[1][1] * eye[1] + R[1][2] * eye[2]),
            -(R[2][0] * eye[0] + R[2][1] * eye[1] + R[2][2] * eye[2])
        ];

        // Convert R to Rodrigues rvec
        const rvec = rotationMatrixToRodrigues(R);

        return { rvec, tvec: t };
    }

    // ---- Camera definitions ----
    const target = [0, 0, 0]; // arena center

    // back: behind the mouse (negative Y), slightly above
    const backEye = [0, -350, 150];
    const backCam = lookAt(backEye, target);

    // mid: front-right, slightly above
    const midEye = [250, 250, 120];
    const midCam = lookAt(midEye, target);

    // side: left side, roughly level
    const sideEye = [-350, 30, 80];
    const sideCam = lookAt(sideEye, target);

    // top: directly above, looking straight down
    const topEye = [0, 0, 400];
    const topCam = lookAt(topEye, target);

    return [
        new Camera('back', makeK(600, 600, 320, 240), dist, backCam.rvec, backCam.tvec, [W, H]),
        new Camera('mid', makeK(620, 620, 320, 240), dist, midCam.rvec, midCam.tvec, [W, H]),
        new Camera('side', makeK(580, 580, 320, 240), dist, sideCam.rvec, sideCam.tvec, [W, H]),
        new Camera('top', makeK(550, 550, 320, 240), dist, topCam.rvec, topCam.tvec, [W, H])
    ];
}


/**
 * Create the default 6-node mouse skeleton.
 * @returns {Skeleton}
 */
function createDemoSkeleton() {
    return Skeleton.defaultMouse();
}


/**
 * Generate 3D keypoints for a simple moving mouse skeleton over numFrames.
 *
 * The mouse body center traces a gentle circle (radius ~30 mm) in the XY
 * plane near the origin. The head points in the direction of motion and the
 * tail extends behind. A subtle sinusoidal undulation is added.
 *
 * Node order matches Skeleton.defaultMouse():
 *   0: nose, 1: head, 2: neck, 3: body (center), 4: tail_base, 5: tail_tip
 *
 * @param {number} numFrames
 * @returns {number[][][]} numFrames x 6 x 3
 */
function generateDemoKeypoints3D(numFrames) {
    const frames = [];

    // Segment lengths (mm) along the spine
    const noseToHead = 8;
    const headToNeck = 10;
    const neckToBody = 15;
    const bodyToTailBase = 18;
    const tailBaseToTip = 25;

    for (let f = 0; f < numFrames; f++) {
        const t = f / numFrames; // 0..1 over the sequence

        // Body center traces a circle
        const angle = t * 2 * Math.PI; // one full revolution
        const radius = 30; // mm
        const cx = radius * Math.cos(angle);
        const cy = radius * Math.sin(angle);
        const cz = 0; // ground plane

        // Heading direction (tangent to the circle = direction of travel)
        const hdx = -Math.sin(angle);
        const hdy = Math.cos(angle);

        // Undulation: slight lateral offset that varies along the body
        const undulAmp = 3; // mm
        const undulFreq = 3; // cycles over the full animation
        const undulPhase = t * undulFreq * 2 * Math.PI;

        // Perpendicular to heading (for lateral undulation)
        const perpx = -hdy;
        const perpy = hdx;

        // Build each node along the spine. We'll place them relative to the
        // body center, going forward (nose direction) and backward (tail).
        // Forward = heading direction, backward = -heading.

        // Body center (node 3)
        const body = [cx, cy, cz];

        // Neck (node 2): forward from body
        const neckUndul = undulAmp * Math.sin(undulPhase + 0.5);
        const neck = [
            cx + neckToBody * hdx + neckUndul * perpx,
            cy + neckToBody * hdy + neckUndul * perpy,
            cz + 1 // neck slightly raised
        ];

        // Head (node 1): forward from neck
        const headUndul = undulAmp * Math.sin(undulPhase + 1.0);
        const head = [
            neck[0] + headToNeck * hdx + headUndul * perpx,
            neck[1] + headToNeck * hdy + headUndul * perpy,
            cz + 2 // head a bit higher
        ];

        // Nose (node 0): forward from head
        const noseUndul = undulAmp * 0.5 * Math.sin(undulPhase + 1.5);
        const nose = [
            head[0] + noseToHead * hdx + noseUndul * perpx,
            head[1] + noseToHead * hdy + noseUndul * perpy,
            cz + 2
        ];

        // Tail base (node 4): backward from body
        const tbUndul = undulAmp * Math.sin(undulPhase - 0.5);
        const tailBase = [
            cx - bodyToTailBase * hdx + tbUndul * perpx,
            cy - bodyToTailBase * hdy + tbUndul * perpy,
            cz
        ];

        // Tail tip (node 5): further backward from tail base
        const ttUndul = undulAmp * 1.5 * Math.sin(undulPhase - 1.2);
        const tailTip = [
            tailBase[0] - tailBaseToTip * hdx + ttUndul * perpx,
            tailBase[1] - tailBaseToTip * hdy + ttUndul * perpy,
            cz - 1 // tail tip droops slightly
        ];

        frames.push([nose, head, neck, body, tailBase, tailTip]);
    }

    return frames;
}


/**
 * Create a complete demo Session with synthetic data.
 *
 * Pipeline:
 *   1. Create 4 calibrated cameras.
 *   2. Create a 6-node mouse skeleton.
 *   3. Generate 3D keypoints for numFrames.
 *   4. For each frame, project through 3 cameras (back, mid, side - NOT top),
 *      add Gaussian noise, and store as UnlinkedInstances.
 *      Users must assign them across views and triangulate to fill the 4th view.
 *
 * @param {number} [numFrames=100]
 * @returns {{ session: Session, keypoints3d: number[][][] }}
 */
function createDemoSession(numFrames) {
    if (numFrames === undefined) numFrames = 100;

    const cameras = createDemoCalibration();
    const skeleton = createDemoSkeleton();
    const tracks = ['mouse_0'];
    const keypoints3d = generateDemoKeypoints3D(numFrames);

    const session = new Session(cameras, skeleton, tracks);

    // Only generate predictions for 3 of 4 cameras (not top)
    const predictionCameras = cameras.filter(function (c) { return c.name !== 'top'; });

    for (let f = 0; f < numFrames; f++) {
        const pts3d = keypoints3d[f]; // 6 x [x,y,z]
        const frameGroup = new FrameGroup(f);

        for (let ci = 0; ci < predictionCameras.length; ci++) {
            const cam = predictionCameras[ci];

            // Project 3D points through this camera
            const projected = cam.projectPoints(pts3d);

            // Add Gaussian noise (sigma ~ 1.5 px) to simulate detection error
            const noisyPoints = projected.map(function (p) {
                return [
                    p[0] + gaussianRandom() * 1.5,
                    p[1] + gaussianRandom() * 1.5
                ];
            });

            const instance = new Instance(
                noisyPoints,
                0,          // trackIdx
                'predicted',
                0.9 + Math.random() * 0.1 // score between 0.9 and 1.0
            );

            // Store as unlinked instance (not pre-grouped)
            const unlinked = new UnlinkedInstance(instance, cam.name);
            frameGroup.addUnlinkedInstance(cam.name, unlinked);
        }

        session.addFrameGroup(frameGroup);
    }

    return { session, keypoints3d };
}


// --------------------------------------------------------------------------
// Utility helpers (file-level, used by createDemoCalibration and others)
// --------------------------------------------------------------------------

/**
 * Cross product of two 3-vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number[]}
 */
function cross(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0]
    ];
}

/**
 * Convert a 3x3 rotation matrix to a Rodrigues rotation vector.
 *
 * Uses the inverse Rodrigues formula:
 *   theta = arccos((trace(R) - 1) / 2)
 *   if theta ~ 0: return [0, 0, 0]
 *   if theta ~ pi: special case using symmetric part
 *   else: axis = (1 / (2 * sin(theta))) * [R32-R23, R13-R31, R21-R12],  rvec = theta * axis
 *
 * @param {number[][]} R - 3x3 rotation matrix
 * @returns {number[]} 3-element rotation vector
 */
function rotationMatrixToRodrigues(R) {
    const trace = R[0][0] + R[1][1] + R[2][2];
    const cosTheta = (trace - 1) / 2;
    // Clamp to [-1, 1] to avoid numerical issues with acos
    const cosClamped = Math.max(-1, Math.min(1, cosTheta));
    const theta = Math.acos(cosClamped);

    if (theta < 1e-10) {
        return [0, 0, 0];
    }

    if (Math.PI - theta < 1e-10) {
        // theta ~ pi: extract axis from the symmetric part of R
        // R = I + 2 * k * k^T - 2 * I  (when theta = pi, cos(theta)=-1, sin(theta)=0)
        // Actually R = -I + 2 * k * k^T, so k*k^T = (R + I) / 2
        // Pick the column of (R+I) with the largest norm.
        const S = [
            [(R[0][0] + 1) / 2, (R[0][1] + R[1][0]) / 4, (R[0][2] + R[2][0]) / 4],
            [(R[0][1] + R[1][0]) / 4, (R[1][1] + 1) / 2, (R[1][2] + R[2][1]) / 4],
            [(R[0][2] + R[2][0]) / 4, (R[1][2] + R[2][1]) / 4, (R[2][2] + 1) / 2]
        ];
        // Find the diagonal element with largest value
        let maxIdx = 0;
        if (S[1][1] > S[maxIdx][maxIdx]) maxIdx = 1;
        if (S[2][2] > S[maxIdx][maxIdx]) maxIdx = 2;
        const k = [S[0][maxIdx], S[1][maxIdx], S[2][maxIdx]];
        const kLen = Math.sqrt(k[0] ** 2 + k[1] ** 2 + k[2] ** 2);
        if (kLen < 1e-12) return [0, 0, 0]; // degenerate
        return [
            (k[0] / kLen) * theta,
            (k[1] / kLen) * theta,
            (k[2] / kLen) * theta
        ];
    }

    // General case
    const s = 1 / (2 * Math.sin(theta));
    const axis = [
        s * (R[2][1] - R[1][2]),
        s * (R[0][2] - R[2][0]),
        s * (R[1][0] - R[0][1])
    ];

    return [axis[0] * theta, axis[1] * theta, axis[2] * theta];
}

/**
 * Generate a random number from a standard normal distribution (mean=0, std=1)
 * using the Box-Muller transform.
 * @returns {number}
 */
function gaussianRandom() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
