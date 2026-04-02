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
                setAttribute: function() {},
                getAttribute: function() { return null; },
                addEventListener: function() {},
                removeEventListener: function() {},
                getBoundingClientRect: function() { return {left:0,top:0,width:640,height:480,right:640,bottom:480}; },
                getContext: function() { return mockCtx(); },
                children: [],
                childNodes: [],
                parentNode: null,
                querySelectorAll: function(sel) {
                    var results = [];
                    var tagMatch = sel.match(/^([a-zA-Z]+)/);
                    var target = tagMatch ? tagMatch[1].toUpperCase() : null;
                    for (var i = 0; i < el.children.length; i++) {
                        var child = el.children[i];
                        if (target && child.tagName === target) results.push(child);
                    }
                    return results;
                },
                querySelector: function(sel) {
                    var all = el.querySelectorAll(sel);
                    return all.length > 0 ? all[0] : null;
                },
                dispatchEvent: function() {},
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
            return el;
        },
        getElementById: function() { return null; },
        addEventListener: function() {},
        removeEventListener: function() {},
        querySelectorAll: function() { return []; },
        querySelector: function() { return null; },
        body: { appendChild: function(){}, removeChild: function(){}, style: {} },
        createElementNS: function(ns, tag) { return sandbox.document.createElement(tag); },
        createTextNode: function(text) { return { textContent: text, nodeType: 3 }; },
    },
    window: { addEventListener: function(){}, removeEventListener: function(){}, devicePixelRatio: 1, requestAnimationFrame: function(){}, innerWidth: 1920, innerHeight: 1080, getComputedStyle: function() { return { getPropertyValue: function() { return ''; } }; } },
    getComputedStyle: function() { return { getPropertyValue: function() { return ''; }, width: '640px', height: '480px', fontSize: '14px' }; },
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
    process: { exit: function(code) { process.exit(code); }, versions: { node: process.versions.node } }
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
    // Replace const/let with var so declarations become context properties
    code = code.replace(/^(const|let)\s+/gm, 'var ');
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
var srcFiles = ['pose-data.js', 'triangulation.js', 'viewport3d.js', 'file-io.js', 'slp-merge.js', 'interaction.js', 'overlays.js', 'timeline.js', 'video.js'];
for (var i = 0; i < srcFiles.length; i++) {
    try { loadScript(path.join(srcDir, srcFiles[i])); }
    catch(e) { console.log(srcFiles[i] + ': ' + e.message.substring(0, 120)); }
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
    'test-video-controller.js',
    'test-multi-video.js',
    'test-drag-freeze.js',
    'test-labels.js',
    'test-assignment.js',
    'test-project-triangulation.js',
    'test-slp-merge.js',
    'test-tempdata-triangulation.js',
    'test-prompt61.js',
    'test-bottom-bar.js',
    'test-multi-session-export.js',
    'test-reprojection-lifecycle.js',
    'test-identity.js',
    'test-session-switching.js',
    'test-predicted-conversion.js',
    'test-save-load-json.js',
    'test-tracker.js',
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
