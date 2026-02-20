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
 * Depends on pose-data.js for Camera, Skeleton, InstanceGroup classes.
 * Depends on overlays.js for getTrackColor().
 *
 * All functions/classes are vanilla JS globals -- no imports/exports.
 */

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
class Viewport3D {
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

        /** @type {function(string): void|null} Callback when a camera is clicked */
        this.onCameraClicked = options.onCameraClicked || null;

        /** @type {number|null} Index of the currently selected/highlighted instance */
        this.selectedInstanceIdx = null;

        /** @type {THREE.Raycaster} For picking camera objects */
        this._raycaster = null;

        /** @type {number|null} Animation frame timer for perspective animation */
        this._perspectiveAnimId = null;

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

        /** @type {number} Animation frame request ID */
        this._rafId = 0;
        /** @type {boolean} Whether the viewport has been disposed */
        this._disposed = false;

        // Resize observer for container dimension changes
        /** @type {ResizeObserver|null} */
        this._resizeObserver = null;

        this._init();
    }

    // ============================================
    // Initialization
    // ============================================

    /**
     * Initialize Three.js scene, renderer, camera, lights, grid, and controls.
     * @private
     */
    _init() {
        const width = this.container.clientWidth || 400;
        const height = this.container.clientHeight || 300;

        // --- Scene ---
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1a1a1a);

        // --- Renderer ---
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(width, height);
        this.container.appendChild(this.renderer.domElement);

        // --- Camera ---
        this.threeCamera = new THREE.PerspectiveCamera(50, width / height, 1, 5000);
        // Position to see the full scene: cameras are ~300-400mm from origin
        this.threeCamera.position.set(500, -500, 400);
        this.threeCamera.up.set(0, 0, 1); // Z-up world convention

        // --- Orbit Controls ---
        this.controls = new THREE.OrbitControls(this.threeCamera, this.renderer.domElement);
        this.controls.target.set(0, 0, 0);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.1;
        this.controls.screenSpacePanning = true;
        this.controls.minDistance = 10;
        this.controls.maxDistance = 3000;
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

        // --- Grid floor (XY plane at Z=0, matching Z-up convention) ---
        this._addGridFloor();

        // --- Axis helper ---
        const axisHelper = new THREE.AxesHelper(50);
        this.scene.add(axisHelper);

        // --- Scene groups ---
        this._cameraGroup = new THREE.Group();
        this._cameraGroup.name = 'cameras';
        this.scene.add(this._cameraGroup);

        this._skeletonGroup = new THREE.Group();
        this._skeletonGroup.name = 'skeletons';
        this.scene.add(this._skeletonGroup);

        // --- Draw camera pyramids ---
        this.addCameraPyramids();

        // --- Camera picking (click to match perspective) ---
        this._setupCameraPicking();

        // --- Resize handling ---
        this._resizeObserver = new ResizeObserver(() => {
            this.resize();
        });
        this._resizeObserver.observe(this.container);

        // --- Start render loop ---
        this._animate();
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

        this.scene.add(grid);
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
        // Clear any existing camera visualizations
        this._clearGroup(this._cameraGroup);

        const pyramidScale = 20; // mm - half-size of the near plane rectangle
        const pyramidDepth = 40; // mm - distance from camera center to near plane

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

            // Aspect ratio from camera image size
            const aspectRatio = cam.size ? cam.size[0] / cam.size[1] : 4 / 3;
            const halfW = pyramidScale * aspectRatio;
            const halfH = pyramidScale;

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

            // --- Build wireframe geometry ---
            // 4 edges from camera center to each corner + 4 edges around the rectangle
            const positions = [];

            // Edges from apex (camera center) to corners
            for (let c = 0; c < 4; c++) {
                positions.push(camPos[0], camPos[1], camPos[2]);
                positions.push(corners[c][0], corners[c][1], corners[c][2]);
            }

            // Rectangle edges
            for (let c = 0; c < 4; c++) {
                const next = (c + 1) % 4;
                positions.push(corners[c][0], corners[c][1], corners[c][2]);
                positions.push(corners[next][0], corners[next][1], corners[next][2]);
            }

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position',
                new THREE.Float32BufferAttribute(positions, 3));

            const material = new THREE.LineBasicMaterial({
                color: 0xffdd44,
                transparent: true,
                opacity: 0.7,
            });

            const wireframe = new THREE.LineSegments(geometry, material);
            wireframe.name = 'camera_' + cam.name;
            this._cameraGroup.add(wireframe);

            // --- Camera label sprite ---
            const label = this._createTextSprite(cam.name, {
                fontSize: 28,
                color: '#ffdd44',
                backgroundColor: 'rgba(0, 0, 0, 0.5)',
            });
            // Position label slightly above the camera center
            label.position.set(camPos[0], camPos[1], camPos[2] + 15);
            label.name = 'label_' + cam.name;
            this._cameraGroup.add(label);

            // --- Small sphere at camera center for visibility ---
            const sphereGeo = new THREE.SphereGeometry(3, 8, 8);
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
                // Find which camera was hit by checking the object name
                const hitObj = intersects[0].object;
                const camName = this._getCameraNameFromObject(hitObj);
                if (camName) {
                    this.animateToCameraPerspective(camName);
                    if (this.onCameraClicked) {
                        this.onCameraClicked(camName);
                    }
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
        // Objects are named: camera_NAME, label_NAME, camSphere_NAME
        const prefixes = ['camSphere_', 'camera_', 'label_'];
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

        // Compute FOV from intrinsics: fov = 2 * atan(imageHeight / (2 * fy))
        let targetFov = 50; // default
        if (cam.matrix && cam.size) {
            const fy = cam.matrix[1][1];
            const imageH = cam.size[1];
            targetFov = 2 * Math.atan(imageH / (2 * fy)) * (180 / Math.PI);
        }

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

        const self = this;
        function animate() {
            const elapsed = performance.now() - startTime;
            const rawT = Math.min(1, elapsed / duration);
            // Ease in-out (smoothstep)
            const t = rawT * rawT * (3 - 2 * rawT);

            self.threeCamera.position.lerpVectors(startPos, endPos, t);
            self.controls.target.lerpVectors(startTarget, endTarget, t);
            self.threeCamera.up.lerpVectors(startUp, endUp, t).normalize();
            self.threeCamera.fov = startFov + (targetFov - startFov) * t;
            self.threeCamera.updateProjectionMatrix();
            self.controls.update();

            if (rawT < 1) {
                self._perspectiveAnimId = requestAnimationFrame(animate);
            } else {
                self._perspectiveAnimId = null;
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
     *        for the current frame. Each should have .points3d (array of [x,y,z]
     *        or null per node) and .trackIdx.
     */
    updateSkeleton(instanceGroups) {
        this._clearGroup(this._skeletonGroup);

        if (!instanceGroups || instanceGroups.length === 0) {
            return;
        }

        const nodeRadius = 2;        // mm
        const edgeRadius = 0.8;      // mm
        const highlightScale = 1.5;  // scale factor for selected instance
        const sphereSegments = 12;
        const cylinderSegments = 6;

        // Shared geometries (instanced for performance)
        const sphereGeo = new THREE.SphereGeometry(nodeRadius, sphereSegments, sphereSegments);
        const edges = this.skeleton.edges || [];
        const nodes = this.skeleton.nodes || [];

        for (let g = 0; g < instanceGroups.length; g++) {
            const group = instanceGroups[g];
            const pts = group.points3d;
            if (!pts || pts.length === 0) continue;

            const trackIdx = group.trackIdx != null ? group.trackIdx : g;
            const colorStr = this.getTrackColor(trackIdx);
            const color = new THREE.Color(colorStr);
            const isSelected = (this.selectedInstanceIdx === g);

            // Emissive boost for selected instance
            const emissiveIntensity = isSelected ? 0.4 : 0.0;
            const scale = isSelected ? highlightScale : 1.0;

            const nodeMaterial = new THREE.MeshPhongMaterial({
                color: color,
                emissive: isSelected ? color : new THREE.Color(0x000000),
                emissiveIntensity: emissiveIntensity,
                shininess: 60,
            });

            const edgeMaterial = new THREE.MeshPhongMaterial({
                color: color,
                emissive: isSelected ? color : new THREE.Color(0x000000),
                emissiveIntensity: emissiveIntensity * 0.5,
                shininess: 30,
            });

            const instanceGroup3D = new THREE.Group();
            instanceGroup3D.name = 'instance_' + g;

            // --- Draw keypoint spheres ---
            for (let n = 0; n < pts.length; n++) {
                const pt = pts[n];
                if (pt == null) continue;

                const mesh = new THREE.Mesh(sphereGeo, nodeMaterial);
                mesh.position.set(pt[0], pt[1], pt[2]);
                if (scale !== 1.0) {
                    mesh.scale.setScalar(scale);
                }
                mesh.name = 'node_' + (nodes[n] || n);
                instanceGroup3D.add(mesh);
            }

            // --- Draw skeleton edges as cylinders ---
            for (let e = 0; e < edges.length; e++) {
                const srcIdx = edges[e][0];
                const dstIdx = edges[e][1];

                if (srcIdx >= pts.length || dstIdx >= pts.length) continue;
                const srcPt = pts[srcIdx];
                const dstPt = pts[dstIdx];
                if (srcPt == null || dstPt == null) continue;

                const cylinder = this._createCylinder(
                    srcPt, dstPt,
                    edgeRadius * scale,
                    edgeMaterial,
                    cylinderSegments
                );
                cylinder.name = 'edge_' + srcIdx + '_' + dstIdx;
                instanceGroup3D.add(cylinder);
            }

            this._skeletonGroup.add(instanceGroup3D);
        }
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
        this.updateSkeleton(instanceGroups);
    }

    /**
     * Set the selected (highlighted) instance index.
     * Pass null to clear selection.
     *
     * @param {number|null} idx - Index into the instanceGroups array
     * @param {InstanceGroup[]} [instanceGroups] - If provided, re-renders skeletons
     */
    setSelectedInstance(idx, instanceGroups) {
        this.selectedInstanceIdx = idx;
        if (instanceGroups) {
            this.updateSkeleton(instanceGroups);
        }
    }

    /**
     * Handle container resize. Updates renderer and camera aspect ratio.
     */
    resize() {
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;
        if (width === 0 || height === 0) return;

        this.threeCamera.aspect = width / height;
        this.threeCamera.updateProjectionMatrix();
        this.renderer.setSize(width, height);

    }

    /**
     * Reset orbit controls to the default viewing position.
     * Positions the camera to see all camera pyramids and the skeleton.
     */
    resetCamera() {
        this.threeCamera.position.set(500, -500, 400);
        this.threeCamera.up.set(0, 0, 1);
        this.controls.target.set(0, 0, 0);
        this.controls.update();
    }

    /**
     * Center the orbit controls target on the world origin.
     */
    lookAtOrigin() {
        this.controls.target.set(0, 0, 0);
        this.controls.update();
    }

    /**
     * Automatically fit the camera to see all camera positions and skeleton points.
     * Computes a bounding sphere encompassing all visible objects and positions
     * the Three.js camera accordingly.
     */
    fitToScene() {
        const points = [];

        // Collect camera world positions
        for (let i = 0; i < this.cameras.length; i++) {
            const cam = this.cameras[i];
            const R = cam.rotationMatrix;
            const t = cam.tvec;
            const pos = this._computeCameraPosition(R, t);
            points.push(pos);
        }

        // Collect skeleton points from current frame
        if (this._skeletonGroup) {
            this._skeletonGroup.traverse(function (child) {
                if (child.isMesh && child.name.startsWith('node_')) {
                    points.push([child.position.x, child.position.y, child.position.z]);
                }
            });
        }

        // Add origin
        points.push([0, 0, 0]);

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

        const direction = new THREE.Vector3(1, -1, 0.8).normalize();
        this.threeCamera.position.set(
            cx + direction.x * cameraDistance,
            cy + direction.y * cameraDistance,
            cz + direction.z * cameraDistance
        );
        this.controls.target.set(cx, cy, cz);
        this.controls.update();
    }

    /**
     * Clean up all Three.js resources: renderer, scene, controls, resize observer.
     * Call this when removing the viewport from the DOM.
     */
    dispose() {
        this._disposed = true;

        // Stop animation loop
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = 0;
        }

        // Stop resize observer
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }

        // Dispose controls
        if (this.controls) {
            this.controls.dispose();
            this.controls = null;
        }

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
        if (this._disposed) return;

        this._rafId = requestAnimationFrame(() => this._animate());

        if (this.controls) {
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

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // Measure text to size the canvas
        ctx.font = 'bold ' + fontSize + 'px sans-serif';
        const metrics = ctx.measureText(text);
        const textWidth = metrics.width;

        const padding = 8;
        canvas.width = textWidth + padding * 2;
        canvas.height = fontSize + padding * 2;

        // Draw background
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Draw text
        ctx.font = 'bold ' + fontSize + 'px sans-serif';
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

        // Scale sprite so it appears at a reasonable world-space size
        // We want the label to be roughly 30mm wide
        const spriteScale = 30;
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
