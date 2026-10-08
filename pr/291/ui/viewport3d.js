/**
 * viewport3d.js - Three.js-based 3D viewport for the multi-view pose proofreading GUI
 *
 * Renders a 3D scene showing triangulated skeleton keypoints, camera frustum
 * wireframes, skeleton edges, and camera position labels. Uses the THREE global
 * loaded from CDN.
 *
 * Dependencies (loaded via <script> tags before this file):
 *   - three@0.147.0/build/three.min.js          -> THREE global
 *   - three@0.147.0/examples/js/controls/OrbitControls.js -> THREE.OrbitControls
 *
 * ES module. Exports `Viewport3D`. Caller supplies `cameras`, `skeleton`, and
 * a `getTrackColor` callback via the options bag — no app-state imports are
 * needed. The one project import is the `points3d` codec from `pose-data.js`
 * (a leaf module, no cycle): `InstanceGroup.points3d` is a flat
 * `Float64Array(3N)` with all-NaN triples for missing nodes, so reading it
 * requires the shared accessors rather than array indexing.
 */

import { points3dNodeCount, getPoint3d } from '../pose/pose-data.js?v=ac82994645eb';

// ============================================
// Deferred work (hidden viewport)
// ============================================

/**
 * Order in which work deferred by `setVisible(false)` is replayed on re-show.
 *
 * Every content-mutating method on this class is a stateless FULL rebuild from
 * the instance's current fields, so replaying the latest call of each is
 * equivalent to having run them all — but the order matters, because some read
 * back what others build: `highlightCamera` recolours the meshes
 * `addCameraPyramids` creates, and `fitToScene` measures the skeleton
 * `setFrame` creates. Geometry first, then whatever inspects it.
 *
 * Keys not listed here still run (after these, in insertion order), so adding
 * a new deferred key can't silently drop it — only leave it unordered.
 */
const DEFER_REPLAY_ORDER = ['cameras', 'environment', 'frame', 'highlight', 'fit'];

/**
 * The colour a SELECTED 3D Mesh Object's member planes are lit up in.
 *
 * One fixed yellow, deliberately NOT the object's own colour. The highlight
 * has to be legible against whatever colours the user gave their planes, and
 * an object drawn in a colour of its own would be competing with five plane
 * colours at once — so it gets a colour no plane palette entry uses, at an
 * opacity above the plane fills' own 0.28. Only one object can be selected at
 * a time, so a shared highlight colour is never ambiguous.
 *
 * The object's colour is still its identity everywhere it is not competing for
 * attention: the table swatch, the editor and the `.glb` `baseColorFactor`.
 */
const MESH_MEMBER_COLOR = '#ffe600';

/**
 * The colour the SELECTED plane node is ringed in.
 *
 * White, and deliberately not any plane-node palette entry: a node wears its
 * own colour in 2D, in 3D and in the panel's swatch, so a selection drawn in
 * that colour would be invisible on the one node it is about. Fixed rather
 * than derived for the same reason `MESH_MEMBER_COLOR` is — only one node is
 * selected at a time, so one colour is never ambiguous.
 */
const NODE_SELECT_COLOR = '#ffffff';

// ============================================
// Viewport3D class
// ============================================

/**
 * 3D viewport that renders triangulated skeletons and camera frustums.
 *
 * Usage:
 *   const vp = new Viewport3D(containerEl, {
 *       cameras: [Camera, ...],
 *       skeleton: Skeleton,
 *       getTrackColor: getTrackColor,
 *   });
 *   vp.setFrame(instanceGroups);
 *   // ...later:
 *   vp.dispose();
 */
export class Viewport3D {
    /**
     * @param {HTMLElement} container - DOM element to mount the 3D canvas into
     * @param {Object} options
     * @param {Camera[]} options.cameras - Array of Camera objects (from pose-data.js)
     * @param {Skeleton} options.skeleton - Skeleton object with .nodes and .edges
     * @param {function(number): string} options.getTrackColor - Track color function
     */
    constructor(container, options) {
        options = options || {};

        /** @type {HTMLElement} */
        this.container = container;

        /** @type {Camera[]} */
        this.cameras = options.cameras || [];

        /** @type {Skeleton} */
        this.skeleton = options.skeleton || { nodes: [], edges: [] };

        /** @type {function(number): string} */
        this.getTrackColor = options.getTrackColor || function () { return '#667eea'; };

        /** @type {function(InstanceGroup): string|null} Optional: color a group using the same logic as 2D overlays */
        this.getGroupColorFn = options.getGroupColor || null;

        /** @type {function(string): void|null} Callback when a camera is clicked */
        this.onCameraClicked = options.onCameraClicked || null;

        /** @type {function(boolean): void|null} Callback when camera view mode changes */
        this.onCameraViewChanged = null;

        /**
         * @type {function(number, number, number[]): void|null}
         * Called on every pointer move while a plane corner is being dragged in
         * 3D: `(planeId, nodeIdx, [x, y, z])`. The new position is ALWAYS on
         * that plane's fitted plane — see `_onPlanePointerDown`. The owner is
         * expected to write the model and call `setPlanes` again; this class
         * does not mutate `points3d` itself.
         */
        this.onPlaneNodeDragged = options.onPlaneNodeDragged || null;

        /**
         * @type {function(number, number): void|null}
         * Called once when a 3D plane-corner drag ends and actually moved
         * something: `(planeId, nodeIdx)`. For work too expensive to do per
         * move (panel rebuilds, error recomputation).
         */
        this.onPlaneNodeDragEnd = options.onPlaneNodeDragEnd || null;

        /** @type {number|null} Index of the currently selected/highlighted instance */
        this.selectedInstanceIdx = null;

        /** @type {THREE.Raycaster} For picking camera objects */
        this._raycaster = null;

        /** @type {string|null} Currently selected camera name */
        this.selectedCamera = null;

        /** @type {string|null} Camera whose perspective we are viewing (for declutter) */
        this._viewingCamera = null;

        /** @type {Object|null} Camera data for dynamic FOV recomputation during resize */
        this._viewingCamData = null;

        /** @type {number|null} Animation frame timer for perspective animation */
        this._perspectiveAnimId = null;

        /** @type {boolean} True while perspective animation is running — suppresses controls.update() */
        this._animatingPerspective = false;

        // Three.js objects
        /** @type {THREE.Scene} */
        this.scene = null;
        /** @type {THREE.WebGLRenderer} */
        this.renderer = null;
        /** @type {THREE.PerspectiveCamera} */
        this.threeCamera = null;
        /** @type {THREE.OrbitControls} */
        this.controls = null;

        // Scene groups for easy clearing/updating
        /** @type {THREE.Group} Group holding camera pyramid wireframes and labels */
        this._cameraGroup = null;
        /** @type {THREE.Group} Group holding skeleton meshes for the current frame */
        this._skeletonGroup = null;
        /**
         * @type {THREE.Group} Group holding user-annotated PLANES
         * (View ▸ Define Planes). A sibling of `_skeletonGroup`, NOT a child —
         * `updateSkeleton` clears `_skeletonGroup` on every frame, and planes
         * are frame-independent scene geometry that must survive that.
         */
        this._planeGroup = null;
        /** @type {THREE.Group|null} MEMBERSHIP highlighting for the selected 3D
         * Mesh Object: the member planes' own outlines, redrawn in the object's
         * colour. A sibling of `_planeGroup`, never a part of it, so the plane
         * drawing stays byte-for-byte what it was.
         *
         * This deliberately does NOT draw the derived surface as a separate
         * body. An object IS its member planes — the same cage already on
         * screen — so a second surface beside them is at best a duplicate and
         * at worst a lie: the derived geometry is built in the user's ORIGIN
         * frame (the panel quotes volumes in it, and the exporters write it),
         * while this group, like every data group, hangs off `scene` rather
         * than `_framePivot` and so is drawn in CALIBRATION world. Putting
         * framed vertices in an unframed group drew the object displaced and
         * rotated away from the cage it was built from. Highlighting the real
         * planes cannot drift, because it re-reads the very points the plane
         * drawing used. */
        this._meshMembershipGroup = null;
        /** @type {THREE.Group|null} A ring marker around the ONE plane node selected in
         * the Define Planes panel's Nodes table. A sibling of `_planeGroup` for
         * the same reason `_meshMembershipGroup` is one: it is an additive view
         * of a corner already drawn, and keeping it out of `_planeGroup` leaves
         * the plane drawing exactly what it was. Pure display — nothing here
         * writes a node. */
        this._nodeSelectGroup = null;
        /** @type {THREE.Group|null} A GHOST of where "Set Angle Between Two
         * Planes" would put the plane being rotated, shown while its dialog is
         * open. A sibling of `_planeGroup` for the same reason
         * `_meshMembershipGroup` is one: it is a second, additive view of the same
         * nodes, and keeping it out of `_planeGroup` is what lets the real
         * plane drawing stay exactly what it was. Empty unless the dialog is
         * open, and it is pure display — nothing here writes a node. */
        this._angleGroup = null;

        /** @type {THREE.Group|null} Role outlines for the Set Angle dialog: which
         * plane is being held and which one is about to move. A THIRD group, not
         * the ghost's, because the two answer different questions and are cleared
         * at different times — a refused plan drops the ghost while the roles are
         * still what the user is choosing between. Pure display. */
        this._planeRoleGroup = null;

        /** @type {Array<Object>} The last `setPlanes` payload, kept so a drag can
         * look up the plane's fit (its drag constraint) by id. */
        this._planes = [];
        /** @type {number} Corner-sphere size for annotated PLANES only, driven by
         * the panel's "3D Node Size" slider. Deliberately not `skeletonNodeSize`:
         * sizing plane corners must not resize pose nodes. */
        this.planeNodeSize = options.planeNodeSize !== undefined ? options.planeNodeSize : 4;
        /**
         * @type {boolean} Draw each plane's BODY — its fill and its edges. The
         * Visibility panel's "Planes in 3D Views" toggle, pushed in by
         * `syncPlanes3D`; forced on inside Defining Plane Mode.
         */
        this.showPlaneSurfaces = options.showPlaneSurfaces !== undefined
            ? options.showPlaneSurfaces : true;
        /**
         * @type {boolean} Draw each plane's CORNERS. The Visibility panel's
         * "Nodes in 3D Views" toggle, independent of `showPlaneSurfaces` — a
         * node outlives the planes referencing it, so the two are not one
         * switch. With the corners off nothing is pickable, which is correct:
         * the payload is only `editable` inside the mode, where both are forced
         * on.
         */
        this.showPlaneNodes = options.showPlaneNodes !== undefined
            ? options.showPlaneNodes : true;
        /** @type {{planeId:number, nodeIdx:number, moved:boolean, pointerId:number}|null}
         * Non-null only while a plane corner is being dragged in 3D. */
        this._planeDrag = null;
        /** @type {boolean} Set when a plane drag ends, so the camera-picking
         * `click` that follows the same pointer-up is not read as a camera click. */
        this._suppressCameraClick = false;

        // --- Set Origin Mode ---
        /** @type {'node'|'axis'|null} What a click is currently picking, if anything. */
        this._originPickMode = null;
        /** @type {THREE.Group} Candidate +Z arrows + the picked-corner marker. */
        this._originGroup = null;
        /** @type {THREE.Group} Parent of the grid floor + axis helper, moved by
         * `setOriginFrame` so the DISPLAYED frame can be re-based without
         * touching a single data point. */
        this._framePivot = null;
        /** @type {THREE.GridHelper|null} */
        this._gridFloor = null;
        /** @type {Object|null} The frame currently displayed, or null for the
         * calibration's own. Also what the camera pivots on and spins about —
         * see `originPivot` / `originUp` / `_rebaseControls`. */
        this._originFrame = null;
        /** @type {function(number, number, number[]): void|null} */
        this.onOriginNodePicked = options.onOriginNodePicked || null;
        /** @type {function(string): void|null} `'positive'` or `'negative'`. */
        this.onOriginAxisPicked = options.onOriginAxisPicked || null;

        /** Reused skeleton meshes/materials — see `updateSkeleton`. */
        this._skelPool = null;

        /** @type {number} Animation frame request ID */
        this._rafId = 0;
        /** @type {boolean} Whether the viewport has been disposed */
        this._disposed = false;

        /** @type {number} Scene scale factor based on camera baseline */
        this._sceneScale = 1;

        /** @type {number} Camera label font size (default 28) */
        this.cameraLabelSize = options.cameraLabelSize || 28;

        /** @type {number} Camera sphere radius multiplier (default 3) */
        this.cameraSphereSize = options.cameraSphereSize || 3;

        /** @type {number} Pyramid depth multiplier (default 40) */
        this.pyramidLength = options.pyramidLength || 40;

        /** @type {number} 3D skeleton node radius multiplier (default 2) */
        this.skeletonNodeSize = options.skeletonNodeSize !== undefined ? options.skeletonNodeSize : 2;

        /** @type {number} 3D skeleton edge radius multiplier (default 0.8) */
        this.skeletonEdgeWeight = options.skeletonEdgeWeight !== undefined ? options.skeletonEdgeWeight : 0.8;

        /** @type {number} 3D skeleton color brightness, 0..1 (default 0.5).
         *  Scales the track/identity color's RGB like the 2D reprojection
         *  Brightness; the selected instance keeps its full color. */
        this.skeletonBrightness = options.skeletonBrightness !== undefined ? options.skeletonBrightness : 0.5;

        /** @type {string} 3D skeleton node marker shape:
         *  'circle' (sphere), 'square' (cube), 'triangle' (tetrahedron),
         *  'x' (crossed bars). */
        this.skeletonNodeShape = options.skeletonNodeShape || 'circle';

        /** @type {boolean} Keep the WebGL drawing buffer after compositing so
         *  the canvas can be captured frame-by-frame (used by 3D video export). */
        this._preserveDrawingBuffer = !!options.preserveDrawingBuffer;

        /** @type {boolean} Whether to show camera labels */
        this.showCameraLabels = options.showCameraLabels !== undefined ? options.showCameraLabels : true;

        /** @type {boolean} Whether to show camera spheres */
        this.showCameraSpheres = options.showCameraSpheres !== undefined ? options.showCameraSpheres : true;

        /** @type {boolean} Whether to show camera pyramids */
        this.showCameraPyramids = options.showCameraPyramids !== undefined ? options.showCameraPyramids : true;

        /** @type {boolean} Whether to show skeleton nodes */
        this.showSkeletonNodes = options.showSkeletonNodes !== undefined ? options.showSkeletonNodes : true;

        /** @type {boolean} Whether to show skeleton edges */
        this.showSkeletonEdges = options.showSkeletonEdges !== undefined ? options.showSkeletonEdges : true;

        // Resize observer for container dimension changes
        /** @type {ResizeObserver|null} */
        this._resizeObserver = null;

        /** @type {boolean} Whether this viewport is on screen. When false the
         *  render loop is stopped and every scene rebuild is deferred (see
         *  `setVisible`). Per-instance rather than read from the DOM because
         *  the export modals build their own Viewport3D instances that must
         *  keep rendering regardless of the main panel's collapse state. */
        this._visible = options.visible !== undefined ? !!options.visible : true;

        /** @type {Map<string, function():void>} Latest deferred rebuild per
         *  key, replayed by `setVisible(true)`. Keyed (not queued) so scrubbing
         *  10,000 frames with the viewport hidden leaves ONE pending 'frame'
         *  thunk, not 10,000. */
        this._deferred = new Map();

        this._init();
    }

    // ============================================
    // Initialization
    // ============================================

    /**
     * Initialize Three.js scene, renderer, camera, lights, grid, and controls.
     * @private
     */
    /**
     * Build the OrbitControls, orbiting about the camera's CURRENT `up`.
     *
     * Split out of `_init` because the orbit axis is baked in at construction:
     * r147's `update` captures a quaternion from `camera.up` once, when the
     * closure is defined, so a later `camera.up = …` re-aims the camera without
     * re-aiming the orbit. Re-basing the frame therefore has to rebuild the
     * controls (`_rebaseControls`), and the two paths must not drift apart in
     * their tuning — hence one function owning it.
     * @private
     */
    _createControls() {
        const controls = new THREE.OrbitControls(this.threeCamera, this.renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.1;
        controls.screenSpacePanning = true;
        controls.minDistance = 10;
        controls.maxDistance = 100000;
        // Declutter: check distance to the viewed camera on orbit changes. Lives
        // here, not in `_setupCameraPicking`, so a rebuild keeps it.
        controls.addEventListener('change', () => { this._checkDeclutter(); });
        // What the orbit axis actually is, as opposed to what `camera.up` says
        // — `_rebaseControls` compares against this to know when a rebuild is
        // the only way to move the axis.
        this._controlsUp = this.threeCamera.up.clone().normalize();
        return controls;
    }

    _init() {
        const width = this.container.clientWidth || 400;
        const height = this.container.clientHeight || 300;

        // --- Scene ---
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1a1a1a);

        // --- Renderer ---
        this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: this._preserveDrawingBuffer });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(width, height);
        this.container.appendChild(this.renderer.domElement);

        // --- Camera ---
        this.threeCamera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100000);
        // Position to see the full scene: cameras are ~300-400mm from origin
        this.threeCamera.position.set(500, -500, 400);
        this.threeCamera.up.set(0, 0, 1); // Z-up world convention

        // --- Orbit Controls ---
        this.controls = this._createControls();
        this.controls.target.set(0, 0, 0);
        this.controls.update();

        // --- Lights ---
        const ambient = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambient);

        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(200, -200, 400);
        this.scene.add(dirLight);

        // Secondary fill light from the opposite side
        const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
        fillLight.position.set(-200, 200, 100);
        this.scene.add(fillLight);

        // --- Origin frame: grid floor + axis helper ---
        // Both live under one pivot so "Set Origin" can move the WHOLE frame
        // with a single matrix, without touching any data group. Re-basing the
        // display must never re-bake the data: 3D points stay in calibration
        // world coordinates, and the transform is reported instead.
        this._framePivot = new THREE.Group();
        this._framePivot.name = 'originFrame';
        this.scene.add(this._framePivot);

        // --- Grid floor (XY plane at Z=0, matching Z-up convention) ---
        this._addGridFloor();

        // --- Axis helper (will be rescaled in fitToScene) ---
        this._axisHelper = new THREE.AxesHelper(50);
        this._framePivot.add(this._axisHelper);

        // --- Origin-picking overlay (Set Origin Mode arrows) ---
        this._originGroup = new THREE.Group();
        this._originGroup.name = 'originPicker';
        this.scene.add(this._originGroup);

        // --- Scene groups ---
        this._cameraGroup = new THREE.Group();
        this._cameraGroup.name = 'cameras';
        this.scene.add(this._cameraGroup);

        this._skeletonGroup = new THREE.Group();
        this._skeletonGroup.name = 'skeletons';
        this.scene.add(this._skeletonGroup);

        this._envGroup = new THREE.Group();
        this._envGroup.name = 'environment';
        this.scene.add(this._envGroup);

        this._planeGroup = new THREE.Group();
        this._planeGroup.name = 'planes';
        this.scene.add(this._planeGroup);

        this._meshMembershipGroup = new THREE.Group();
        this._meshMembershipGroup.name = 'meshMembership';
        this.scene.add(this._meshMembershipGroup);

        this._nodeSelectGroup = new THREE.Group();
        this._nodeSelectGroup.name = 'nodeSelection';
        this.scene.add(this._nodeSelectGroup);

        this._angleGroup = new THREE.Group();
        this._angleGroup.name = 'anglePreview';
        this.scene.add(this._angleGroup);

        this._planeRoleGroup = new THREE.Group();
        this._planeRoleGroup.name = 'planeRoles';
        this.scene.add(this._planeRoleGroup);

        // --- Draw camera pyramids ---
        this.addCameraPyramids();

        // --- Camera picking (click to match perspective) ---
        this._setupCameraPicking();

        // --- Plane-corner dragging (View ▸ Define Planes) ---
        this._setupPlaneEditing();

        // --- Resize handling ---
        this._resizeObserver = new ResizeObserver(() => {
            this.resize();
        });
        this._resizeObserver.observe(this.container);

        // --- Start render loop ---
        // Skipped when constructed hidden; `setVisible(true)` starts it.
        if (this._visible) this._animate();
    }

    // ============================================
    // Visibility (collapse / expand)
    // ============================================

    /**
     * Run `fn` now if this viewport is on screen; otherwise remember it under
     * `key` and run it when the viewport is shown again.
     *
     * @param {string} key - Bucket name; see `DEFER_REPLAY_ORDER`.
     * @param {function():void} fn
     * @returns {boolean} true if `fn` ran, false if it was deferred.
     * @private
     */
    _whenVisible(key, fn) {
        if (this._visible) { fn(); return true; }
        this._deferred.set(key, fn);
        return false;
    }

    /** Whether this viewport is currently on screen. */
    isVisible() {
        return this._visible;
    }

    /**
     * Show or hide this viewport's processing.
     *
     * Hiding does NOT dispose anything — the scene graph, the WebGL context
     * and the user's orbit pose all survive, so re-showing is instant. What it
     * does is stop feeding the GPU (the render loop ran unconditionally at
     * ~60fps into a zero-width canvas, since WebGL neither knows nor cares
     * that CSS collapsed its container) and defer every scene rebuild, so
     * scrubbing / triangulating / loading with the panel collapsed allocates
     * no Three.js geometry at all.
     *
     * Re-showing replays the latest deferred rebuild of each kind and resizes
     * (the container was 0x0 while collapsed, so every `resize()` attempted in
     * that window was a silent no-op).
     *
     * @param {boolean} visible
     */
    setVisible(visible) {
        visible = !!visible;
        if (visible === this._visible) return;
        this._visible = visible;

        if (!visible) {
            if (this._rafId) {
                cancelAnimationFrame(this._rafId);
                this._rafId = 0;
            }
            // The camera-perspective fly-in owns a second, independent rAF
            // loop that renders directly — stopping only `_rafId` would leave
            // it drawing to the hidden canvas for the rest of its 500ms.
            if (this._perspectiveAnimId) {
                cancelAnimationFrame(this._perspectiveAnimId);
                this._perspectiveAnimId = null;
                this._animatingPerspective = false;
            }
            return;
        }

        if (this._disposed) return;

        const pending = this._deferred;
        this._deferred = new Map();
        const run = (key, fn) => {
            try { fn(); }
            catch (e) { console.warn('[3D] deferred "' + key + '" failed on re-show:', e); }
        };
        for (let i = 0; i < DEFER_REPLAY_ORDER.length; i++) {
            const key = DEFER_REPLAY_ORDER[i];
            const fn = pending.get(key);
            if (fn) { pending.delete(key); run(key, fn); }
        }
        for (const [key, fn] of pending) run(key, fn);

        // Guarded like the replays above: a throw here must not leave the
        // render loop stopped, which would look exactly like the panel failing
        // to come back.
        try { this.resize(); }
        catch (e) { console.warn('[3D] resize on re-show failed:', e); }

        if (!this._rafId) this._animate();
    }

    /**
     * Add a grid on the XY plane at Z=0 (Z-up world convention).
     *
     * Three.js GridHelper creates a grid on the XZ plane by default, so we
     * rotate it 90 degrees around the X axis to align it with our XY plane.
     *
     * @private
     */
    _addGridFloor() {
        const gridSize = 600;   // total extent in mm
        const gridDivisions = 30;
        const grid = new THREE.GridHelper(gridSize, gridDivisions, 0x444444, 0x2a2a2a);

        // GridHelper creates grid on XZ plane; rotate -90deg around X to put it on XY
        grid.rotation.x = -Math.PI / 2;

        this._gridFloor = grid;
        this._framePivot.add(grid);
    }

    // ============================================
    // Camera Visualization
    // ============================================

    /**
     * Draw wireframe pyramids representing each camera's position and orientation.
     *
     * For each Camera object:
     *   - Compute world position from extrinsics: camPos = -R^T * t
     *   - Compute viewing direction: R^T * [0,0,1]^T
     *   - Draw a wireframe pyramid from the camera center toward the image plane
     *   - Add a text label sprite with the camera name
     */
    addCameraPyramids() {
        // Hidden: defer. Rebuilds from `this.cameras` + the display props, all
        // of which the caller has already assigned, so the replay on re-show
        // produces exactly what this call would have.
        if (!this._visible) {
            this._deferred.set('cameras', () => this.addCameraPyramids());
            return;
        }

        // Clear any existing camera visualizations
        this._clearGroup(this._cameraGroup);

        // Compute scene scale from camera positions to size pyramids appropriately
        var sceneScale = 1;
        if (this.cameras.length >= 2) {
            var positions = [];
            for (var ci = 0; ci < this.cameras.length; ci++) {
                var cam = this.cameras[ci];
                positions.push(this._computeCameraPosition(cam.rotationMatrix, cam.tvec));
            }
            var maxCamDist = 0;
            for (var ai = 0; ai < positions.length; ai++) {
                for (var bi = ai + 1; bi < positions.length; bi++) {
                    var dx = positions[ai][0] - positions[bi][0];
                    var dy = positions[ai][1] - positions[bi][1];
                    var dz = positions[ai][2] - positions[bi][2];
                    var d = Math.sqrt(dx*dx + dy*dy + dz*dz);
                    if (d > maxCamDist) maxCamDist = d;
                }
            }
            sceneScale = Math.max(1, maxCamDist / 500); // normalize so 500mm baseline = 1x
        }

        this._sceneScale = sceneScale;

        const pyramidDepth = this.pyramidLength * sceneScale;

        for (let i = 0; i < this.cameras.length; i++) {
            const cam = this.cameras[i];
            const R = cam.rotationMatrix;    // 3x3, world-to-camera
            const t = cam.tvec;              // 3x1

            // --- Camera world position: camPos = -R^T * t ---
            const camPos = this._computeCameraPosition(R, t);

            // --- Camera orientation axes in world frame ---
            // Camera X axis in world = R^T * [1,0,0]
            const camRight = this._matTransposeVec(R, [1, 0, 0]);
            // Camera Y axis in world = R^T * [0,1,0]
            const camDown = this._matTransposeVec(R, [0, 1, 0]);
            // Camera Z axis in world = R^T * [0,0,1] (viewing direction)
            const camForward = this._matTransposeVec(R, [0, 0, 1]);

            // --- Compute four corners of the "image plane" rectangle ---
            // Center of the near plane
            const nearCenter = [
                camPos[0] + camForward[0] * pyramidDepth,
                camPos[1] + camForward[1] * pyramidDepth,
                camPos[2] + camForward[2] * pyramidDepth,
            ];

            // Compute frustum-correct half dimensions from camera intrinsics
            const aspectRatio = cam.size ? cam.size[0] / cam.size[1] : 4 / 3;
            var halfH, halfW;
            if (cam.matrix && cam.size) {
                var fy = cam.matrix[1][1];
                var fovY = 2 * Math.atan(cam.size[1] / (2 * fy));
                halfH = pyramidDepth * Math.tan(fovY / 2);
                halfW = halfH * aspectRatio;
            } else {
                halfH = 20 * sceneScale;
                halfW = halfH * aspectRatio;
            }

            // Four corners: top-left, top-right, bottom-right, bottom-left
            // "Top" in camera frame is -Y (since Y points down in OpenCV convention)
            const corners = [
                this._addVec3(nearCenter,
                    this._scaleVec3(camRight, -halfW),
                    this._scaleVec3(camDown, -halfH)),
                this._addVec3(nearCenter,
                    this._scaleVec3(camRight, halfW),
                    this._scaleVec3(camDown, -halfH)),
                this._addVec3(nearCenter,
                    this._scaleVec3(camRight, halfW),
                    this._scaleVec3(camDown, halfH)),
                this._addVec3(nearCenter,
                    this._scaleVec3(camRight, -halfW),
                    this._scaleVec3(camDown, halfH)),
            ];

            // --- Build wireframe geometry (pyramid) ---
            if (this.showCameraPyramids && this.pyramidLength > 0) {
                // Apex edges: 4 lines from camera center to each corner
                const apexPositions = [];
                for (let c = 0; c < 4; c++) {
                    apexPositions.push(camPos[0], camPos[1], camPos[2]);
                    apexPositions.push(corners[c][0], corners[c][1], corners[c][2]);
                }

                const apexGeo = new THREE.BufferGeometry();
                apexGeo.setAttribute('position',
                    new THREE.Float32BufferAttribute(apexPositions, 3));
                const apexMat = new THREE.LineBasicMaterial({
                    color: 0xffdd44,
                    transparent: true,
                    opacity: 0.7,
                });
                const apexLines = new THREE.LineSegments(apexGeo, apexMat);
                apexLines.name = 'camera_' + cam.name;
                this._cameraGroup.add(apexLines);

                // Base edges: 4 lines around the rectangle
                const basePositions = [];
                for (let c = 0; c < 4; c++) {
                    const next = (c + 1) % 4;
                    basePositions.push(corners[c][0], corners[c][1], corners[c][2]);
                    basePositions.push(corners[next][0], corners[next][1], corners[next][2]);
                }

                const baseGeo = new THREE.BufferGeometry();
                baseGeo.setAttribute('position',
                    new THREE.Float32BufferAttribute(basePositions, 3));
                const baseMat = new THREE.LineBasicMaterial({
                    color: 0xffdd44,
                    transparent: true,
                    opacity: 0.7,
                });
                const baseLines = new THREE.LineSegments(baseGeo, baseMat);
                baseLines.name = 'cameraBase_' + cam.name;
                this._cameraGroup.add(baseLines);

                // --- Invisible hitbox mesh for click detection ---
                const hitPositions = [];
                for (let c = 0; c < 4; c++) {
                    const next = (c + 1) % 4;
                    hitPositions.push(
                        camPos[0], camPos[1], camPos[2],
                        corners[c][0], corners[c][1], corners[c][2],
                        corners[next][0], corners[next][1], corners[next][2]
                    );
                }
                hitPositions.push(
                    corners[0][0], corners[0][1], corners[0][2],
                    corners[1][0], corners[1][1], corners[1][2],
                    corners[2][0], corners[2][1], corners[2][2],
                    corners[0][0], corners[0][1], corners[0][2],
                    corners[2][0], corners[2][1], corners[2][2],
                    corners[3][0], corners[3][1], corners[3][2]
                );

                const hitGeo = new THREE.BufferGeometry();
                hitGeo.setAttribute('position',
                    new THREE.Float32BufferAttribute(hitPositions, 3));
                const hitMat = new THREE.MeshBasicMaterial({
                    visible: false,
                    side: THREE.DoubleSide,
                });
                const hitbox = new THREE.Mesh(hitGeo, hitMat);
                hitbox.name = 'camHitbox_' + cam.name;
                this._cameraGroup.add(hitbox);

                // --- Blue "up" direction line ---
                const topMid = [
                    (corners[0][0] + corners[1][0]) / 2,
                    (corners[0][1] + corners[1][1]) / 2,
                    (corners[0][2] + corners[1][2]) / 2,
                ];
                const upLineGeo = new THREE.BufferGeometry();
                upLineGeo.setAttribute('position',
                    new THREE.Float32BufferAttribute([
                        camPos[0], camPos[1], camPos[2],
                        topMid[0], topMid[1], topMid[2],
                    ], 3));
                const upLineMat = new THREE.LineBasicMaterial({
                    color: 0x4488ff,
                    transparent: true,
                    opacity: 0.9,
                });
                const upLine = new THREE.LineSegments(upLineGeo, upLineMat);
                upLine.name = 'camUp_' + cam.name;
                this._cameraGroup.add(upLine);
            }

            // --- Camera label sprite ---
            if (this.showCameraLabels && this.cameraLabelSize > 0) {
                const label = this._createTextSprite(cam.name, {
                    fontSize: this.cameraLabelSize,
                    color: '#ffdd44',
                    backgroundColor: 'rgba(0, 0, 0, 0.5)',
                });
                var labelOffset = (this.cameraSphereSize + (this.cameraLabelSize / 28) * 12) * sceneScale;
                label.position.set(camPos[0], camPos[1], camPos[2] + labelOffset);
                label.scale.multiplyScalar(sceneScale);
                label.name = 'label_' + cam.name;
                this._cameraGroup.add(label);
            }

            // --- Small sphere at camera center ---
            if (this.showCameraSpheres && this.cameraSphereSize > 0) {
                const sphereGeo = new THREE.SphereGeometry(this.cameraSphereSize * sceneScale, 8, 8);
                const sphereMat = new THREE.MeshPhongMaterial({
                    color: 0xffdd44,
                    transparent: true,
                    opacity: 0.8,
                });
                const sphere = new THREE.Mesh(sphereGeo, sphereMat);
                sphere.position.set(camPos[0], camPos[1], camPos[2]);
                sphere.name = 'camSphere_' + cam.name;
                this._cameraGroup.add(sphere);
            }
        }
    }

    // ============================================
    // Camera Picking & Perspective Animation
    // ============================================

    /**
     * Set up raycaster-based click detection on camera objects.
     * Clicking a camera pyramid/sphere/label animates to that camera's perspective.
     * @private
     */
    _setupCameraPicking() {
        this._raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();

        this.renderer.domElement.addEventListener('click', (e) => {
            // A plane-corner drag that happens to end over a camera pyramid
            // still produces a `click`. Swallow exactly that one, or letting go
            // of a corner would jump the view into a camera's perspective.
            if (this._suppressCameraClick) {
                this._suppressCameraClick = false;
                return;
            }
            // Set Origin Mode owns the click while it is armed, and consumes it
            // even on a miss — a stray click must not select a camera and swing
            // the view away from the corner the user is aiming at.
            if (this._originPickMode) {
                this._handleOriginPick(e);
                return;
            }
            const rect = this.renderer.domElement.getBoundingClientRect();
            mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

            this._raycaster.setFromCamera(mouse, this.threeCamera);

            // Collect all meshes in the camera group for intersection
            const meshes = [];
            this._cameraGroup.traverse(function (child) {
                if (child.isMesh) meshes.push(child);
            });

            const intersects = this._raycaster.intersectObjects(meshes, false);
            if (intersects.length > 0) {
                const hitObj = intersects[0].object;
                const camName = this._getCameraNameFromObject(hitObj);
                if (camName) {
                    this.selectCamera(camName);
                }
            }
        });
        // The controls' own 'change' listener is attached in `_createControls`,
        // so it survives a rebuild.
    }

    // ============================================
    // Plane-corner dragging (View ▸ Define Planes)
    // ============================================

    /**
     * Let the user drag a plane's corners directly in the 3D scene.
     *
     * Two rules, both enforced here rather than by the caller:
     *   1. Only a plane that has been FIT is draggable. `setPlanes` marks node
     *      meshes with `userData.planeEditable`, and only those are ever picked,
     *      so an un-fit (merely triangulated) plane's corners are inert.
     *   2. A corner can only move WITHIN the plane it was fitted to. The drag
     *      resolves the pointer ray against that plane, so the result is on it
     *      by construction — there is no "move then re-project" step that could
     *      drift, and no way to pull a corner off the plane at all.
     *
     * The fit itself (centroid + normal) is held FIXED for the whole drag and
     * is not re-derived after it. That is the point: those two are what a later
     * step turns into the origin's translation + rotation, and nudging a corner
     * must not move the frame it defines. Re-fitting mid-drag would also let
     * the plane chase the corner being dragged.
     * @private
     */
    _setupPlaneEditing() {
        const dom = this.renderer.domElement;

        // Scratch objects, reused per event — these run on every pointer move.
        this._planeNdc = new THREE.Vector2();
        this._planeMathPlane = new THREE.Plane();
        this._planeHitPoint = new THREE.Vector3();
        this._planeHoverCursor = '';

        // CAPTURE, and on the CONTAINER rather than the canvas. OrbitControls
        // registered its own `pointerdown` on the canvas back in `_init`, and
        // at the target element capture and bubble listeners fire in
        // REGISTRATION order — so a capture listener on the canvas would still
        // run second and the orbit would already have started. From an ancestor
        // the capture phase genuinely precedes the target, which lets us
        // stopPropagation() and keep OrbitControls from ever seeing the press.
        this._onPlaneDownCapture = (e) => this._onPlanePointerDown(e);
        this.container.addEventListener('pointerdown', this._onPlaneDownCapture, true);

        this._onPlaneMoveBound = (e) => this._onPlanePointerMove(e);
        this._onPlaneUpBound = (e) => this._onPlanePointerUp(e);
        dom.addEventListener('pointermove', this._onPlaneMoveBound);
        dom.addEventListener('pointerup', this._onPlaneUpBound);
        dom.addEventListener('pointercancel', this._onPlaneUpBound);
    }

    /**
     * The `setPlanes` payload entry for a plane id, or null.
     * @private
     */
    _planePayloadById(id) {
        for (let i = 0; i < this._planes.length; i++) {
            if (this._planes[i].id === id) return this._planes[i];
        }
        return null;
    }

    /**
     * Raycast the pointer against DRAGGABLE plane-corner meshes only.
     * @returns {THREE.Mesh|null}
     * @private
     */
    _pickPlaneNode(e) {
        if (this._disposed || !this.renderer || !this._planeGroup) return null;
        const dom = this.renderer.domElement;
        const rect = dom.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;

        const meshes = [];
        this._planeGroup.traverse(function (child) {
            if (child.isMesh && child.userData && child.userData.planeEditable) meshes.push(child);
        });
        if (meshes.length === 0) return null;
        // See `_handleOriginPick`: a plane rebuilt this frame would otherwise be
        // raycast against transforms `render()` has not written yet.
        if (this.scene) this.scene.updateMatrixWorld();

        this._planeNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._planeNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._planeNdc, this.threeCamera);
        const hits = this._raycaster.intersectObjects(meshes, false);
        return hits.length > 0 ? hits[0].object : null;
    }

    /** @private */
    _onPlanePointerDown(e) {
        if (this._disposed || !this.renderer) return;
        // Self-heal: if a previous drag ended off-canvas no `click` followed, so
        // the suppression flag is still set. Clear it before it eats a real one.
        this._suppressCameraClick = false;
        // The container also holds the overlay buttons ("Show Camera View", …).
        if (e.target !== this.renderer.domElement) return;
        if (e.button !== 0) return;

        const mesh = this._pickPlaneNode(e);
        if (!mesh) return;
        const payload = this._planePayloadById(mesh.userData.planeId);
        if (!payload || !payload.planeFit) return;

        const n = payload.planeFit.normal;
        const c = payload.planeFit.centroid;
        if (!n || !c) return;
        this._planeMathPlane.setFromNormalAndCoplanarPoint(
            new THREE.Vector3(n[0], n[1], n[2]).normalize(),
            new THREE.Vector3(c[0], c[1], c[2]));

        this._planeDrag = {
            planeId: mesh.userData.planeId,
            nodeIdx: mesh.userData.nodeIdx,
            moved: false,
            pointerId: e.pointerId,
        };
        if (this.controls) this.controls.enabled = false;
        // Keep OrbitControls from starting an orbit under the drag.
        e.stopPropagation();
        e.preventDefault();
        try { this.renderer.domElement.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
    }

    /** @private */
    _onPlanePointerMove(e) {
        if (this._disposed || !this.renderer) return;
        if (!this._planeDrag) {
            this._updatePlaneHoverCursor(e);
            return;
        }

        const dom = this.renderer.domElement;
        const rect = dom.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        this._planeNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._planeNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._planeNdc, this.threeCamera);

        // Edge-on views make the ray nearly parallel to the plane, where the
        // intersection is numerically meaningless and would fling the corner to
        // a huge coordinate. Refuse rather than move it somewhere absurd.
        const cosine = this._raycaster.ray.direction.dot(this._planeMathPlane.normal);
        if (Math.abs(cosine) < 1e-3) return;
        const hit = this._raycaster.ray.intersectPlane(this._planeMathPlane, this._planeHitPoint);
        if (!hit) return;
        if (!isFinite(hit.x) || !isFinite(hit.y) || !isFinite(hit.z)) return;

        this._planeDrag.moved = true;
        e.preventDefault();
        if (this.onPlaneNodeDragged) {
            this.onPlaneNodeDragged(this._planeDrag.planeId, this._planeDrag.nodeIdx,
                [hit.x, hit.y, hit.z]);
        }
    }

    /** @private */
    _onPlanePointerUp(e) {
        if (!this._planeDrag) return;
        const drag = this._planeDrag;
        this._planeDrag = null;
        if (this.controls) this.controls.enabled = true;
        if (this.renderer) {
            try { this.renderer.domElement.releasePointerCapture(drag.pointerId); } catch (_) { /* never captured */ }
        }
        this._suppressCameraClick = true;
        if (drag.moved && this.onPlaneNodeDragEnd) {
            this.onPlaneNodeDragEnd(drag.planeId, drag.nodeIdx);
        }
    }

    /**
     * Cursor affordance: draggable corners are the only thing in the 3D scene
     * that responds to a press, so they have to look different.
     * @private
     */
    _updatePlaneHoverCursor(e) {
        if (!this.renderer) return;
        // Set Origin Mode owns the cursor while it is armed.
        if (this._originPickMode) return;
        const want = this._pickPlaneNode(e) ? 'move' : '';
        if (this._planeHoverCursor === want) return;
        this._planeHoverCursor = want;
        this.renderer.domElement.style.cursor = want;
    }

    /**
     * Select a camera by name. Highlights it in 3D and notifies the callback.
     * @param {string} cameraName
     */
    selectCamera(cameraName) {
        // Toggle if same camera clicked again
        if (this.selectedCamera === cameraName) {
            this.selectedCamera = null;
            this.highlightCamera(null);
            if (this.onCameraClicked) {
                this.onCameraClicked(null);
            }
            return;
        }
        this.selectedCamera = cameraName;
        this.highlightCamera(cameraName);
        if (this.onCameraClicked) {
            this.onCameraClicked(cameraName);
        }
    }

    /**
     * Animate to the selected camera's perspective.
     * Called by the "Show Camera View" button.
     */
    showSelectedCameraView() {
        if (!this.selectedCamera) return;
        // Restore previous camera's geometry before switching
        if (this._viewingCamera && this._viewingCamera !== this.selectedCamera) {
            this._setDeclutter(this._viewingCamera, false);
        }
        this._viewingCamera = this.selectedCamera;
        this.animateToCameraPerspective(this.selectedCamera);
        // Declutter after animation completes
        setTimeout(() => { this._setDeclutter(this._viewingCamera, true); }, 550);
        // Notify callback for UI updates (e.g., showing "Initial View" button)
        if (this.onCameraViewChanged) {
            this.onCameraViewChanged(true);
        }
    }

    /**
     * Reset the 3D viewport to the initial fitted view.
     * Called by the "Show Initial View" button.
     */
    showInitialView() {
        // Restore decluttered camera if any
        if (this._viewingCamera) {
            this._setDeclutter(this._viewingCamera, false);
            this._viewingCamera = null;
        }
        this._viewingCamData = null;
        // Reset FOV and up vector to defaults before fitting — "up" being the
        // displayed frame's +Z, which is world +Z until an origin is applied.
        this.threeCamera.fov = 50;
        this.threeCamera.up.copy(this.originUp());
        this.threeCamera.updateProjectionMatrix();
        this.fitToScene();
        if (this.onCameraViewChanged) {
            this.onCameraViewChanged(false);
        }
    }

    /**
     * Check distance from three.js camera to the viewed camera.
     * If close, hide that camera's geometry; if far, restore.
     * @private
     */
    _checkDeclutter() {
        if (!this._viewingCamera) return;
        var cam = null;
        for (var i = 0; i < this.cameras.length; i++) {
            if (this.cameras[i].name === this._viewingCamera) {
                cam = this.cameras[i];
                break;
            }
        }
        if (!cam) return;

        var R = cam.rotationMatrix;
        var t = cam.tvec;
        var camPos = this._computeCameraPosition(R, t);
        var dx = this.threeCamera.position.x - camPos[0];
        var dy = this.threeCamera.position.y - camPos[1];
        var dz = this.threeCamera.position.z - camPos[2];
        var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        // Threshold: hide when close, show when zoomed out far enough (hysteresis)
        var hideThreshold = 80 * this._sceneScale;
        var showThreshold = 200 * this._sceneScale;
        if (dist < hideThreshold) {
            this._setDeclutter(this._viewingCamera, true);
        } else if (dist > showThreshold) {
            this._setDeclutter(this._viewingCamera, false);
            this._viewingCamera = null;
            this._viewingCamData = null;
            if (this.onCameraViewChanged) {
                this.onCameraViewChanged(false);
            }
        }
    }

    /**
     * Show or hide camera geometry for declutter.
     * @param {string} cameraName
     * @param {boolean} hide - true to hide, false to show
     * @private
     */
    _setDeclutter(cameraName, hide) {
        if (!this._cameraGroup) return;
        var hidePrefixes = ['camera_', 'label_', 'camUp_', 'camSphere_', 'camHitbox_'];
        var self = this;
        this._cameraGroup.traverse(function (child) {
            // Hide apex edges, label, up line, sphere, hitbox
            for (var p = 0; p < hidePrefixes.length; p++) {
                if (child.name === hidePrefixes[p] + cameraName) {
                    child.visible = !hide;
                }
            }
            // Bold the base when viewing, restore when not
            if (child.name === 'cameraBase_' + cameraName) {
                if (hide) {
                    child.material.color.set(0xffffff);
                    child.material.opacity = 1.0;
                    child.visible = true;
                } else {
                    // Restore default (or highlighted) color
                    var isSelected = self.selectedCamera === cameraName;
                    child.material.color.set(isSelected ? 0xff4444 : 0xffdd44);
                    child.material.opacity = isSelected ? 1.0 : 0.7;
                    child.visible = true;
                }
            }
        });
    }

    /**
     * Extract camera name from a hit object's name (e.g. "camSphere_back" -> "back").
     * @param {THREE.Object3D} obj
     * @returns {string|null}
     * @private
     */
    _getCameraNameFromObject(obj) {
        if (!obj || !obj.name) return null;
        // Objects are named: camera_NAME, cameraBase_NAME, camHitbox_NAME, label_NAME, camSphere_NAME, camUp_NAME
        const prefixes = ['camSphere_', 'camera_', 'cameraBase_', 'camHitbox_', 'label_', 'camUp_'];
        for (const prefix of prefixes) {
            if (obj.name.startsWith(prefix)) {
                return obj.name.substring(prefix.length);
            }
        }
        // Check parent chain
        if (obj.parent) {
            return this._getCameraNameFromObject(obj.parent);
        }
        return null;
    }

    /**
     * Animate the 3D viewport camera to match a real camera's perspective.
     *
     * Computes the camera's world position and orientation from its extrinsics,
     * then smoothly interpolates the Three.js camera to that viewpoint.
     *
     * @param {string} cameraName - Name of the camera to match
     */
    animateToCameraPerspective(cameraName) {
        // Find the camera object
        let cam = null;
        for (let i = 0; i < this.cameras.length; i++) {
            if (this.cameras[i].name === cameraName) {
                cam = this.cameras[i];
                break;
            }
        }
        if (!cam) return;

        const R = cam.rotationMatrix;
        const t = cam.tvec;

        // Camera world position: -R^T * t
        const camPos = this._computeCameraPosition(R, t);

        // View direction in world: R^T * [0, 0, 1]
        const viewDir = this._matTransposeVec(R, [0, 0, 1]);

        // Up vector in world: R^T * [0, -1, 0] (OpenCV Y-down → world up)
        const upVec = this._matTransposeVec(R, [0, -1, 0]);

        // Look-at target = position + viewDir * 100mm
        const targetPos = [
            camPos[0] + viewDir[0] * 100,
            camPos[1] + viewDir[1] * 100,
            camPos[2] + viewDir[2] * 100,
        ];

        // Compute FOV to fit pyramid base within the viewer window.
        // The vertical FOV from intrinsics defines the base height; we also
        // need the base width to fit horizontally given the viewer's aspect ratio.
        let targetFov = 50; // default
        if (cam.matrix && cam.size) {
            const fy = cam.matrix[1][1];
            const imageH = cam.size[1];
            const cameraFovY = 2 * Math.atan(imageH / (2 * fy));
            const cameraAspect = cam.size[0] / cam.size[1];
            const viewerAspect = this.threeCamera.aspect;

            // FOV needed to fit height vs width
            var fovForHeight = cameraFovY;
            var fovForWidth = 2 * Math.atan(Math.tan(cameraFovY / 2) * cameraAspect / viewerAspect);
            targetFov = Math.max(fovForHeight, fovForWidth) * (180 / Math.PI);
        }

        // Store viewing parameters for dynamic resize
        this._viewingCamData = cam;

        // Animate over 500ms
        const startPos = this.threeCamera.position.clone();
        const startTarget = this.controls.target.clone();
        const startUp = this.threeCamera.up.clone();
        const startFov = this.threeCamera.fov;

        const endPos = new THREE.Vector3(camPos[0], camPos[1], camPos[2]);
        const endTarget = new THREE.Vector3(targetPos[0], targetPos[1], targetPos[2]);
        const endUp = new THREE.Vector3(upVec[0], upVec[1], upVec[2]).normalize();

        const duration = 500; // ms
        const startTime = performance.now();

        // Cancel any running animation
        if (this._perspectiveAnimId) {
            cancelAnimationFrame(this._perspectiveAnimId);
        }

        // Suppress orbit controls during animation to prevent fighting
        this._animatingPerspective = true;
        this.controls.enabled = false;

        // Hidden: snap to the end state. There is no fly-in to watch, and this
        // animation drives its OWN rAF loop that calls renderer.render()
        // directly — running it would defeat the paused main loop.
        if (!this._visible) {
            this._animatingPerspective = false;
            this.controls.enabled = true;
            this.threeCamera.position.copy(endPos);
            this.threeCamera.up.copy(endUp).normalize();
            this.threeCamera.fov = targetFov;
            this.threeCamera.updateProjectionMatrix();
            this.controls.target.copy(endTarget);
            this.controls.update();
            return;
        }

        const self = this;
        function animate() {
            const elapsed = performance.now() - startTime;
            const rawT = Math.min(1, elapsed / duration);
            // Ease in-out (smoothstep)
            const progress = rawT * rawT * (3 - 2 * rawT);

            self.threeCamera.position.lerpVectors(startPos, endPos, progress);
            self.controls.target.copy(endTarget);  // Set target directly each frame
            self.threeCamera.up.lerpVectors(startUp, endUp, progress).normalize();
            self.threeCamera.fov = startFov + (targetFov - startFov) * progress;
            self.threeCamera.updateProjectionMatrix();

            // Explicit render to ensure changes are visible
            self.renderer.render(self.scene, self.threeCamera);

            if (rawT < 1) {
                self._perspectiveAnimId = requestAnimationFrame(animate);
            } else {
                self._perspectiveAnimId = null;
                // Finalize: set exact end state
                self.threeCamera.position.copy(endPos);
                self.threeCamera.up.copy(endUp).normalize();
                self.threeCamera.fov = targetFov;
                self.threeCamera.updateProjectionMatrix();
                self.controls.target.copy(endTarget);
                // Re-enable orbit controls — reset internal state so it doesn't snap back
                self.controls.enabled = true;
                self._animatingPerspective = false;
                self.controls.update();
            }
        }

        animate();
    }

    // ============================================
    // Skeleton Visualization
    // ============================================

    /**
     * Update the 3D skeleton display for the current frame.
     *
     * For each InstanceGroup that has triangulated points3d, draws:
     *   - Spheres at each valid 3D keypoint position
     *   - Cylindrical line segments for skeleton edges between valid points
     *   - Colors determined by track index via getTrackColor
     *
     * @param {InstanceGroup[]} instanceGroups - Array of InstanceGroup objects
     *        for the current frame. Each should have .points3d (flat Float64Array
     *        or null per node) and .trackIdx.
     */
    updateSkeleton(instanceGroups) {
        // IN-PLACE update. This runs on every frame of playback (the 3D view
        // follows the video like the 2D overlays do), so it must not rebuild
        // the scene: the old version created fresh materials per group, a fresh
        // node geometry, and a fresh CylinderGeometry — a GPU buffer upload — for
        // every edge on every call, then disposed them all on the next. Now the
        // meshes and materials live in a pool (`_skelPool`) and are only moved /
        // recolored; edges share ONE unit cylinder scaled to length. The pool is
        // rebuilt only when something that changes geometry changes (node shape
        // / size, edge weight, show-nodes/edges, the skeleton object).
        //
        // The resulting scene graph is the same as a rebuild's: `_skeletonGroup`
        // holds one `instance_<g>` Group per group with 3D, whose children are
        // exactly that frame's valid `node_*` markers then `edge_*` cylinders, in
        // the same order. Pooled-but-unused objects are DETACHED, not hidden, so
        // traversals (fitToScene, tests) see what they always saw.
        var _dbg3d = (typeof window !== 'undefined' && window.LUCID_3D_DEBUG);

        const ss = this._sceneScale || 1;
        const nodeRadius = this.skeletonNodeSize * ss;
        const edgeRadius = this.skeletonEdgeWeight * ss;
        const highlightScale = 1.5;  // scale factor for selected instance
        const nodeShape = this.skeletonNodeShape || 'circle';
        const pool = this._ensureSkeletonPool(nodeShape, nodeRadius, edgeRadius);

        // Detach last frame's groups (pooled — not disposed).
        this._detachChildren(this._skeletonGroup);

        if (!instanceGroups || instanceGroups.length === 0) {
            if (_dbg3d) console.log('[3D] updateSkeleton: no instance groups');
            return;
        }
        if (_dbg3d) {
            var groupsWithPts = instanceGroups.filter(function(g) { return points3dNodeCount(g.points3d) > 0; });
            console.log('[3D] updateSkeleton:', instanceGroups.length, 'groups,', groupsWithPts.length, 'with points3d, sceneScale:', this._sceneScale);
        }

        const edges = this.skeleton.edges || [];
        const nodes = this.skeleton.nodes || [];
        const showNodes = this.showSkeletonNodes && nodeRadius > 0;
        const showEdges = this.showSkeletonEdges && edgeRadius > 0;
        const dir = pool.tmpDir, yAxis = pool.yAxis;
        let slotIdx = 0;

        for (let g = 0; g < instanceGroups.length; g++) {
            const group = instanceGroups[g];
            const pts = group.points3d;
            const nPts = points3dNodeCount(pts);
            if (nPts === 0) continue;

            const slot = pool.slots[slotIdx] || (pool.slots[slotIdx] = this._newSkeletonSlot());
            slotIdx++;

            const colorStr = this.getGroupColorFn
                ? this.getGroupColorFn(group)
                : this.getTrackColor(group.identityId >= 0 ? group.identityId : g);
            const isSelected = (this.selectedInstanceIdx === g);
            const scale = isSelected ? highlightScale : 1.0;

            // Brightness dims the track/identity color; the selected instance
            // keeps its full color so the selection still stands out.
            const brightness = isSelected ? 1 : Math.min(1, Math.max(0, this.skeletonBrightness));

            // Recolor only on change. Uniform-only edits: no shader recompile.
            // Emissive boost for the selected instance.
            if (slot.colorStr !== colorStr || slot.selected !== isSelected || slot.brightness !== brightness) {
                slot.colorStr = colorStr;
                slot.selected = isSelected;
                slot.brightness = brightness;
                const emissiveIntensity = isSelected ? 0.4 : 0.0;
                slot.nodeMat.color.set(colorStr);
                // Guarded: the Node test runner's THREE.Color mock has no multiplyScalar.
                if (brightness < 1 && slot.nodeMat.color.multiplyScalar) slot.nodeMat.color.multiplyScalar(brightness);
                slot.nodeMat.emissive.set(isSelected ? colorStr : 0x000000);
                slot.nodeMat.emissiveIntensity = emissiveIntensity;
                slot.edgeMat.color.set(colorStr);
                if (brightness < 1 && slot.edgeMat.color.multiplyScalar) slot.edgeMat.color.multiplyScalar(brightness);
                slot.edgeMat.emissive.set(isSelected ? colorStr : 0x000000);
                slot.edgeMat.emissiveIntensity = emissiveIntensity * 0.5;
            }

            const instanceGroup3D = slot.group3D;
            instanceGroup3D.name = 'instance_' + g;
            this._detachChildren(instanceGroup3D);

            // --- Keypoint markers (shape per Node Style toggle) ---
            if (showNodes) {
                let ni = 0;
                for (let n = 0; n < nPts; n++) {
                    const pt = getPoint3d(pts, n);
                    if (pt == null) continue;
                    // Guard against Inf coords (e.g. missing keypoints in an
                    // imported points3d H5) — they would produce broken meshes and
                    // poison bounding-sphere / fitToScene math. (NaN is already
                    // filtered by getPoint3d, which treats it as "missing".)
                    if (!isFinite(pt[0]) || !isFinite(pt[1]) || !isFinite(pt[2])) continue;

                    let nodeObj = slot.nodeObjs[ni];
                    if (!nodeObj) {
                        if (nodeShape === 'x') {
                            // 'x' has no single geometry — two crossed bars.
                            nodeObj = new THREE.Group();
                            const barA = new THREE.Mesh(pool.xBarGeo, slot.nodeMat);
                            barA.rotation.z = Math.PI / 4;
                            const barB = new THREE.Mesh(pool.xBarGeo, slot.nodeMat);
                            barB.rotation.z = -Math.PI / 4;
                            nodeObj.add(barA);
                            nodeObj.add(barB);
                        } else {
                            nodeObj = new THREE.Mesh(pool.nodeGeo, slot.nodeMat);
                        }
                        slot.nodeObjs[ni] = nodeObj;
                    }
                    ni++;
                    nodeObj.position.set(pt[0], pt[1], pt[2]);
                    nodeObj.scale.setScalar(scale);
                    nodeObj.name = 'node_' + (nodes[n] || n);
                    instanceGroup3D.add(nodeObj);
                }
            }

            // --- Skeleton edges: the shared unit cylinder (radius 1, height 1,
            // along +Y) scaled to (radius, length, radius), centred on the edge
            // midpoint and rotated from +Y onto the edge direction. ---
            if (showEdges) {
                const r = edgeRadius * scale;
                let ei = 0;
                for (let e = 0; e < edges.length; e++) {
                    const srcIdx = edges[e][0];
                    const dstIdx = edges[e][1];

                    if (srcIdx >= nPts || dstIdx >= nPts) continue;
                    const srcPt = getPoint3d(pts, srcIdx);
                    const dstPt = getPoint3d(pts, dstIdx);
                    if (srcPt == null || dstPt == null) continue;
                    if (!isFinite(srcPt[0]) || !isFinite(srcPt[1]) || !isFinite(srcPt[2])) continue;
                    if (!isFinite(dstPt[0]) || !isFinite(dstPt[1]) || !isFinite(dstPt[2])) continue;

                    let cyl = slot.edgeMeshes[ei];
                    if (!cyl) cyl = slot.edgeMeshes[ei] = new THREE.Mesh(pool.edgeGeo, slot.edgeMat);
                    ei++;

                    const dx = dstPt[0] - srcPt[0];
                    const dy = dstPt[1] - srcPt[1];
                    const dz = dstPt[2] - srcPt[2];
                    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    if (length < 1e-6) {
                        // Degenerate edge: same as the old _createCylinder — a
                        // 0.001-tall, un-rotated cylinder left at the origin.
                        cyl.position.set(0, 0, 0);
                        cyl.quaternion.identity();
                        cyl.scale.set(r, 0.001, r);
                    } else {
                        cyl.position.set((srcPt[0] + dstPt[0]) / 2,
                            (srcPt[1] + dstPt[1]) / 2, (srcPt[2] + dstPt[2]) / 2);
                        dir.set(dx / length, dy / length, dz / length);
                        cyl.quaternion.setFromUnitVectors(yAxis, dir);
                        cyl.scale.set(r, length, r);
                    }
                    cyl.name = 'edge_' + srcIdx + '_' + dstIdx;
                    instanceGroup3D.add(cyl);
                }
            }

            this._skeletonGroup.add(instanceGroup3D);
            if (_dbg3d) console.log('[3D] Added instance group with', instanceGroup3D.children.length, 'meshes');
        }

        if (_dbg3d) console.log('[3D] updateSkeleton complete:', this._skeletonGroup.children.length, 'instance groups in scene');
    }

    /**
     * Return the skeleton mesh pool for the current geometry settings,
     * (re)building it — and disposing the old one — when any of them changed.
     * Holds the shared geometries (node marker, 'x' bar, unit edge cylinder)
     * and the per-instance-group slots `_newSkeletonSlot` creates.
     * @private
     */
    _ensureSkeletonPool(nodeShape, nodeRadius, edgeRadius) {
        const key = nodeShape + '|' + nodeRadius + '|' + edgeRadius + '|' +
            !!this.showSkeletonNodes + '|' + !!this.showSkeletonEdges;
        let pool = this._skelPool;
        if (pool && pool.key === key && pool.skeleton === this.skeleton) return pool;

        this._disposeSkeletonPool();
        const sphereSegments = 12;
        const cylinderSegments = 6;
        let nodeGeo = null, xBarGeo = null;
        if (nodeShape === 'square') {
            const sq = nodeRadius * 1.7;
            nodeGeo = new THREE.BoxGeometry(sq, sq, sq);
        } else if (nodeShape === 'triangle') {
            nodeGeo = new THREE.TetrahedronGeometry(nodeRadius * 1.4);
        } else if (nodeShape === 'x') {
            const barLen = nodeRadius * 2.6;
            const barThin = Math.max(0.0001, nodeRadius * 0.45);
            xBarGeo = new THREE.BoxGeometry(barLen, barThin, barThin);
        } else {
            nodeGeo = new THREE.SphereGeometry(nodeRadius, sphereSegments, sphereSegments);
        }
        pool = this._skelPool = {
            key: key,
            skeleton: this.skeleton,
            nodeGeo: nodeGeo,
            xBarGeo: xBarGeo,
            edgeGeo: new THREE.CylinderGeometry(1, 1, 1, cylinderSegments),
            slots: [],
            tmpDir: new THREE.Vector3(),
            yAxis: new THREE.Vector3(0, 1, 0),
        };
        return pool;
    }

    /**
     * Detach (not dispose) every child of `group` — pooled objects are reused.
     * Uses `remove()` like `_clearGroup`, rather than Object3D.clear(), so it
     * works with any Three build and with the test runners' THREE mocks.
     * @private
     */
    _detachChildren(group) {
        while (group.children.length > 0) group.remove(group.children[group.children.length - 1]);
    }

    /**
     * One pooled instance group: its THREE.Group, its two materials, and the
     * node / edge objects it has needed so far (grown on demand, reused after).
     * @private
     */
    _newSkeletonSlot() {
        return {
            group3D: new THREE.Group(),
            nodeMat: new THREE.MeshPhongMaterial({ color: 0xffffff, emissive: 0x000000, emissiveIntensity: 0, shininess: 60 }),
            edgeMat: new THREE.MeshPhongMaterial({ color: 0xffffff, emissive: 0x000000, emissiveIntensity: 0, shininess: 30 }),
            nodeObjs: [],
            edgeMeshes: [],
            colorStr: null,
            selected: null,
            brightness: null,
        };
    }

    /**
     * Detach every pooled skeleton object from the scene and free the pool's
     * GPU resources (shared geometries + every slot's materials).
     * @private
     */
    _disposeSkeletonPool() {
        if (this._skeletonGroup) this._detachChildren(this._skeletonGroup);
        const pool = this._skelPool;
        if (!pool) return;
        if (pool.nodeGeo) pool.nodeGeo.dispose();
        if (pool.xBarGeo) pool.xBarGeo.dispose();
        if (pool.edgeGeo) pool.edgeGeo.dispose();
        for (const slot of pool.slots) {
            slot.nodeMat.dispose();
            slot.edgeMat.dispose();
        }
        this._skelPool = null;
    }

    /**
     * Set a persistent environment overlay from triangulated 3D points.
     * This is rendered as a semi-transparent skeleton that persists across frame changes.
     *
     * @param {Array<InstanceGroup>} instanceGroups - Groups whose points3d to freeze as environment
     */
    setEnvironment(instanceGroups) {
        // Hidden: defer. This one has to capture `this.skeleton` explicitly —
        // callers set an env-specific skeleton, call in, then restore the
        // normal one on the next line (`ui/ui-wiring.js`'s Set Env handler),
        // so a thunk reading `this.skeleton` later would build env edges from
        // the wrong skeleton.
        if (!this._visible) {
            const envSkeleton = this.skeleton;
            this._deferred.set('environment', () => {
                const saved = this.skeleton;
                this.skeleton = envSkeleton;
                try { this.setEnvironment(instanceGroups); }
                finally { this.skeleton = saved; }
            });
            return;
        }

        this._clearGroup(this._envGroup);

        if (!instanceGroups || instanceGroups.length === 0) {
            console.log('[3D] clearEnvironment');
            return;
        }

        const ss = this._sceneScale || 1;
        const nodeRadius = this.skeletonNodeSize * 0.75 * ss;
        const edgeRadius = this.skeletonEdgeWeight * 0.75 * ss;
        const sphereSegments = 10;
        const cylinderSegments = 6;
        const sphereGeo = new THREE.SphereGeometry(nodeRadius, sphereSegments, sphereSegments);
        const edges = this.skeleton.edges || [];
        const nodes = this.skeleton.nodes || [];

        var envColor = new THREE.Color(0xdddddd);

        var nodeMaterial = new THREE.MeshPhongMaterial({
            color: envColor,
            opacity: 1.0,
            shininess: 60,
        });

        var edgeMaterial = new THREE.MeshPhongMaterial({
            color: envColor,
            transparent: true,
            opacity: 0.8,
            shininess: 40,
        });

        for (var g = 0; g < instanceGroups.length; g++) {
            var group = instanceGroups[g];
            var pts = group.points3d;
            var nPts = points3dNodeCount(pts);
            if (nPts === 0) continue;

            var envGroup3D = new THREE.Group();
            envGroup3D.name = 'env_' + g;

            for (var n = 0; n < nPts; n++) {
                var pt = getPoint3d(pts, n);
                if (pt == null) continue;
                var mesh = new THREE.Mesh(sphereGeo, nodeMaterial);
                mesh.position.set(pt[0], pt[1], pt[2]);
                mesh.name = 'env_node_' + (nodes[n] || n);
                envGroup3D.add(mesh);
            }

            for (var e = 0; e < edges.length; e++) {
                var srcIdx = edges[e][0];
                var dstIdx = edges[e][1];
                if (srcIdx >= nPts || dstIdx >= nPts) continue;
                var srcPt = getPoint3d(pts, srcIdx);
                var dstPt = getPoint3d(pts, dstIdx);
                if (srcPt == null || dstPt == null) continue;

                var cylinder = this._createCylinder(srcPt, dstPt, edgeRadius, edgeMaterial, cylinderSegments);
                cylinder.name = 'env_edge_' + srcIdx + '_' + dstIdx;
                envGroup3D.add(cylinder);
            }

            this._envGroup.add(envGroup3D);
        }

        console.log('[3D] setEnvironment:', instanceGroups.length, 'groups,', this._envGroup.children.length, 'in scene');
    }

    /**
     * Clear the persistent environment overlay.
     */
    clearEnvironment() {
        // Same 'environment' key as setEnvironment, so a clear issued while
        // hidden supersedes a pending set rather than being replayed after it.
        if (!this._visible) {
            this._deferred.set('environment', () => this.clearEnvironment());
            return;
        }
        this._clearGroup(this._envGroup);
        console.log('[3D] environment cleared');
    }

    /**
     * Show user-annotated planes (View ▸ Define Planes) in the 3D scene.
     *
     * Full rebuild per call, like `setEnvironment` — a handful of planes with
     * a handful of corners each, so diffing would be more code than it saves.
     * Everything lands in `_planeGroup`, a sibling of `_skeletonGroup`, so the
     * per-frame `updateSkeleton` clear leaves it alone: a plane is static scene
     * geometry, not per-frame content.
     *
     * `points3d` needs no transform on the way in. The Three camera is Z-up
     * (`threeCamera.up.set(0,0,1)`) and the scene is already in the
     * calibration's world frame, so triangulated coordinates go straight into
     * `position.set` — the same as skeleton nodes and camera centres.
     *
     * A plane whose payload carries BOTH `editable` and `planeFit` has
     * draggable corners (see `_setupPlaneEditing`); everything else is inert
     * scenery. The payload is kept in `_planes` so a drag in progress can look
     * up its constraint plane by id across the rebuilds it triggers.
     *
     * `showPlaneSurfaces` / `showPlaneNodes` (the Visibility panel's `Planes`
     * toggles) decide which meshes this builds. They never filter `_planes`:
     * the ids in it are what the selected-node marker, the mesh-object
     * highlight, the angle dialog's role outlines and a live drag all resolve
     * against, so hiding a plane must cost meshes and nothing else.
     *
     * @param {Array<{id:number, name:string, color:string,
     *                nodeIds?:number[],
     *                nodeColors?:string[], nodeImmutable?:boolean[],
     *                edges?:Array<number[]>,
     *                polygonOrder?:number[], filled?:boolean,
     *                editable?:boolean,
     *                planeFit?:{centroid:number[], normal:number[]},
     *                fitted?:boolean,
     *                points3d:Float64Array}>} planes
     */
    setPlanes(planes) {
        this._clearGroup(this._planeGroup);
        this._planes = planes || [];
        if (!planes || planes.length === 0) return;

        const ss = this._sceneScale || 1;
        // Planes size their corners independently of pose nodes — the Plane
        // Appearance "3D Node Size" slider, pushed in by `syncPlanes3D`.
        const nodeRadius = this.planeNodeSize * 0.9 * ss;
        const edgeRadius = this.skeletonEdgeWeight * 0.9 * ss;

        for (let i = 0; i < planes.length; i++) {
            const plane = planes[i];
            const pts = plane.points3d;
            if (!pts) continue;

            const nNodes = points3dNodeCount(pts);
            if (nNodes === 0) continue;

            const planeGroup3D = new THREE.Group();
            planeGroup3D.name = 'plane_' + plane.id;

            // The corners, unless the Visibility panel has them switched off.
            // The payload is still kept whole in `_planes`, so the marker, the
            // mesh highlight and a drag's plane lookup are unaffected — this
            // hides meshes, it does not forget planes.
            if (this.showPlaneNodes) {
                // One shared sphere geometry per plane; materials differ per node
                // because plane nodes carry their own colour (the cross-view
                // correspondence cue).
                const sphereGeo = new THREE.SphereGeometry(nodeRadius, 12, 12);

                // Only a plane WITH A FIT can have its corners dragged — a corner
                // with no plane to slide along has no constrained direction to
                // move in. `planeFit` may be a derived one (see the caller); this
                // asks whether there is a surface, not who supplied it.
                const draggable = !!(plane.editable && plane.planeFit);

                for (let k = 0; k < nNodes; k++) {
                    const pt = getPoint3d(pts, k);
                    if (pt == null) continue;
                    if (!isFinite(pt[0]) || !isFinite(pt[1]) || !isFinite(pt[2])) continue;
                    const color = (plane.nodeColors && plane.nodeColors[k]) || plane.color;
                    const mesh = new THREE.Mesh(sphereGeo, new THREE.MeshPhongMaterial({
                        color: new THREE.Color(color),
                        shininess: 60,
                    }));
                    mesh.position.set(pt[0], pt[1], pt[2]);
                    mesh.name = 'planeNode_' + k;
                    mesh.userData.planeId = plane.id;
                    mesh.userData.nodeIdx = k;
                    // A PINNED node is never draggable, however fitted its plane
                    // is. `planeEditable` gates the hover cursor as well as the
                    // drag (`_pickPlaneNode`), so leaving it true here would offer
                    // a `move` cursor over a corner the edit path then refuses —
                    // an affordance advertising an action that cannot happen.
                    const pinned = !!(plane.nodeImmutable && plane.nodeImmutable[k]);
                    mesh.userData.planeEditable = draggable && !pinned;
                    mesh.userData.planeImmutable = pinned;
                    // Independent of `draggable`: Set Origin Mode turns dragging OFF
                    // but still needs these exact corners to be pickable. A pinned
                    // corner is a PREFERRED origin anchor, so this must not follow
                    // `planeEditable` down.
                    //
                    // `fitted`, NOT `planeFit`: the wizard's question is whether
                    // the user has declared this plane's frame, which is what
                    // `fittedPlanes()` counts. `planeFit` above may be derived, and
                    // a plane nobody has Fit must not silently become eligible to
                    // define the project's origin. A payload that omits `fitted`
                    // falls back to the old meaning so an older caller is unchanged.
                    mesh.userData.planeFitted = plane.fitted !== undefined
                        ? !!plane.fitted : !!plane.planeFit;
                    planeGroup3D.add(mesh);
                }
            }

            // The plane's BODY — its edges and its fill. One flag for both: they
            // are the plane's own shape, while the corners above are the shared
            // pool's nodes, which is the split the two toggles make.
            if (this.showPlaneSurfaces) {
                const edgeMaterial = new THREE.MeshPhongMaterial({
                    color: new THREE.Color(plane.color),
                    shininess: 30,
                    transparent: true,
                    opacity: 0.9,
                });
                const edges = plane.edges || [];
                for (let e = 0; e < edges.length; e++) {
                    const a = getPoint3d(pts, edges[e][0]);
                    const b = getPoint3d(pts, edges[e][1]);
                    if (a == null || b == null) continue;
                    if (!isFinite(a[0]) || !isFinite(a[1]) || !isFinite(a[2])) continue;
                    if (!isFinite(b[0]) || !isFinite(b[1]) || !isFinite(b[2])) continue;
                    const cyl = this._createCylinder(a, b, edgeRadius, edgeMaterial, 6);
                    cyl.name = 'planeEdge_' + edges[e][0] + '_' + edges[e][1];
                    planeGroup3D.add(cyl);
                }

                if (plane.filled) {
                    const fill = this._buildPlaneFillMesh(plane, pts);
                    if (fill) planeGroup3D.add(fill);
                }
            }

            this._planeGroup.add(planeGroup3D);
        }
    }

    /**
     * Triangle-soup mesh filling a plane's polygon, or null if it has fewer
     * than 3 usable corners.
     *
     * Fan triangulation from the first vertex, walking `polygonOrder` — the
     * user's connection cycle when there is one, else the convex hull of the
     * plane's corners, so the fan is over the real outline rather than an
     * index-order bowtie, and an interior corner is COVERED by the fill rather
     * than being a vertex of it. A fan is only valid over a convex ring, which
     * the hull always is; a user-drawn concave ring can still fan wrong, and
     * that is the price of honouring their edges. `DoubleSide` because
     * a plane is viewable from either face; `depthWrite: false` so the
     * translucent fill never occludes skeleton nodes behind it.
     * @private
     */
    _buildPlaneFillMesh(plane, pts) {
        const geo = this._buildPlaneFillGeometry(plane, pts);
        if (!geo) return null;
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
            color: new THREE.Color(plane.color),
            transparent: true,
            opacity: 0.28,
            side: THREE.DoubleSide,
            depthWrite: false,
        }));
        mesh.name = 'planeFill';
        return mesh;
    }

    /**
     * The fan geometry behind `_buildPlaneFillMesh`, without a material.
     *
     * Split out so the 3D Mesh Object membership highlight covers exactly the
     * same triangles as the plane's own fill — one ring-walking rule, so a
     * highlight can never disagree in shape with the surface it highlights.
     * Returns null for fewer than 3 usable corners.
     * @private
     */
    _buildPlaneFillGeometry(plane, pts) {
        const order = (plane.polygonOrder && plane.polygonOrder.length)
            ? plane.polygonOrder
            : null;
        const verts = [];
        const n = points3dNodeCount(pts);
        const walk = order || Array.from({ length: n }, function (_, i) { return i; });
        for (let i = 0; i < walk.length; i++) {
            const pt = getPoint3d(pts, walk[i]);
            if (pt == null) continue;
            if (!isFinite(pt[0]) || !isFinite(pt[1]) || !isFinite(pt[2])) continue;
            verts.push(pt);
        }
        if (verts.length < 3) return null;

        const positions = [];
        for (let t = 1; t < verts.length - 1; t++) {
            positions.push(verts[0][0], verts[0][1], verts[0][2]);
            positions.push(verts[t][0], verts[t][1], verts[t][2]);
            positions.push(verts[t + 1][0], verts[t + 1][1], verts[t + 1][2]);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        return geo;
    }

    // ============================================
    // Set Origin Mode (pick a node, pick a +Z, re-base the frame)
    // ============================================

    /**
     * Resolve a click while Set Origin Mode is armed.
     *
     * In `'node'` mode EVERY node of a FITTED plane is a candidate — every one
     * of them, not just those on the outline: the raycast collects each corner
     * mesh `setPlanes` built, which is one per `plane.nodeIds` entry. A node of
     * an un-fit plane has no +Z to offer, so letting it be picked would dead-end
     * the wizard. The flag comes from `setPlanes`' `planeFitted` userData, which
     * is deliberately independent of `planeEditable`: dragging is off during the
     * wizard, but those same nodes stay pickable.
     * @private
     */
    _handleOriginPick(e) {
        const dom = this.renderer.domElement;
        const rect = dom.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        // Raycasting reads `matrixWorld`, which is only refreshed by `render()`.
        // The arrows are built in response to the PREVIOUS click, so a click
        // arriving before the next frame would raycast against stale (identity)
        // transforms and silently miss.
        if (this.scene) this.scene.updateMatrixWorld();
        this._planeNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._planeNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._planeNdc, this.threeCamera);

        if (this._originPickMode === 'node') {
            const meshes = [];
            this._planeGroup.traverse(function (child) {
                if (child.isMesh && child.userData && child.userData.planeFitted) meshes.push(child);
            });
            if (meshes.length === 0) return;
            const hits = this._raycaster.intersectObjects(meshes, false);
            if (hits.length === 0) return;
            const hit = hits[0].object;
            if (this.onOriginNodePicked) {
                this.onOriginNodePicked(hit.userData.planeId, hit.userData.nodeIdx,
                    [hit.position.x, hit.position.y, hit.position.z]);
            }
            return;
        }

        if (this._originPickMode === 'axis') {
            const meshes = [];
            this._originGroup.traverse(function (child) {
                if (child.isMesh && child.userData && child.userData.originAxis) meshes.push(child);
            });
            if (meshes.length === 0) return;
            const hits = this._raycaster.intersectObjects(meshes, false);
            if (hits.length === 0) return;
            const key = hits[0].object.userData.originAxis;
            if (key && this.onOriginAxisPicked) this.onOriginAxisPicked(key);
        }
    }

    /**
     * Arm 3D picking for Set Origin Mode.
     *
     * @param {'node'|'axis'|null} mode - `'node'` picks a corner of a FITTED
     *   plane (`onOriginNodePicked`), `'axis'` picks one of the two candidate
     *   +Z arrows (`onOriginAxisPicked`), null disarms. While armed, clicks are
     *   consumed here and never reach camera picking — selecting a camera
     *   mid-wizard would yank the view away from what the user is aiming at.
     */
    setOriginPickMode(mode) {
        this._originPickMode = mode || null;
        if (this.renderer) {
            this.renderer.domElement.style.cursor = mode ? 'crosshair' : '';
            this._planeHoverCursor = mode ? 'crosshair' : '';
        }
    }

    /**
     * Draw the two candidate +Z directions as arrows from the chosen origin.
     *
     * Both are always drawn — the choice is between a normal and its negation,
     * and showing only one would hide that there IS a choice. `chosen` dims the
     * loser instead of removing it, so the picked direction reads as a decision
     * rather than as the only option.
     *
     * @param {{origin:number[], normal:number[], length?:number,
     *          chosen?:'positive'|'negative'|null}|null} spec
     *   `length` should be derived from the PLANE's extent by the caller — a
     *   fixed size scaled only by the camera baseline is either invisible on a
     *   room-sized plane or off-screen on a small one.
     */
    setOriginCandidates(spec) {
        this._clearGroup(this._originGroup);
        if (!spec || !spec.origin || !spec.normal) return;

        const n = new THREE.Vector3(spec.normal[0], spec.normal[1], spec.normal[2]);
        if (n.lengthSq() < 1e-18) return;
        n.normalize();

        const ss = this._sceneScale || 1;
        const length = (spec.length > 0) ? spec.length : 110 * ss;
        const radius = Math.max(0.6 * ss, length * 0.02);
        const chosen = spec.chosen || null;

        const build = (dir, key, colorHex) => {
            const dim = chosen != null && chosen !== key;
            const material = new THREE.MeshPhongMaterial({
                color: new THREE.Color(colorHex),
                shininess: 70,
                transparent: true,
                opacity: dim ? 0.22 : 1.0,
                // The chosen arrow must read through the plane fill it starts on.
                depthTest: !dim,
            });
            const arrow = this._createArrowMesh(spec.origin, dir, length, radius, material);
            arrow.name = 'originAxis_' + key;
            arrow.traverse(function (c) {
                c.userData.originAxis = key;
                c.name = c.name || ('originAxisPart_' + key);
            });
            this._originGroup.add(arrow);
        };

        build([n.x, n.y, n.z], 'positive', 0xff4d4d);
        build([-n.x, -n.y, -n.z], 'negative', 0x4d8bff);

        // A marker at the picked corner, so it stays visible under the arrows.
        const dot = new THREE.Mesh(
            new THREE.SphereGeometry(radius * 1.8, 14, 14),
            new THREE.MeshPhongMaterial({ color: new THREE.Color(0xffffff), shininess: 90 }));
        dot.position.set(spec.origin[0], spec.origin[1], spec.origin[2]);
        dot.name = 'originMarker';
        this._originGroup.add(dot);
    }

    /** Remove the Set Origin arrows and marker. */
    clearOriginCandidates() {
        this._clearGroup(this._originGroup);
    }

    /**
     * A shaft + head arrow as pickable MESHES (not `ArrowHelper`, whose Line
     * shaft raycasts against a distance threshold rather than real geometry —
     * unreliable to click).
     * @private
     */
    _createArrowMesh(origin, dir, length, radius, material) {
        const group = new THREE.Group();
        const headLen = length * 0.26;
        const shaftLen = Math.max(1e-6, length - headLen);

        const shaft = new THREE.Mesh(
            new THREE.CylinderGeometry(radius, radius, shaftLen, 12), material);
        shaft.position.y = shaftLen / 2;
        group.add(shaft);

        const head = new THREE.Mesh(
            new THREE.ConeGeometry(radius * 2.4, headLen, 14), material);
        head.position.y = shaftLen + headLen / 2;
        group.add(head);

        // Built along +Y (the geometry default), then rotated onto `dir`.
        const d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
        group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
        group.position.set(origin[0], origin[1], origin[2]);
        return group;
    }

    /**
     * Re-base the DISPLAYED frame: move the grid floor and axis helper onto the
     * user's origin and orientation.
     *
     * Only the frame and the ORBIT move. Cameras, skeletons and planes stay
     * exactly where the calibration puts them, because re-baking them would
     * silently change every 3D coordinate the rest of the app reads and reports
     * — and the transform, not a rewritten point cloud, is the deliverable here.
     * The visual result is the same either way: the grid now lies on the
     * annotated plane with +Z pointing the chosen way.
     *
     * The orbit follows because interaction is part of the display: dragging
     * and zooming re-center on the new origin (`_rebaseControls`), or the scene
     * would swing about a calibration origin that is no longer drawn anywhere.
     * That moves the camera, never the data.
     *
     * @param {{origin:number[], xAxis:number[], yAxis:number[], zAxis:number[]}|null}
     *   frame - from `buildOriginFrame`; null restores the calibration frame.
     */
    setOriginFrame(frame) {
        if (!this._framePivot) return;
        if (!frame) {
            this._framePivot.position.set(0, 0, 0);
            this._framePivot.quaternion.identity();
            this._originFrame = null;
            // Symmetric with applying one: the orbit goes back to the
            // calibration origin and world +Z, or Reset would leave the user
            // pivoting on an origin the display no longer shows.
            this._rebaseControls();
            return;
        }
        const x = frame.xAxis, y = frame.yAxis, z = frame.zAxis, o = frame.origin;
        // Basis COLUMNS are the new axes: this maps frame-local coordinates out
        // into world, which is exactly what a parent transform has to do.
        const m = new THREE.Matrix4().makeBasis(
            new THREE.Vector3(x[0], x[1], x[2]),
            new THREE.Vector3(y[0], y[1], y[2]),
            new THREE.Vector3(z[0], z[1], z[2]));
        this._framePivot.quaternion.setFromRotationMatrix(m);
        this._framePivot.position.set(o[0], o[1], o[2]);
        this._originFrame = frame;
        this._rebaseControls();
    }

    /** Restore the calibration's own frame. */
    clearOriginFrame() {
        this.setOriginFrame(null);
    }

    /**
     * The point every camera interaction pivots on: the user's origin once one
     * is applied, the calibration's until then.
     */
    originPivot() {
        const f = this._originFrame;
        return f ? new THREE.Vector3(f.origin[0], f.origin[1], f.origin[2])
                 : new THREE.Vector3(0, 0, 0);
    }

    /** The axis orbiting spins about: the frame's +Z, else the world's. */
    originUp() {
        const f = this._originFrame;
        return f ? new THREE.Vector3(f.zAxis[0], f.zAxis[1], f.zAxis[2]).normalize()
                 : new THREE.Vector3(0, 0, 1);
    }

    /**
     * A direction stated in FRAME coordinates, rotated out into world ones —
     * so a canned viewing angle ("above and to the side") means the same thing
     * relative to the user's grid as it did relative to the calibration's.
     * @private
     */
    _frameDirection(x, y, z) {
        const v = new THREE.Vector3(x, y, z);
        if (this._framePivot) v.applyQuaternion(this._framePivot.quaternion);
        return v;
    }

    /**
     * Move the ORBIT onto the applied frame: pivot on the user's origin, spin
     * about the user's +Z.
     *
     * Re-basing only the grid leaves the user dragging and zooming around a
     * point that is no longer marked by anything on screen — the whole scene
     * swings about the old calibration origin while the axes sit somewhere
     * else. This is what makes the interaction agree with the display.
     *
     * The camera is translated by the same delta as the target, so the view
     * direction and the distance survive: what is on screen does not jump, only
     * what the next drag or wheel tick keys on. Rebuilding the controls is not
     * optional for the axis — see `_createControls` — but it is skipped when the
     * axis has not actually moved, which is the common case (a re-applied frame,
     * a Reset View) and keeps a rebuild off the hot paths.
     * @private
     */
    _rebaseControls() {
        if (!this.controls || !this.threeCamera) return;
        const target = this.originPivot();
        const up = this.originUp();

        this.threeCamera.position.add(target.clone().sub(this.controls.target));
        this.threeCamera.up.copy(up);
        this.controls.target.copy(target);

        if (this._controlsUp && this._controlsUp.dot(up) > 0.999999) {
            this.controls.update();
            return;
        }
        const old = this.controls;
        const enabled = old.enabled;
        const minDistance = old.minDistance;
        const maxDistance = old.maxDistance;   // re-derived by the next fit
        old.dispose();
        this.controls = this._createControls();
        this.controls.minDistance = minDistance;
        this.controls.maxDistance = maxDistance;
        this.controls.enabled = enabled;
        this.controls.target.copy(target);
        this.controls.update();
    }

    /**
     * Draw the selected 3D Mesh Object's surface, or clear it with `null`.
     *
     * ADDITIVE: a separate group, a separate call, and nothing here touches
     * `_planeGroup`. The per-plane translucent fills stay exactly as they were,
     * so turning an object on shows the welded surface ON TOP of the planes it
     * was built from rather than replacing them.
     *
     * Front and back faces are drawn in DIFFERENT colours on purpose. Winding is
     * the one property of the exported mesh a user cannot otherwise see, and it
     * is the property most likely to be wrong — so "I am looking at the inside"
     * has to be visible in the viewport, not discovered in Blender.
     *
     * @param {{color:string, vertices:Float64Array, triangles:Uint32Array,
     *          faces:number[][]}|null} payload
     */
    /**
     * Show a ghost of where a plane would land.
     *
     * ADDITIVE: its own group, its own pair of calls, and nothing here touches
     * `_planeGroup`. Geometry comes from the caller (the PLANNED points, which
     * have not been written to any node), while the plane's edge list, polygon
     * order and colour are read back out of the last `setPlanes` payload — so
     * the ghost is drawn exactly like the real plane and there is no second
     * copy of that payload shape to keep in step.
     *
     * `depthTest: false` on purpose. The ghost overlaps the solid plane it is
     * proposing to replace, and the useful thing to see is the DIFFERENCE
     * between the two; a depth-tested ghost is hidden by the very plane it is
     * about to move. That is the same reasoning as the dimmed, non-depth-tested
     * unchosen arrow in the origin picker.
     *
     * @param {{planeId:*, points3d:Float64Array, color?:string}} spec
     */
    setAnglePreview(spec) {
        this._clearGroup(this._angleGroup);
        if (!spec || !spec.points3d) return;
        const nNodes = points3dNodeCount(spec.points3d);
        if (nNodes === 0) return;

        // The real plane's payload, for its edges / ring / colour.
        let src = null;
        for (let i = 0; i < this._planes.length; i++) {
            if (this._planes[i] && this._planes[i].id === spec.planeId) { src = this._planes[i]; break; }
        }

        const ss = this._sceneScale || 1;
        const color = new THREE.Color(spec.color || (src && src.color) || '#ffffff');
        const pts = spec.points3d;

        const ghostMat = new THREE.MeshBasicMaterial({
            color: color,
            transparent: true,
            opacity: 0.5,
            depthWrite: false,
            depthTest: false,
        });

        // Corners, as small markers so a plane with no edges still reads.
        const dotGeo = new THREE.SphereGeometry(this.planeNodeSize * 0.7 * ss, 8, 8);
        for (let k = 0; k < nNodes; k++) {
            const pt = getPoint3d(pts, k);
            if (pt == null || !isFinite(pt[0]) || !isFinite(pt[1]) || !isFinite(pt[2])) continue;
            const dot = new THREE.Mesh(dotGeo, ghostMat);
            dot.position.set(pt[0], pt[1], pt[2]);
            dot.name = 'anglePreviewNode_' + k;
            dot.renderOrder = 10;
            this._angleGroup.add(dot);
        }

        // Edges, in the plane's own edge list where it has one.
        const edges = (src && src.edges) || [];
        const edgeRadius = this.skeletonEdgeWeight * 0.9 * ss;
        for (let e = 0; e < edges.length; e++) {
            const a = getPoint3d(pts, edges[e][0]);
            const b = getPoint3d(pts, edges[e][1]);
            if (a == null || b == null) continue;
            if (!isFinite(a[0]) || !isFinite(b[0])) continue;
            const cyl = this._createCylinder(a, b, edgeRadius, ghostMat, 6);
            cyl.name = 'anglePreviewEdge_' + edges[e][0] + '_' + edges[e][1];
            cyl.renderOrder = 10;
            this._angleGroup.add(cyl);
        }

        // Fill, reusing the real builder so a concave ring is ordered the same
        // way it is for the solid plane; only the material differs.
        if (src) {
            const fill = this._buildPlaneFillMesh(
                { polygonOrder: src.polygonOrder, color: spec.color || src.color }, pts);
            if (fill) {
                fill.material.opacity = 0.22;
                fill.material.depthTest = false;
                fill.name = 'anglePreviewFill';
                fill.renderOrder = 9;
                this._angleGroup.add(fill);
            }
        }
    }

    /** Remove the ghost. Safe to call when there is none. */
    clearAnglePreview() {
        this._clearGroup(this._angleGroup);
    }

    /**
     * Outline planes to show the ROLE each is playing, or clear with `null`.
     *
     * The Set Angle dialog names two planes in dropdowns; this is what says
     * WHICH TWO in the scene, and which of them is being held. A user with five
     * annotated planes cannot otherwise tell "back wall" from "front wall" in
     * the viewport, and picking the wrong one is silent until the box bends.
     *
     * ADDITIVE, like the ghost: its own group, and nothing here touches
     * `_planeGroup`, so the real planes keep their own colours and the outline
     * reads as annotation rather than as a recolour. Geometry comes from the
     * last `setPlanes` payload, so a role outline is always drawn on the plane
     * as it currently is — the ghost is the one that shows the proposal.
     *
     * `depthTest: false` for the same reason the ghost uses it: an outline
     * hidden behind the plane it outlines conveys nothing. It renders BELOW the
     * ghost (renderOrder 8 against 9/10), so a proposal is never obscured by
     * the highlight of the plane it proposes to move.
     *
     * @param {{planeId:*, color:string}[]|null} roles
     */
    setPlaneRoles(roles) {
        this._clearGroup(this._planeRoleGroup);
        if (!roles || !roles.length) return;

        const ss = this._sceneScale || 1;
        for (let r = 0; r < roles.length; r++) {
            const role = roles[r];
            if (!role) continue;
            let src = null;
            for (let i = 0; i < this._planes.length; i++) {
                if (this._planes[i] && this._planes[i].id === role.planeId) {
                    src = this._planes[i];
                    break;
                }
            }
            if (!src || !src.points3d) continue;
            const pts = src.points3d;
            const nNodes = points3dNodeCount(pts);
            if (nNodes === 0) continue;

            const mat = new THREE.MeshBasicMaterial({
                color: new THREE.Color(role.color || '#ffffff'),
                transparent: true,
                opacity: 0.85,
                depthWrite: false,
                depthTest: false,
            });

            // Corners first: a plane with no edge list still has to read.
            const dotGeo = new THREE.SphereGeometry(this.planeNodeSize * 1.35 * ss, 10, 10);
            for (let k = 0; k < nNodes; k++) {
                const pt = getPoint3d(pts, k);
                if (pt == null || !isFinite(pt[0]) || !isFinite(pt[1]) || !isFinite(pt[2])) continue;
                const dot = new THREE.Mesh(dotGeo, mat);
                dot.position.set(pt[0], pt[1], pt[2]);
                dot.name = 'planeRoleNode_' + role.planeId + '_' + k;
                dot.renderOrder = 8;
                this._planeRoleGroup.add(dot);
            }

            // A deliberately FAT outline — this is the plane's border seen
            // through everything, not another edge drawn next to the real one.
            const edges = src.edges || [];
            const edgeRadius = this.skeletonEdgeWeight * 2.2 * ss;
            for (let e = 0; e < edges.length; e++) {
                const a = getPoint3d(pts, edges[e][0]);
                const b = getPoint3d(pts, edges[e][1]);
                if (a == null || b == null) continue;
                if (!isFinite(a[0]) || !isFinite(b[0])) continue;
                const cyl = this._createCylinder(a, b, edgeRadius, mat, 6);
                cyl.name = 'planeRoleEdge_' + role.planeId + '_' + e;
                cyl.renderOrder = 8;
                this._planeRoleGroup.add(cyl);
            }
        }
    }

    /** Remove the role outlines. Safe to call when there are none. */
    clearPlaneRoles() {
        this._clearGroup(this._planeRoleGroup);
    }

    /**
     * Light up the planes that belong to the selected 3D Mesh Object.
     *
     * The answer to "which planes did I put in this object?", drawn on the
     * planes themselves: each member's FACE is filled, and its corners and
     * edges redrawn fatter, in one fixed yellow (`MESH_MEMBER_COLOR`). Adding
     * a plane in the panel lights it up here, which is the whole feedback loop
     * the membership editor needs.
     *
     * The face is the load-bearing part. An outline alone left each plane
     * wearing its own colour, so on a five-walled cage the answer to "is this
     * wall a member?" came down to a few corner dots.
     *
     * Why a highlight and not the derived surface: see `_meshMembershipGroup`.
     * The short version is that an object is not a separate body, it IS these
     * planes, and the derived geometry lives in a different coordinate frame
     * than this group is drawn in.
     *
     * Positions come from `this._planes` — the payload the plane drawing
     * itself was built from — so a highlight can never sit anywhere but
     * exactly on top of its plane, whatever happens to the origin frame.
     *
     * Drawn UNDER the Set Angle role outlines (renderOrder 7 against 8) and
     * slightly thinner, so an open angle dialog still reads over a membership
     * highlight covering the same plane.
     *
     * The payload carries NO colour, on purpose: the highlight colour is fixed
     * here (see `MESH_MEMBER_COLOR`) and an unused `color` field would be an
     * invitation to wire the object's own colour back in, which is the thing
     * that made membership hard to see.
     *
     * @param {{planeIds?:Array}|null} payload - null clears.
     */
    setMeshMembership(payload) {
        this._clearGroup(this._meshMembershipGroup);
        if (!payload || !payload.planeIds || !payload.planeIds.length) return;

        const ss = this._sceneScale || 1;
        const color = new THREE.Color(MESH_MEMBER_COLOR);

        // The SURFACE. This is what makes a member read as a member: an
        // outline alone left the plane wearing its own colour, so on a cage of
        // five coloured walls the answer to "is this one in the object?" was a
        // few corner dots. `depthTest` stays ON here, unlike the outline below
        // — a filled face that ignored depth would paint the cage's back walls
        // over its front ones and the shape would stop reading as a shape.
        const faceMat = new THREE.MeshBasicMaterial({
            color: color,
            transparent: true,
            opacity: 0.45,
            side: THREE.DoubleSide,
            depthWrite: false,
        });

        // Corners and outline. `depthTest: false` so an occluded member still
        // announces itself — confirming that the FAR wall is in the object is
        // exactly what this is for, and an outline is thin enough to do that
        // without destroying the sense of depth a filled face would.
        const lineMat = new THREE.MeshBasicMaterial({
            color: color,
            transparent: true,
            opacity: 0.9,
            depthWrite: false,
            depthTest: false,
        });

        const dotGeo = new THREE.SphereGeometry(this.planeNodeSize * 1.15 * ss, 10, 10);
        const edgeRadius = this.skeletonEdgeWeight * 1.6 * ss;

        for (let r = 0; r < payload.planeIds.length; r++) {
            const planeId = payload.planeIds[r];
            let src = null;
            for (let i = 0; i < this._planes.length; i++) {
                if (this._planes[i] && this._planes[i].id === planeId) {
                    src = this._planes[i];
                    break;
                }
            }
            // A member plane that was deleted simply has nothing to light up.
            // Same lazy resolution the model itself uses — no cascade, no throw.
            if (!src || !src.points3d) continue;
            const pts = src.points3d;
            const nNodes = points3dNodeCount(pts);
            if (nNodes === 0) continue;

            // Regardless of the plane's own `filled` flag: what is being shown
            // is membership, not the plane's display setting, and a member the
            // user had left unfilled still has to look like a member.
            const faceGeo = this._buildPlaneFillGeometry(src, pts);
            if (faceGeo) {
                const face = new THREE.Mesh(faceGeo, faceMat);
                face.name = 'meshMemberFace_' + planeId;
                // Above the plane's own fill (renderOrder 0), which is drawn in
                // the plane's colour on the very same triangles.
                face.renderOrder = 7;
                this._meshMembershipGroup.add(face);
            }

            for (let k = 0; k < nNodes; k++) {
                const pt = getPoint3d(pts, k);
                if (pt == null || !isFinite(pt[0]) || !isFinite(pt[1]) || !isFinite(pt[2])) continue;
                const dot = new THREE.Mesh(dotGeo, lineMat);
                dot.position.set(pt[0], pt[1], pt[2]);
                dot.name = 'meshMemberNode_' + planeId + '_' + k;
                dot.renderOrder = 7;
                this._meshMembershipGroup.add(dot);
            }

            const edges = src.edges || [];
            for (let e = 0; e < edges.length; e++) {
                const a = getPoint3d(pts, edges[e][0]);
                const b = getPoint3d(pts, edges[e][1]);
                if (a == null || b == null) continue;
                if (!isFinite(a[0]) || !isFinite(b[0])) continue;
                const cyl = this._createCylinder(a, b, edgeRadius, lineMat, 6);
                cyl.name = 'meshMemberEdge_' + planeId + '_' + e;
                cyl.renderOrder = 7;
                this._meshMembershipGroup.add(cyl);
            }
        }
    }

    /** Remove the membership highlighting. Safe to call when there is none. */
    clearMeshMembership() {
        this._clearGroup(this._meshMembershipGroup);
    }

    /**
     * Mark the plane node selected in the Nodes table, or clear the mark.
     *
     * The answer to "which corner is the row I am looking at?", drawn on the
     * corner itself: three white rings around it, in the three coordinate
     * planes. ONE marker, even for a node several planes share — a pool node
     * has one position, which is what a shared corner IS, and a second marker
     * on top of the first would only z-fight with it.
     *
     * RINGS, and their middle is EMPTY. A corner is about a dozen pixels
     * across at a normal zoom, so anything solid drawn over it — a ball, or a
     * wireframe sphere, whose lines close up into one at that size — hides the
     * node's own colour, which is how the user knows they landed on the right
     * one. A ring is read from its outline and leaves the middle alone.
     *
     * Three of them, at right angles, rather than one facing the camera. One
     * ring would have to be re-aimed on every orbit — per-frame work, in a
     * class this viewport otherwise keeps free of it — and a ring seen edge-on
     * is a line. Three cannot all be edge-on at once, so the marker reads as a
     * ring from every direction the user can orbit to.
     *
     * A POOL NODE ID crosses this boundary, not a position. The viewport
     * resolves it against the plane payload it was just handed (`nodeIds`,
     * parallel to `nodeColors`), so the cage is built from the very numbers the
     * corner was drawn from and cannot land anywhere else — the same rule
     * `setMeshMembership` follows, and for the same reason: a position computed
     * anywhere else may be in the user's ORIGIN frame, while this group hangs
     * off `scene` and is drawn in CALIBRATION world.
     *
     * A node in no plane, or one with no 3D yet, simply has nothing on screen
     * to mark and is left alone. That is not a failure: the 3D view draws
     * planes, so a node no plane references is not in it.
     *
     * `depthTest: false`, like the membership outline: a corner behind a filled
     * wall is exactly the one worth finding, and a wireframe is open enough to
     * say so without flattening the scene. Drawn UNDER the Set Angle role
     * outlines (renderOrder 7 against 8).
     *
     * @param {{nodeId:number}|null} payload - null clears.
     */
    setSelectedPlaneNode(payload) {
        this._clearGroup(this._nodeSelectGroup);
        if (!payload || payload.nodeId == null) return;

        const found = this._findPlaneNodePoint(payload.nodeId);
        if (!found) return;

        const ss = this._sceneScale || 1;
        const r = this.planeNodeSize * 2.6 * ss;
        const geo = new THREE.TorusGeometry(r, r * 0.09, 6, 40);
        const mat = new THREE.MeshBasicMaterial({
            color: new THREE.Color(NODE_SELECT_COLOR),
            transparent: true,
            opacity: 0.95,
            depthWrite: false,
            depthTest: false,
        });
        // A torus is built in the XY plane, so two of the three are rotated a
        // quarter turn onto the other two axes.
        const spins = [[0, 0, 0], [Math.PI / 2, 0, 0], [0, Math.PI / 2, 0]];
        const marker = new THREE.Group();
        for (let i = 0; i < spins.length; i++) {
            const ring = new THREE.Mesh(geo, mat);
            ring.rotation.set(spins[i][0], spins[i][1], spins[i][2]);
            ring.renderOrder = 7;
            marker.add(ring);
        }
        marker.position.set(found.pt[0], found.pt[1], found.pt[2]);
        // The plane it was found through is in the name for debugging only —
        // the position is the node's, whichever plane draws it.
        marker.name = 'planeNodeSelected_' + found.planeId + '_' + found.k;
        this._nodeSelectGroup.add(marker);
    }

    /**
     * Where the plane payload draws a given POOL node, or null if nothing does.
     *
     * The first plane that carries the id wins, and there is nothing to choose
     * between them: every plane referencing a node draws it at that node's one
     * position, which is what a shared corner IS.
     *
     * @param {number} nodeId
     * @returns {{planeId:number, k:number, pt:number[]}|null}
     * @private
     */
    _findPlaneNodePoint(nodeId) {
        for (let i = 0; i < this._planes.length; i++) {
            const src = this._planes[i];
            if (!src || !src.nodeIds || !src.points3d) continue;
            for (let k = 0; k < src.nodeIds.length; k++) {
                if (src.nodeIds[k] !== nodeId) continue;
                const pt = getPoint3d(src.points3d, k);
                if (pt == null) continue;
                if (!isFinite(pt[0]) || !isFinite(pt[1]) || !isFinite(pt[2])) continue;
                return { planeId: src.id, k: k, pt: pt };
            }
        }
        return null;
    }

    /** Remove the node marker. Safe to call when there is none. */
    clearSelectedPlaneNode() {
        this._clearGroup(this._nodeSelectGroup);
    }

    /**
     * Remove every annotated plane from the 3D scene.
     */
    clearPlanes() {
        this._clearGroup(this._planeGroup);
        // The ghost is a proposal about a plane that no longer exists here, so
        // it must go with it rather than hang in the scene. Same for the role
        // outlines, which name planes by id.
        this._clearGroup(this._angleGroup);
        this._clearGroup(this._planeRoleGroup);
        // The marker names a node by id and is resolved through `_planes`, which
        // is about to be empty — so it has nothing left to sit on.
        this._clearGroup(this._nodeSelectGroup);
        this._planes = [];
        this._planeDrag = null;
    }

    /**
     * Create a cylinder mesh connecting two 3D points.
     *
     * @param {number[]} start - [x, y, z] start point
     * @param {number[]} end - [x, y, z] end point
     * @param {number} radius - Cylinder radius in mm
     * @param {THREE.Material} material - Material to use
     * @param {number} [segments=6] - Radial segments
     * @returns {THREE.Mesh}
     * @private
     */
    _createCylinder(start, end, radius, material, segments) {
        segments = segments || 6;

        const dx = end[0] - start[0];
        const dy = end[1] - start[1];
        const dz = end[2] - start[2];
        const length = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (length < 1e-6) {
            // Degenerate edge: return an invisible mesh
            const geo = new THREE.CylinderGeometry(radius, radius, 0.001, segments);
            return new THREE.Mesh(geo, material);
        }

        const geometry = new THREE.CylinderGeometry(radius, radius, length, segments);

        // CylinderGeometry is aligned along Y by default. We need to orient it
        // along the direction from start to end.
        const midpoint = [
            (start[0] + end[0]) / 2,
            (start[1] + end[1]) / 2,
            (start[2] + end[2]) / 2,
        ];

        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(midpoint[0], midpoint[1], midpoint[2]);

        // Compute quaternion to rotate from Y-axis to the edge direction
        const direction = new THREE.Vector3(dx / length, dy / length, dz / length);
        const yAxis = new THREE.Vector3(0, 1, 0);
        const quaternion = new THREE.Quaternion();
        quaternion.setFromUnitVectors(yAxis, direction);
        mesh.quaternion.copy(quaternion);

        return mesh;
    }

    // ============================================
    // Scene Management
    // ============================================

    /**
     * Update the 3D display for a new frame.
     *
     * @param {InstanceGroup[]} instanceGroups - InstanceGroup objects for the
     *        current frame, each with .points3d and .trackIdx.
     */
    setFrame(instanceGroups) {
        this._whenVisible('frame', () => this.updateSkeleton(instanceGroups));
    }

    /**
     * Set the selected (highlighted) instance index.
     * Pass null to clear selection.
     *
     * @param {number|null} idx - Index into the instanceGroups array
     * @param {InstanceGroup[]} [instanceGroups] - If provided, re-renders skeletons
     */
    setSelectedInstance(idx, instanceGroups) {
        // The index itself is plain bookkeeping and always applies — only the
        // rebuild that renders the highlight is deferrable.
        this.selectedInstanceIdx = idx;
        if (instanceGroups) {
            this._whenVisible('frame', () => this.updateSkeleton(instanceGroups));
        }
    }

    /**
     * Highlight a camera by name in the 3D viewport.
     * Pass null to clear all highlights.
     * @param {string|null} cameraName
     */
    /**
     * Set which camera names have no associated video. These are rendered in red.
     * @param {Set<string>|Array<string>} names
     */
    setMissingVideoCameras(names) {
        this._missingVideoCameras = new Set(names);
        this.highlightCamera(this.selectedCamera);
    }

    highlightCamera(cameraName) {
        if (!this._cameraGroup) return;
        // Hidden: defer. Reads back the meshes `addCameraPyramids` builds, so
        // `DEFER_REPLAY_ORDER` runs 'cameras' before this on re-show.
        if (!this._visible) {
            this._deferred.set('highlight', () => this.highlightCamera(cameraName));
            return;
        }
        var missingSet = this._missingVideoCameras || new Set();
        this._cameraGroup.traverse(function (child) {
            if (child.material && child.material.visible !== false) {
                var name = child.name || '';
                var isUpLine = name.startsWith('camUp_');

                // Determine which camera this object belongs to
                var objCamName = null;
                var prefixes = ['camera_', 'cameraBase_', 'label_', 'camSphere_', 'camUp_'];
                for (var pi = 0; pi < prefixes.length; pi++) {
                    if (name.startsWith(prefixes[pi])) {
                        objCamName = name.substring(prefixes[pi].length);
                        break;
                    }
                }

                var isSelected = cameraName && objCamName === cameraName;
                var isMissing = objCamName && missingSet.has(objCamName);

                if (isSelected) {
                    // Selected: green
                    child.material.color.set(isUpLine ? 0x66ffaa : 0x4caf50);
                    child.material.opacity = 1.0;
                } else if (isMissing) {
                    // Missing video: red
                    child.material.color.set(isUpLine ? 0xff6666 : 0xef5350);
                    child.material.opacity = 0.85;
                } else if (isUpLine) {
                    child.material.color.set(0x4488ff);
                    child.material.opacity = 0.9;
                } else {
                    // Default yellow
                    child.material.color.set(0xffdd44);
                    child.material.opacity = name.startsWith('camSphere_') ? 0.8 : 0.7;
                }
            }
        });
    }

    /**
     * Handle container resize. Updates renderer and camera aspect ratio.
     */
    resize() {
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;
        if (width === 0 || height === 0) return;

        this.threeCamera.aspect = width / height;

        // Recompute FOV to keep pyramid base fitted when in camera view
        if (this._viewingCamera && this._viewingCamData) {
            var cam = this._viewingCamData;
            if (cam.matrix && cam.size) {
                var fy = cam.matrix[1][1];
                var cameraFovY = 2 * Math.atan(cam.size[1] / (2 * fy));
                var cameraAspect = cam.size[0] / cam.size[1];
                var viewerAspect = width / height;
                var fovH = cameraFovY;
                var fovW = 2 * Math.atan(Math.tan(cameraFovY / 2) * cameraAspect / viewerAspect);
                this.threeCamera.fov = Math.max(fovH, fovW) * (180 / Math.PI);
            }
        }

        this.threeCamera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    /**
     * Reset orbit controls to the default viewing position.
     * Positions the camera to see all camera pyramids and the skeleton.
     */
    resetCamera() {
        // Relative to the DISPLAYED frame: with a user origin applied, "the
        // default view" means the same angle onto their grid, not onto the
        // calibration's.
        const o = this.originPivot();
        const off = this._frameDirection(500, -500, 400);
        this.threeCamera.position.set(o.x + off.x, o.y + off.y, o.z + off.z);
        this.controls.target.copy(o);
        this._rebaseControls();
    }

    /**
     * Center the orbit controls target on the displayed origin.
     */
    lookAtOrigin() {
        this.controls.target.copy(this.originPivot());
        this.controls.update();
    }

    /**
     * Automatically fit the camera to see all camera positions and skeleton points.
     * Computes a bounding sphere encompassing all visible objects and positions
     * the Three.js camera accordingly.
     */
    fitToScene() {
        // Hidden: defer. Measures the skeleton meshes `setFrame` builds, so
        // `DEFER_REPLAY_ORDER` runs 'frame' before this on re-show. Deferring
        // also means the fit uses the real container aspect rather than the
        // stale one left over from the collapse.
        if (!this._visible) {
            this._deferred.set('fit', () => this.fitToScene());
            return;
        }

        const points = [];

        // Collect camera world positions
        for (let i = 0; i < this.cameras.length; i++) {
            const cam = this.cameras[i];
            const R = cam.rotationMatrix;
            const t = cam.tvec;
            const pos = this._computeCameraPosition(R, t);
            points.push(pos);
        }

        // Collect skeleton points from current frame. Node markers may be a
        // Mesh (circle/square/triangle) or a Group of bars ('x'); both are
        // named 'node_*'. Skip any with non-finite coords defensively.
        if (this._skeletonGroup) {
            this._skeletonGroup.traverse(function (child) {
                if (child.name && child.name.indexOf('node_') === 0 &&
                    (child.isMesh || child.isGroup || child.isObject3D)) {
                    var p = child.position;
                    if (isFinite(p.x) && isFinite(p.y) && isFinite(p.z)) {
                        points.push([p.x, p.y, p.z]);
                    }
                }
            });
        }

        // Annotated planes (View ▸ Define Planes) count too — they are the
        // reference geometry the mode exists to create, so "Fit 3D to Scene"
        // must frame them. `_planeGroup` is only ever non-empty once a plane
        // has been triangulated, so this cannot change framing for a project
        // that has no planes. The `planeNode_` prefix deliberately does not
        // match the `node_` test above, so nothing is counted twice.
        if (this._planeGroup) {
            this._planeGroup.traverse(function (child) {
                if (child.name && child.name.indexOf('planeNode_') === 0) {
                    var p = child.position;
                    if (isFinite(p.x) && isFinite(p.y) && isFinite(p.z)) {
                        points.push([p.x, p.y, p.z]);
                    }
                }
            });
        }

        // Add the DISPLAYED origin — the user's once Set Origin has applied one,
        // the calibration's until then. It is what orbit and zoom key on, so the
        // framing has to account for it.
        const pivot = this.originPivot();
        points.push([pivot.x, pivot.y, pivot.z]);

        if (points.length === 0) return;

        // Compute bounding sphere center and radius
        let cx = 0, cy = 0, cz = 0;
        for (let i = 0; i < points.length; i++) {
            cx += points[i][0];
            cy += points[i][1];
            cz += points[i][2];
        }
        cx /= points.length;
        cy /= points.length;
        cz /= points.length;

        // With a user origin applied, fit AROUND that origin rather than around
        // the point cloud's centroid. The two are different points, and framing
        // one while orbiting the other is what makes the first drag after a fit
        // swing the scene about something off-centre. The radius below is
        // measured from the same point, so nothing leaves the frame — the view
        // just sits a little further back when the origin is off to one side.
        if (this._originFrame) {
            cx = pivot.x;
            cy = pivot.y;
            cz = pivot.z;
        }

        let maxDist = 0;
        for (let i = 0; i < points.length; i++) {
            const dx = points[i][0] - cx;
            const dy = points[i][1] - cy;
            const dz = points[i][2] - cz;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist > maxDist) maxDist = dist;
        }

        // Position camera to see the bounding sphere
        const fov = this.threeCamera.fov * Math.PI / 180;
        const cameraDistance = (maxDist / Math.sin(fov / 2)) * 1.2; // 20% margin

        console.log('[3D] fitToScene:', points.length, 'pts, center=[' +
            cx.toFixed(1) + ',' + cy.toFixed(1) + ',' + cz.toFixed(1) +
            '], radius=' + maxDist.toFixed(1) + ', camDist=' + cameraDistance.toFixed(1));

        // Dynamically update clipping planes based on scene scale
        this.threeCamera.near = Math.max(0.1, cameraDistance * 0.001);
        this.threeCamera.far = Math.max(5000, cameraDistance * 10);
        this.threeCamera.updateProjectionMatrix();

        // Update orbit controls limits to match scene scale
        this.controls.maxDistance = Math.max(3000, cameraDistance * 5);

        // Rescale axis helper and grid to match scene scale
        if (this._axisHelper) {
            var axisScale = Math.max(1, maxDist * 0.1);
            this._axisHelper.scale.setScalar(axisScale / 50); // 50 was original size
        }

        // Stated in frame coordinates, so the canned angle means the same thing
        // relative to the user's grid as it did relative to the calibration's.
        const direction = this._frameDirection(1, -1, 0.8).normalize();
        this.threeCamera.position.set(
            cx + direction.x * cameraDistance,
            cy + direction.y * cameraDistance,
            cz + direction.z * cameraDistance
        );
        this.controls.target.set(cx, cy, cz);
        // Only when the fit is already centred on the frame's origin: fitting on
        // a centroid deliberately keeps that centroid as the pivot, and moving
        // the target away from what was just framed would undo the fit.
        if (this._originFrame) this._rebaseControls();
        else this.controls.update();
    }

    /**
     * Clean up all Three.js resources: renderer, scene, controls, resize observer.
     * Call this when removing the viewport from the DOM.
     */
    dispose() {
        this._disposed = true;

        // Drop deferred rebuilds — their thunks close over instance-group
        // arrays, and a disposed viewport will never replay them.
        if (this._deferred) this._deferred.clear();

        // Stop animation loop
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = 0;
        }

        // …and the camera fly-in's independent loop, which calls
        // renderer.render() directly and would throw on the nulled renderer.
        if (this._perspectiveAnimId) {
            cancelAnimationFrame(this._perspectiveAnimId);
            this._perspectiveAnimId = null;
            this._animatingPerspective = false;
        }

        // Stop resize observer
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }

        // Plane-drag listeners. The pointerdown one lives on the CONTAINER,
        // which outlives this viewport — leaving it attached would keep a
        // disposed instance alive and firing.
        if (this._onPlaneDownCapture && this.container) {
            this.container.removeEventListener('pointerdown', this._onPlaneDownCapture, true);
            this._onPlaneDownCapture = null;
        }
        if (this.renderer && this.renderer.domElement) {
            const dom = this.renderer.domElement;
            if (this._onPlaneMoveBound) dom.removeEventListener('pointermove', this._onPlaneMoveBound);
            if (this._onPlaneUpBound) {
                dom.removeEventListener('pointerup', this._onPlaneUpBound);
                dom.removeEventListener('pointercancel', this._onPlaneUpBound);
            }
        }
        this._onPlaneMoveBound = null;
        this._onPlaneUpBound = null;
        this._planeDrag = null;
        this._planes = [];

        // Dispose controls
        if (this.controls) {
            this.controls.dispose();
            this.controls = null;
        }

        // Dispose the pooled skeleton objects (incl. ones not currently attached)
        this._disposeSkeletonPool();

        // Dispose scene objects
        if (this.scene) {
            this._disposeSceneRecursive(this.scene);
            this.scene = null;
        }

        // Dispose renderer and remove canvas
        if (this.renderer) {
            this.renderer.dispose();
            if (this.renderer.domElement && this.renderer.domElement.parentNode) {
                this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
            }
            this.renderer = null;
        }

        this.threeCamera = null;
    }

    // ============================================
    // Render Loop
    // ============================================

    /**
     * Animation loop. Updates controls and renders the scene each frame.
     * @private
     */
    _animate() {
        // A collapsed container is still a perfectly good WebGL render target
        // as far as the GPU is concerned, so "hidden" has to stop the loop
        // explicitly. `_rafId = 0` so `setVisible(true)` knows to restart it.
        if (this._disposed || !this._visible) {
            this._rafId = 0;
            return;
        }

        this._rafId = requestAnimationFrame(() => this._animate());

        // Skip orbit controls update during perspective animation to prevent fighting
        if (this.controls && !this._animatingPerspective) {
            this.controls.update();
        }

        if (this.renderer && this.scene && this.threeCamera) {
            this.renderer.render(this.scene, this.threeCamera);
        }
    }

    // ============================================
    // Helper Methods
    // ============================================

    /**
     * Compute camera world position from rotation matrix and translation vector.
     * camPos = -R^T * t
     *
     * @param {number[][]} R - 3x3 rotation matrix (world-to-camera)
     * @param {number[]} t - 3x1 translation vector
     * @returns {number[]} [x, y, z] camera position in world frame
     * @private
     */
    _computeCameraPosition(R, t) {
        return [
            -(R[0][0] * t[0] + R[1][0] * t[1] + R[2][0] * t[2]),
            -(R[0][1] * t[0] + R[1][1] * t[1] + R[2][1] * t[2]),
            -(R[0][2] * t[0] + R[1][2] * t[1] + R[2][2] * t[2]),
        ];
    }

    /**
     * Multiply R^T by a 3-vector: result = R^T * v
     *
     * @param {number[][]} R - 3x3 matrix
     * @param {number[]} v - 3-element vector
     * @returns {number[]} 3-element result vector
     * @private
     */
    _matTransposeVec(R, v) {
        return [
            R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2],
            R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2],
            R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2],
        ];
    }

    /**
     * Scale a 3-vector by a scalar.
     *
     * @param {number[]} v - 3-element vector
     * @param {number} s - scalar
     * @returns {number[]} scaled vector
     * @private
     */
    _scaleVec3(v, s) {
        return [v[0] * s, v[1] * s, v[2] * s];
    }

    /**
     * Add two or three 3-vectors together.
     *
     * @param {number[]} a - base vector
     * @param {number[]} b - first addend
     * @param {number[]} [c] - optional second addend
     * @returns {number[]} sum vector
     * @private
     */
    _addVec3(a, b, c) {
        if (c) {
            return [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]];
        }
        return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    }

    /**
     * Create a text sprite for camera labels.
     *
     * Renders text onto a canvas, then creates a sprite material from the
     * canvas texture. The sprite always faces the camera (billboard behavior).
     *
     * @param {string} text - Label text
     * @param {Object} [options]
     * @param {number} [options.fontSize=28] - Font size in canvas pixels
     * @param {string} [options.color='#ffffff'] - Text color CSS string
     * @param {string} [options.backgroundColor='rgba(0,0,0,0.5)'] - Background color
     * @returns {THREE.Sprite}
     * @private
     */
    _createTextSprite(text, options) {
        options = options || {};
        const fontSize = options.fontSize || 28;
        const color = options.color || '#ffffff';
        const bgColor = options.backgroundColor || 'rgba(0, 0, 0, 0.5)';

        // Render at high resolution for crisp text, then scale sprite by fontSize
        const renderFontSize = 64;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // Measure text to size the canvas
        ctx.font = 'bold ' + renderFontSize + 'px sans-serif';
        const metrics = ctx.measureText(text);
        const textWidth = metrics.width;

        const padding = Math.round(renderFontSize * 0.3);
        canvas.width = textWidth + padding * 2;
        canvas.height = renderFontSize + padding * 2;

        // Draw background
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Draw text
        ctx.font = 'bold ' + renderFontSize + 'px sans-serif';
        ctx.fillStyle = color;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText(text, canvas.width / 2, canvas.height / 2);

        // Create texture and sprite
        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;

        const spriteMaterial = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: true,
            depthWrite: false,
        });

        const sprite = new THREE.Sprite(spriteMaterial);

        // Scale sprite proportionally to fontSize (28 = baseline)
        const sizeRatio = fontSize / 28;
        const spriteScale = 30 * sizeRatio;
        const aspect = canvas.width / canvas.height;
        sprite.scale.set(spriteScale * aspect, spriteScale, 1);

        return sprite;
    }

    /**
     * Remove all children from a THREE.Group and dispose their resources.
     *
     * @param {THREE.Group} group - Group to clear
     * @private
     */
    _clearGroup(group) {
        if (!group) return;

        while (group.children.length > 0) {
            const child = group.children[0];
            group.remove(child);
            this._disposeObject(child);
        }
    }

    /**
     * Dispose a single Three.js object (geometry, material, texture).
     *
     * @param {THREE.Object3D} obj
     * @private
     */
    _disposeObject(obj) {
        if (obj.geometry) {
            obj.geometry.dispose();
        }
        if (obj.material) {
            if (Array.isArray(obj.material)) {
                obj.material.forEach(function (mat) {
                    if (mat.map) mat.map.dispose();
                    mat.dispose();
                });
            } else {
                if (obj.material.map) obj.material.map.dispose();
                obj.material.dispose();
            }
        }
        // Recurse into children
        if (obj.children) {
            for (let i = obj.children.length - 1; i >= 0; i--) {
                this._disposeObject(obj.children[i]);
            }
        }
    }

    /**
     * Recursively dispose all objects in a scene.
     *
     * @param {THREE.Scene} scene
     * @private
     */
    _disposeSceneRecursive(scene) {
        scene.traverse(function (obj) {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
                if (Array.isArray(obj.material)) {
                    obj.material.forEach(function (mat) {
                        if (mat.map) mat.map.dispose();
                        mat.dispose();
                    });
                } else {
                    if (obj.material.map) obj.material.map.dispose();
                    obj.material.dispose();
                }
            }
        });
    }
}
