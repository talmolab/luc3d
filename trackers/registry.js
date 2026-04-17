/**
 * trackers/registry.js — source of truth for available tracking algorithms.
 *
 * Exposes window.LucidTrackers. Each algorithm module self-registers by
 * calling LucidTrackers.register(id, fn, descriptor) at script-eval time.
 *
 * Descriptor shape (all fields optional except where noted):
 *   {
 *     name?: string,           // human-readable label (defaults to id)
 *     description?: string,    // one-line summary shown in the wizard
 *     hyperparameters?: Array<{
 *       key: string,           // required — unique within algorithm
 *       default: any,          // required — initial value
 *       label?: string,        // defaults to key
 *       type?: 'number' | 'boolean' | 'enum' | 'string',
 *       min?, max?, step?: number,        // for type: 'number'
 *       options?: Array<{value, label}>,  // for type: 'enum'
 *       help?: string,
 *       readOnly?: boolean,
 *       computed?: (values) => any        // when present, value is derived and readOnly
 *     }>
 *   }
 *
 * The registry is intentionally permissive — algorithms may include
 * additional descriptor fields that the GUI renderer ignores.
 *
 * --- Tracker variables (optional) ---
 * During fn(frameGroup, cameras, session, opts), an algorithm may
 * populate per-camera, per-frame metrics that the Timeline's
 * `Track Var` view will plot:
 *
 *   session.declareTrackerVariable(key, { label, yMin?, yMax? });
 *   session.setTrackerVariable(cameraName, key, frameIdx, value);
 *
 * declareTrackerVariable just supplies display metadata; no
 * declaration is required before the first setTrackerVariable call.
 * If no algorithm writes anything for the current session, the
 * Timeline shows "No tracker variable data available for this session."
 */

(function (global) {
    var _reg = new Map();
    var _order = [];

    function register(id, fn, descriptor) {
        if (typeof id !== 'string' || !id) throw new Error('LucidTrackers.register: id required');
        if (typeof fn !== 'function')       throw new Error('LucidTrackers.register: fn required');
        descriptor = descriptor || {};
        if (_reg.has(id)) {
            console.warn('[LucidTrackers] re-registering algorithm id:', id);
        } else {
            _order.push(id);
        }
        _reg.set(id, {
            id: id,
            name: descriptor.name || id,
            description: descriptor.description || '',
            hyperparameters: Array.isArray(descriptor.hyperparameters)
                             ? descriptor.hyperparameters
                             : [],
            fn: fn
        });
    }

    function get(id)       { return _reg.get(id) || null; }
    function has(id)       { return typeof id === 'string' && _reg.has(id); }
    function list()        { return _order.map(function (i) { return _reg.get(i); }); }
    function defaultId()   { return _order[0] || null; }

    global.LucidTrackers = {
        register: register,
        get: get,
        has: has,
        list: list,
        defaultId: defaultId
    };
})(window);
