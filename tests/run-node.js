// Node.js test runner - uses vm module to simulate browser global scope
var vm = require('vm');
var fs = require('fs');
var path = require('path');

function mockCtx() {
    var mockCanvas = {
        width: 640, height: 480,
        getBoundingClientRect: function() { return {left:0,top:0,width:640,height:480,right:640,bottom:480}; },
        getContext: function() { return mockCtx(); },
        parentNode: null,
        style: {},
    };
    return new Proxy({canvas: mockCanvas}, { get: function(t, p) {
        if (p === 'canvas') return mockCanvas;
        if (p === 'measureText') return function() { return { width: 10, actualBoundingBoxAscent: 5, actualBoundingBoxDescent: 2 }; };
        if (p in t) return t[p];
        return function() { return mockCtx(); };
    }});
}

// Build the sandbox with DOM stubs
var sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    Promise: Promise,
    Map: Map,
    Set: Set,
    Array: Array,
    Object: Object,
    Math: Math,
    JSON: JSON,
    Error: Error,
    TypeError: TypeError,
    RangeError: RangeError,
    parseInt: parseInt,
    parseFloat: parseFloat,
    isNaN: isNaN,
    isFinite: isFinite,
    NaN: NaN,
    Infinity: Infinity,
    undefined: undefined,
    Proxy: Proxy,
    Symbol: Symbol,
    WeakMap: WeakMap,
    WeakSet: WeakSet,
    Uint8Array: Uint8Array,
    Float32Array: Float32Array,
    Float64Array: Float64Array,
    Int32Array: Int32Array,
    Uint16Array: Uint16Array,
    ArrayBuffer: ArrayBuffer,
    DataView: DataView,
    RegExp: RegExp,
    Date: Date,
    Number: Number,
    String: String,
    Boolean: Boolean,
    document: {
        createElement: function(tag) {
            // Lazy classList stub backed by `className`. Provides add /
            // remove / toggle / contains semantics close enough for tests
            // that flip the .collapsed class on an element.
            function makeClassList(host) {
                return {
                    contains: function(cls) {
                        var s = ' ' + (host.className || '') + ' ';
                        return s.indexOf(' ' + cls + ' ') >= 0;
                    },
                    add: function(cls) {
                        if (this.contains(cls)) return;
                        host.className = ((host.className || '') + ' ' + cls).trim();
                    },
                    remove: function(cls) {
                        var parts = (host.className || '').split(/\s+/).filter(function(p){
                            return p && p !== cls;
                        });
                        host.className = parts.join(' ');
                    },
                    toggle: function(cls, force) {
                        var has = this.contains(cls);
                        if (force === true) { if (!has) this.add(cls); return true; }
                        if (force === false) { if (has) this.remove(cls); return false; }
                        if (has) { this.remove(cls); return false; }
                        this.add(cls); return true;
                    },
                };
            }
            var el = {
                className: '', textContent: '', innerHTML: '', tagName: tag.toUpperCase(),
                appendChild: function(c) {
                    c.parentNode = el;
                    c.parentElement = el;
                    if (el.children.indexOf(c) === -1) el.children.push(c);
                    if (el.childNodes.indexOf(c) === -1) el.childNodes.push(c);
                    return c;
                },
                removeChild: function(c) {
                    var idx = el.children.indexOf(c);
                    if (idx >= 0) el.children.splice(idx, 1);
                    idx = el.childNodes.indexOf(c);
                    if (idx >= 0) el.childNodes.splice(idx, 1);
                    c.parentNode = null;
                    c.parentElement = null;
                    return c;
                },
                style: {},
                setAttribute: function(k, v) {
                    if (!this._attrs) this._attrs = {};
                    this._attrs[k] = String(v);
                },
                getAttribute: function(k) {
                    if (!this._attrs) return null;
                    return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
                },
                // Element-level event dispatch — used by the
                // Ctrl/Cmd+Shift+J → dblclick test (T12).
                addEventListener: function(type, fn) {
                    if (!this._listeners) this._listeners = {};
                    if (!this._listeners[type]) this._listeners[type] = [];
                    this._listeners[type].push(fn);
                },
                removeEventListener: function(type, fn) {
                    if (!this._listeners || !this._listeners[type]) return;
                    var idx = this._listeners[type].indexOf(fn);
                    if (idx >= 0) this._listeners[type].splice(idx, 1);
                },
                getBoundingClientRect: function() {
                    var h = parseFloat(el.style && el.style.height);
                    var w = parseFloat(el.style && el.style.width);
                    if (isNaN(h)) h = 480;
                    if (isNaN(w)) w = 640;
                    return {left:0,top:0,width:w,height:h,right:w,bottom:h};
                },
                getContext: function() { return mockCtx(); },
                children: [],
                childNodes: [],
                parentNode: null,
                querySelectorAll: function(sel) {
                    var results = [];
                    // Support `.className` selectors (single class). Tag
                    // selectors (e.g., `div`) and attribute selectors
                    // (`[data-foo="x"]`) keep their previous behavior;
                    // unsupported selectors return [].
                    var classMatch = sel.match(/^\.([\w-]+)$/);
                    var tagMatch = sel.match(/^([a-zA-Z]+)$/);
                    function visit(node) {
                        for (var i = 0; i < node.children.length; i++) {
                            var child = node.children[i];
                            if (classMatch) {
                                var cls = (child.className || '').toString();
                                if ((' ' + cls + ' ').indexOf(' ' + classMatch[1] + ' ') >= 0) {
                                    results.push(child);
                                }
                            } else if (tagMatch && child.tagName === tagMatch[1].toUpperCase()) {
                                results.push(child);
                            }
                            if (child.children && child.children.length) visit(child);
                        }
                    }
                    visit(el);
                    return results;
                },
                querySelector: function(sel) {
                    var all = el.querySelectorAll(sel);
                    return all.length > 0 ? all[0] : null;
                },
                dispatchEvent: function(ev) {
                    if (!ev || !ev.type) return true;
                    var arr = (this._listeners && this._listeners[ev.type]) || [];
                    for (var i = 0; i < arr.length; i++) {
                        try { arr[i].call(this, ev); } catch (err) { console.error(err); }
                    }
                    return true;
                },
                // `.click()` fires registered 'click' listeners. Used by
                // tests that simulate user clicks programmatically.
                click: function() {
                    var arr = (this._listeners && this._listeners.click) || [];
                    var ev = { type: 'click', target: this, preventDefault: function(){}, stopPropagation: function(){} };
                    for (var i = 0; i < arr.length; i++) {
                        try { arr[i].call(this, ev); } catch (err) { console.error(err); }
                    }
                },
                remove: function() {
                    if (el.parentNode) el.parentNode.removeChild(el);
                },
                closest: function() { return null; },
                width: 640,
                height: 480,
                offsetWidth: 640,
                offsetHeight: 480,
                parentElement: null,
                parentNode: null,
            };
            el.classList = makeClassList(el);
            // scrollHeight/clientHeight stubs for Block 1 timeline-scroll
            // tests: scrollHeight is the max of children's natural heights
            // (we approximate via child canvas.height / style.height);
            // clientHeight is the element's own visible height (style.height
            // if set, else fall back to the bounding rect height).
            Object.defineProperty(el, 'clientHeight', {
                configurable: true,
                get: function () {
                    var h = parseFloat(el.style && el.style.height);
                    if (!isNaN(h) && h > 0) return h;
                    var rect = el.getBoundingClientRect();
                    return rect ? rect.height : 0;
                }
            });
            Object.defineProperty(el, 'clientWidth', {
                configurable: true,
                get: function () {
                    var w = parseFloat(el.style && el.style.width);
                    if (!isNaN(w) && w > 0) return w;
                    var rect = el.getBoundingClientRect();
                    return rect ? rect.width : 0;
                }
            });
            Object.defineProperty(el, 'scrollHeight', {
                configurable: true,
                get: function () {
                    var maxH = el.clientHeight || 0;
                    for (var i = 0; i < el.children.length; i++) {
                        var c = el.children[i];
                        if (!c) continue;
                        // Canvas inside scroll wrapper: use its style.height
                        // (set by Timeline.resize() in CSS pixels). Otherwise
                        // recurse into child's scrollHeight.
                        var ch = 0;
                        if (c.style && parseFloat(c.style.height) > 0) {
                            ch = parseFloat(c.style.height);
                        } else if (typeof c.scrollHeight === 'number') {
                            ch = c.scrollHeight;
                        }
                        if (ch > maxH) maxH = ch;
                    }
                    return maxH;
                }
            });
            return el;
        },
        getElementById: function(id) {
            // Walk the body tree (populated by tests via document.body.appendChild)
            // looking for a child whose `id` matches. Returns the LAST match
            // — many existing tests leak elements into document.body without
            // calling remove(), so the most-recent element is the right one
            // to surface to the test currently running.
            var stack = (sandbox.document.body && sandbox.document.body.children) ? sandbox.document.body.children.slice() : [];
            var found = null;
            while (stack.length) {
                var n = stack.shift();
                if (n && n.id === id) found = n;
                if (n && n.children && n.children.length) stack.push.apply(stack, n.children);
            }
            return found;
        },
        // Document-level event dispatch — minimal implementation used by
        // the Block 1 timeline-toggle keyboard-shortcut test. Listeners
        // registered via addEventListener('keydown', fn) are stored on
        // _listeners; dispatchEvent({type:'keydown', ...}) invokes them.
        _listeners: {},
        addEventListener: function(type, fn) {
            var d = sandbox.document;
            if (!d._listeners[type]) d._listeners[type] = [];
            d._listeners[type].push(fn);
        },
        removeEventListener: function(type, fn) {
            var d = sandbox.document;
            if (!d._listeners[type]) return;
            var idx = d._listeners[type].indexOf(fn);
            if (idx >= 0) d._listeners[type].splice(idx, 1);
        },
        dispatchEvent: function(ev) {
            var d = sandbox.document;
            if (!ev || !ev.type) return true;
            var arr = (d._listeners[ev.type] || []).slice();
            for (var i = 0; i < arr.length; i++) {
                try { arr[i].call(d, ev); } catch (err) { console.error(err); }
            }
            return true;
        },
        querySelectorAll: function() { return []; },
        querySelector: function() { return null; },
        body: { appendChild: function(c){
            if (!sandbox.document.body.children) sandbox.document.body.children = [];
            sandbox.document.body.children.push(c);
            c.parentNode = sandbox.document.body;
            c.parentElement = sandbox.document.body;
            return c;
        }, removeChild: function(c){
            var arr = sandbox.document.body.children || [];
            var i = arr.indexOf(c);
            if (i >= 0) arr.splice(i, 1);
            c.parentNode = null;
            c.parentElement = null;
            return c;
        }, children: [], style: {} },
        createElementNS: function(ns, tag) { return sandbox.document.createElement(tag); },
        createTextNode: function(text) { return { textContent: text, nodeType: 3 }; },
    },
    window: { addEventListener: function(){}, removeEventListener: function(){}, devicePixelRatio: 1, requestAnimationFrame: function(){}, innerWidth: 1920, innerHeight: 1080, getComputedStyle: function(el) {
        // Block 1: timeline-scroll test reads `overflowY` from
        // getComputedStyle. Bridge the inline style so tests inspecting
        // CSS-applied overflow don't crash on a missing field.
        var s = (el && el.style) || {};
        return {
            getPropertyValue: function() { return ''; },
            overflowY: s.overflowY || '',
            overflowX: s.overflowX || '',
            width: s.width || '',
            height: s.height || '',
            fontSize: '14px',
        };
    } },
    getComputedStyle: function(el) {
        var s = (el && el.style) || {};
        return {
            getPropertyValue: function() { return ''; },
            overflowY: s.overflowY || '',
            overflowX: s.overflowX || '',
            width: s.width || '640px',
            height: s.height || '480px',
            fontSize: '14px',
        };
    },
    HTMLCanvasElement: function() {},
    CanvasRenderingContext2D: function() {},
    OffscreenCanvas: function(w, h) { this.width = w; this.height = h; this.getContext = function() { return mockCtx(); }; },
    navigator: { userAgent: 'node' },
    requestAnimationFrame: function(cb) { return 1; },
    cancelAnimationFrame: function() {},
    Image: function() { this.src = ''; this.onload = null; },
    Blob: function() {},
    ResizeObserver: function(cb) { this.observe = function(){}; this.unobserve = function(){}; this.disconnect = function(){}; },
    KeyboardEvent: function(type, opts) {
        opts = opts || {};
        this.type = type;
        this.key = opts.key || '';
        this.code = opts.code || '';
        this.ctrlKey = !!opts.ctrlKey;
        this.metaKey = !!opts.metaKey;
        this.altKey = !!opts.altKey;
        this.shiftKey = !!opts.shiftKey;
        this.preventDefault = function() {};
        this.stopPropagation = function() {};
    },
    MouseEvent: function(type, opts) {
        opts = opts || {};
        this.type = type;
        this.clientX = opts.clientX || 0;
        this.clientY = opts.clientY || 0;
        this.button = opts.button || 0;
        this.detail = opts.detail || 0;
        this.ctrlKey = !!opts.ctrlKey;
        this.metaKey = !!opts.metaKey;
        this.altKey = !!opts.altKey;
        this.shiftKey = !!opts.shiftKey;
        this.preventDefault = function() {};
        this.stopPropagation = function() {};
        this.bubbles = !!opts.bubbles;
    },
    URL: { createObjectURL: function() { return 'blob:test'; }, revokeObjectURL: function() {} },
    FileReader: function() { this.readAsArrayBuffer = function(){}; this.readAsText = function(){}; },
    fetch: function() { return Promise.resolve({ ok: true, json: function() { return Promise.resolve({}); } }); },
    THREE: {
        Scene: function() { var self = this; this.children = []; this.add = function(c){self.children.push(c)}; this.remove = function(c){var i=self.children.indexOf(c);if(i>=0)self.children.splice(i,1)}; this.traverse = function(fn){fn(self);for(var i=0;i<self.children.length;i++){if(self.children[i].traverse)self.children[i].traverse(fn);else fn(self.children[i])}}; },
        PerspectiveCamera: function() { this.position = {set:function(){return this},copy:function(){return this},clone:function(){return this},x:0,y:0,z:0,distanceTo:function(){return 10}}; this.up = {set:function(){return this},copy:function(){return this}}; this.lookAt = function(){}; this.updateProjectionMatrix = function(){}; this.aspect = 1; this.fov = 75; this.near = 0.1; this.far = 1000; },
        WebGLRenderer: function() { this.setSize = function(){}; this.render = function(){}; this.domElement = sandbox.document.createElement('canvas'); this.dispose = function(){}; this.setPixelRatio = function(){}; },
        Vector3: function(x,y,z) { this.x=x||0; this.y=y||0; this.z=z||0; this.set=function(a,b,c){this.x=a;this.y=b;this.z=c;return this}; this.copy=function(v){this.x=v.x;this.y=v.y;this.z=v.z;return this}; this.clone=function(){return new sandbox.THREE.Vector3(this.x,this.y,this.z)}; this.normalize=function(){return this}; this.cross=function(){return this}; this.sub=function(){return this}; this.add=function(){return this}; this.multiplyScalar=function(){return this}; this.length=function(){return 0}; this.distanceTo=function(){return 10}; this.applyMatrix4=function(){return this}; },
        Color: function() { this.set = function(){return this}; this.r=0;this.g=0;this.b=0; },
        BufferGeometry: function() { this.setAttribute = function(){}; this.setIndex = function(){}; this.dispose = function(){}; this.setFromPoints = function(){}; },
        Float32BufferAttribute: function() {},
        Uint16BufferAttribute: function() {},
        MeshBasicMaterial: function(o) { this.dispose = function(){}; this.color = new sandbox.THREE.Color(); if(o) Object.assign(this,o); },
        LineBasicMaterial: function(o) { this.dispose = function(){}; if(o) Object.assign(this,o); },
        LineDashedMaterial: function(o) { this.dispose = function(){}; if(o) Object.assign(this,o); },
        PointsMaterial: function(o) { this.dispose = function(){}; if(o) Object.assign(this,o); },
        Mesh: function() { this.position = {x:0,y:0,z:0,set:function(a,b,c){this.x=a;this.y=b;this.z=c;return this},copy:function(v){this.x=v.x;this.y=v.y;this.z=v.z;return this}}; this.scale = {set:function(){return this}}; this.visible = true; this.material = {color:{set:function(){return this}},dispose:function(){}}; this.geometry = {dispose:function(){}}; this.quaternion = {copy:function(){return this},setFromUnitVectors:function(){return this}}; this.name = ''; this.isMesh = true; },
        Line: function() { this.computeLineDistances = function(){}; this.geometry = new sandbox.THREE.BufferGeometry(); },
        LineSegments: function() { this.computeLineDistances = function(){}; this.geometry = new sandbox.THREE.BufferGeometry(); },
        Points: function() {},
        Group: function() { var self = this; this.children = []; this.add = function(c){self.children.push(c)}; this.remove = function(c){var i=self.children.indexOf(c);if(i>=0)self.children.splice(i,1)}; this.traverse = function(fn){fn(self);for(var i=0;i<self.children.length;i++){if(self.children[i].traverse)self.children[i].traverse(fn);else fn(self.children[i])}}; },
        SphereGeometry: function() { this.dispose = function(){}; },
        BoxGeometry: function() { this.dispose = function(){}; },
        ConeGeometry: function() { this.dispose = function(){}; },
        CylinderGeometry: function() { this.dispose = function(){}; },
        Raycaster: function() { this.setFromCamera = function(){}; this.intersectObjects = function(){ return []; }; },
        Vector2: function(x,y) { this.x=x||0; this.y=y||0; },
        Matrix4: function() { this.set = function(){return this}; this.elements = new Array(16).fill(0); },
        AmbientLight: function() {},
        DirectionalLight: function() { this.position = {set:function(){return this}}; },
        GridHelper: function() { this.rotation = {x:0,y:0,z:0}; },
        AxesHelper: function() { this.scale = {set:function(){return this},setScalar:function(){return this}}; },
        Sprite: function() { this.position = {x:0,y:0,z:0,set:function(a,b,c){this.x=a;this.y=b;this.z=c;return this},copy:function(v){this.x=v.x;this.y=v.y;this.z=v.z;return this}}; this.scale = {x:1,y:1,z:1,set:function(a,b,c){this.x=a;this.y=b;this.z=c;return this},multiplyScalar:function(s){this.x*=s;this.y*=s;this.z*=s;return this}}; },
        SpriteMaterial: function() { this.dispose = function(){}; this.map = null; },
        CanvasTexture: function() { this.dispose = function(){}; this.minFilter = 0; },
        MeshPhongMaterial: function(o) { this.dispose = function(){}; this.color = new sandbox.THREE.Color(); if(o) Object.assign(this,o); },
        Object3D: function() { var self = this; this.children = []; this.add = function(c){self.children.push(c)}; this.remove = function(c){var i=self.children.indexOf(c);if(i>=0)self.children.splice(i,1)}; this.position = {x:0,y:0,z:0,set:function(a,b,c){this.x=a;this.y=b;this.z=c;return this}}; this.traverse = function(fn){fn(self);for(var i=0;i<self.children.length;i++){if(self.children[i].traverse)self.children[i].traverse(fn);else fn(self.children[i])}}; },
        Quaternion: function() { this.setFromEuler = function(){return this}; this.setFromAxisAngle = function(){return this}; this.setFromUnitVectors = function(){return this}; },
        DoubleSide: 2,
        LinearFilter: 1006,
    },
    process: { exit: function(code) { process.exit(code); }, versions: { node: process.versions.node } },
    // Expose a synchronous source-file loader so individual tests can read
    // production source files that aren't preloaded by the vm sandbox above.
    // Path is resolved relative to the repository root.
    __readSource: function(relPath) {
        return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf-8');
    }
};

// Also support OrbitControls
sandbox.THREE.OrbitControls = function(cam, el) {
    this.update = function(){};
    this.addEventListener = function(){};
    this.removeEventListener = function(){};
    this.target = { set: function(){return this}, copy: function(){return this}, x:0, y:0, z:0 };
    this.enabled = true;
    this.dispose = function(){};
};

var ctx = vm.createContext(sandbox);

function loadScript(filePath) {
    var code = fs.readFileSync(filePath, 'utf-8');
    // Strip ESM `import { … } from '…';` statements. The vm sandbox loads
    // each source file in dependency order and exposes its declarations as
    // sandbox globals, so the imported symbols are already in scope.
    code = code.replace(/^import\s+(\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"][^'"]+['"]\s*;?\s*$/gm, '');
    // Strip leading `export ` keywords so ESM-converted modules load as classic
    // scripts. Agents only ever prepend `export ` to top-level declarations.
    code = code.replace(/^export\s+(class|function|const|let|var|async)\s+/gm, '$1 ');
    // Strip trailing `export { … };` re-export blocks (used by modules that
    // declare their helpers with bare `function` declarations and re-export
    // a named list at the bottom). The vm sandbox already has the bindings
    // available as context globals, so the re-export is a no-op.
    code = code.replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '');
    // Replace const/let with var so declarations become context properties
    code = code.replace(/^(const|let)\s+/gm, 'var ');
    // vm.Script cannot parse `import.meta.*` (it's only legal inside ESM
    // modules). Replace with a sentinel string — none of our test paths
    // exercise the Worker construction that uses it.
    code = code.replace(/import\.meta\.url/g, "'file://stub'");
    var script = new vm.Script(code, { filename: filePath });
    script.runInContext(ctx);
}

// Load test framework
loadScript(path.join(__dirname, 'test-framework.js'));

// Export test helpers to sandbox for convenience
var helperNames = ['describe', 'it', 'beforeEach', 'assert', 'assertEqual', 'assertDeepEqual',
    'assertApprox', 'assertNull', 'assertNotNull', 'assertThrows', 'assertTrue', 'assertFalse',
    'assertGreaterThan', 'assertLessThan'];
for (var h = 0; h < helperNames.length; h++) {
    sandbox[helperNames[h]] = sandbox.TestFramework[helperNames[h]];
}

// Load source files
var srcDir = path.join(__dirname, '..');
var srcFiles = ['pose/pose-data.js', 'pose/triangulation.js', 'ui/viewport3d.js', 'import-export/file-io.js', 'import-export/slp-merge.js', 'ui/interaction.js', 'ui/overlays.js', 'ui/timeline.js', 'ui/timeline-visibility.js', 'loading/video.js', 'ui/loading-progress-modal.js', 'import-export/slp-import.js', 'ui/app-state.js', 'ui/timeline-controller.js'];
for (var i = 0; i < srcFiles.length; i++) {
    try { loadScript(path.join(srcDir, srcFiles[i])); }
    catch(e) { console.log(srcFiles[i] + ': ' + e.message.substring(0, 120)); }
}

// Block 1 (Prompt 4): the timeline-toggle-shortcut tests look up the
// installer/toggle functions on `window`. In the node sandbox, source
// files declare their top-level vars on the sandbox itself (the
// vm-context global), not on `sandbox.window`. Mirror the timeline
// controller exports onto `sandbox.window` so the tests find them.
var __toExposeOnWindow = [
    'toggleTimeline', 'fitTimelineToData', 'syncTimelineToggleButton',
    'installTimelineShortcuts', 'getCachedTimelineHeight',
    'setCachedTimelineHeight',
    // Block 2 (Prompt 4): timeline-visibility toggle helpers + list
    // sources. The VAPI test resolves these either via `window.X` or via
    // `globalThis.TimelineVisibility.X`; mirror both forms onto the
    // sandbox's window stub so the tests succeed regardless of which
    // resolution path they take.
    'toggleCameraVisibility', 'toggleTrackVisibility', 'toggleIdentityVisibility',
    'isCameraVisible', 'isTrackVisible', 'isIdentityVisible',
    'listCamerasForVisibility', 'listTracksForVisibility', 'listIdentitiesForVisibility',
    'getCameraVisibilityList', 'getTrackVisibilityList', 'getIdentityVisibilityList',
    'renameHiddenTrack', 'renameHiddenIdentity', 'ensureHiddenSets',
];
for (var __wi = 0; __wi < __toExposeOnWindow.length; __wi++) {
    var __name = __toExposeOnWindow[__wi];
    if (typeof sandbox[__name] === 'function') {
        sandbox.window[__name] = sandbox[__name];
    }
}

// Load all test files
var testFiles = [
    'test-pose-data.js',
    'test-triangulation.js',
    'test-file-io.js',
    'test-interaction.js',
    'test-regressions.js',
    'test-overlays.js',
    'test-integration.js',
    'test-video-mgmt.js',
    'test-view-mode.js',
    'test-instance-drag.js',
    'test-phase6.js',
    'test-phase7.js',
    'test-timeline.js',
    'test-timeline-bugs.js',
    'test-timeline-height.js',
    'test-grouped-track-dropdown.js',
    'test-video-controller.js',
    'test-multi-video.js',
    'test-drag-freeze.js',
    'test-labels.js',
    'test-assignment.js',
    'test-project-triangulation.js',
    'test-slp-merge.js',
    'test-tempdata-triangulation.js',
    'test-2026-03-09-changes.js',
    'test-predicted-dblclick.js',
    'test-ungroup-fix.js',
    'test-group-selection-rules.js',
    'test-predicted-visibility-on-load.js',
    'test-edit-group-fixes.js',
    'test-mixed-group-promotion.js',
    'test-delete-auto-ungroup.js',
    'test-mixed-group-integration.js',
    'test-identity-none-label.js',
    'test-bottom-bar.js',
    'test-multi-session-export.js',
    'test-reprojection-lifecycle.js',
    'test-identity.js',
    'test-session-switching.js',
    'test-session-switch-frame-reset.js',
    'test-switchsource-mp4box-await.js',
    'test-html5-seek-tolerance.js',
    'test-switchsession-parallel-decoders.js',
    'test-decoder-onprogress.js',
    'test-switchsession-progress-wiring.js',
    'test-loading-progress-modal-api.js',
    'test-slp-import-sequential.js',
    'test-slp-import-parallel-videos.js',
    'test-slp-import-modal-structure.js',
    'test-decoder-pool-repeated-swap.js',
    'test-predicted-conversion.js',
    'test-save-load-json.js',
    'test-tracker.js',
    'test-rotation.js',
    // Prompt 4 / Block 1 — pre-implementation failing tests.
    'test-timeline-tree-grouping.js',
    'test-timeline-scroll.js',
    'test-timeline-toggle-shortcut.js',
    // Prompt 4 / Block 2 — pre-implementation failing tests.
    'test-timeline-visibility-toggles.js',
    'test-timeline-visibility-state.js',
    'test-timeline-visibility-list.js',
];

for (var i = 0; i < testFiles.length; i++) {
    try {
        loadScript(path.join(__dirname, testFiles[i]));
    } catch(e) {
        console.log(testFiles[i] + ' load error: ' + e.message.substring(0, 150));
    }
}

// Run
sandbox.TestFramework.runAll().then(function(results) {
    console.log('\n=== Test Results: ' + results.passed + '/' + results.total + ' passed ===\n');
    for (var s = 0; s < results.suites.length; s++) {
        var suite = results.suites[s];
        var icon = suite.failed === 0 ? '✓' : '✗';
        console.log(icon + ' ' + suite.name + ' (' + suite.passed + '/' + suite.tests.length + ')');
        for (var t = 0; t < suite.tests.length; t++) {
            var test = suite.tests[t];
            if (test.status === 'failed') {
                console.log('  ✗ ' + test.name);
                console.log('    ' + test.error);
            }
        }
    }
    if (results.failed > 0) process.exit(1);
});
