/**
 * trackers/dart/kalman.js — Constant-velocity Kalman filter for 3D track state.
 *
 * One of four algorithm modules composed into the DART tracker. Each tracked
 * identity owns one {@link window.LucidDART.KalmanTrack}. The state vector is
 *
 *     x = [ x, y, z, vx, vy, vz ]   // world-coordinate position + velocity
 *
 * with a constant-velocity motion model (no acceleration). Observations are
 * 3D positions [x, y, z] — typically the output of a triangulated group from
 * the cross-view matcher.
 *
 * Per-frame flow:
 *   predict:  x_hat = F * x,      P_hat = F * P * F^T + Q
 *   update:   S = H * P_hat * H^T + R
 *             K = P_hat * H^T * S^-1
 *             x = x_hat + K * (z - H * x_hat)
 *             P = (I - K * H) * P_hat
 *
 * Pure JS, no dependencies. Attaches exports to `window.LucidDART` as an IIFE
 * to match the LUCID convention used by `trackers/registry.js`,
 * `trackers/default.js`, and `trackers/dart/bytetrack.js`.
 *
 * Exposes:
 *   window.LucidDART.KalmanTrack
 *   window.LucidDART.KalmanMath  (small scoped helpers for 3x3 / 6x6 / 3x6)
 */

(function () {
    'use strict';

    window.LucidDART = window.LucidDART || {};

    // ============================================
    // Matrix helpers — scoped to the shapes used by this Kalman filter.
    // Not a general matrix library.
    // ============================================

    /**
     * Dispatch matrix multiply by the shapes used here:
     *   3x3 * 3x3   (innovation covariance helpers)
     *   6x6 * 6x6   (F * P)
     *   3x6 * 6x6   (H * P)
     *   6x6 * 6x3   (P * H^T)
     *   6x6 * 6x1   (F * x, (I-KH) things)
     *   3x6 * 6x1   (H * x)
     *   6x3 * 3x3   (PHt * S^-1)
     *   6x3 * 3x1   (K * y)
     *   3x3 * 3x1   (S^-1 * y  — used in mahalanobis)
     *
     * Treats a 6x1 / 3x1 as an array-of-arrays where each inner array has
     * length 1. Returns a newly-allocated matrix.
     *
     * @param {number[][]} A
     * @param {number[][]} B
     * @returns {number[][]}
     */
    function mul(A, B) {
        var aRows = A.length;
        var aCols = A[0].length;
        var bRows = B.length;
        var bCols = B[0].length;
        if (aCols !== bRows) {
            throw new Error('KalmanMath.mul: shape mismatch ' +
                aRows + 'x' + aCols + ' * ' + bRows + 'x' + bCols);
        }
        var out = new Array(aRows);
        for (var i = 0; i < aRows; i++) {
            var row = new Array(bCols);
            for (var j = 0; j < bCols; j++) {
                var s = 0;
                for (var k = 0; k < aCols; k++) {
                    s += A[i][k] * B[k][j];
                }
                row[j] = s;
            }
            out[i] = row;
        }
        return out;
    }

    /**
     * Transpose a matrix. Works for any rectangular shape.
     *
     * @param {number[][]} A
     * @returns {number[][]}
     */
    function transpose(A) {
        var rows = A.length;
        var cols = A[0].length;
        var out = new Array(cols);
        for (var j = 0; j < cols; j++) {
            var row = new Array(rows);
            for (var i = 0; i < rows; i++) {
                row[i] = A[i][j];
            }
            out[j] = row;
        }
        return out;
    }

    /**
     * Element-wise add. Shapes must match exactly.
     *
     * @param {number[][]} A
     * @param {number[][]} B
     * @returns {number[][]}
     */
    function add(A, B) {
        var rows = A.length;
        var cols = A[0].length;
        if (B.length !== rows || B[0].length !== cols) {
            throw new Error('KalmanMath.add: shape mismatch');
        }
        var out = new Array(rows);
        for (var i = 0; i < rows; i++) {
            var row = new Array(cols);
            for (var j = 0; j < cols; j++) {
                row[j] = A[i][j] + B[i][j];
            }
            out[i] = row;
        }
        return out;
    }

    /**
     * Element-wise subtract. Shapes must match exactly.
     *
     * @param {number[][]} A
     * @param {number[][]} B
     * @returns {number[][]}
     */
    function sub(A, B) {
        var rows = A.length;
        var cols = A[0].length;
        if (B.length !== rows || B[0].length !== cols) {
            throw new Error('KalmanMath.sub: shape mismatch');
        }
        var out = new Array(rows);
        for (var i = 0; i < rows; i++) {
            var row = new Array(cols);
            for (var j = 0; j < cols; j++) {
                row[j] = A[i][j] - B[i][j];
            }
            out[i] = row;
        }
        return out;
    }

    /**
     * Scalar multiply. Returns a new matrix.
     *
     * @param {number[][]} A
     * @param {number} s
     * @returns {number[][]}
     */
    function scale(A, s) {
        var rows = A.length;
        var cols = A[0].length;
        var out = new Array(rows);
        for (var i = 0; i < rows; i++) {
            var row = new Array(cols);
            for (var j = 0; j < cols; j++) {
                row[j] = A[i][j] * s;
            }
            out[i] = row;
        }
        return out;
    }

    /**
     * n x n identity matrix. Only n in {3, 6} is needed by this module.
     *
     * @param {number} n
     * @returns {number[][]}
     */
    function identity(n) {
        var out = new Array(n);
        for (var i = 0; i < n; i++) {
            var row = new Array(n);
            for (var j = 0; j < n; j++) row[j] = (i === j) ? 1 : 0;
            out[i] = row;
        }
        return out;
    }

    /**
     * Invert a 3x3 matrix via the analytic adjugate / cofactor formula.
     * This is the only inversion the filter needs (for the 3x3 innovation
     * covariance S). Throws if the matrix is (near-)singular.
     *
     * @param {number[][]} A  3x3
     * @returns {number[][]} 3x3 inverse
     */
    function invert3x3(A) {
        if (A.length !== 3 || A[0].length !== 3) {
            throw new Error('KalmanMath.invert3x3: input must be 3x3');
        }
        var a = A[0][0], b = A[0][1], c = A[0][2];
        var d = A[1][0], e = A[1][1], f = A[1][2];
        var g = A[2][0], h = A[2][1], i = A[2][2];

        var A11 =  (e * i - f * h);
        var A12 = -(d * i - f * g);
        var A13 =  (d * h - e * g);
        var A21 = -(b * i - c * h);
        var A22 =  (a * i - c * g);
        var A23 = -(a * h - b * g);
        var A31 =  (b * f - c * e);
        var A32 = -(a * f - c * d);
        var A33 =  (a * e - b * d);

        var det = a * A11 + b * A12 + c * A13;
        if (!isFinite(det) || Math.abs(det) < 1e-18) {
            throw new Error('KalmanMath.invert3x3: matrix is singular (det=' + det + ')');
        }
        var invDet = 1 / det;

        // adj(A) is the transpose of the cofactor matrix
        return [
            [A11 * invDet, A21 * invDet, A31 * invDet],
            [A12 * invDet, A22 * invDet, A32 * invDet],
            [A13 * invDet, A23 * invDet, A33 * invDet]
        ];
    }

    var KalmanMath = {
        mul: mul,
        transpose: transpose,
        add: add,
        sub: sub,
        invert3x3: invert3x3,
        identity: identity,
        scale: scale
    };

    // ============================================
    // Deep-copy helper for covariance getter
    // ============================================

    function copyMatrix(M) {
        var rows = M.length;
        var out = new Array(rows);
        for (var i = 0; i < rows; i++) {
            out[i] = M[i].slice();
        }
        return out;
    }

    // ============================================
    // KalmanTrack
    // ============================================

    /**
     * Kalman filter track for a single identity. Maintains a 6D state
     * (3D position + 3D velocity) with a constant-velocity motion model.
     *
     * Use one instance per tracked identity.
     */
    var KalmanTrack = class {
        /**
         * @param {number[]} initialPos  [x, y, z] observed position for the first frame.
         *                               Initial velocity is 0. `[0, 0, 0]` is a valid
         *                               input (not a sentinel).
         * @param {Object}   [cfg]
         * @param {number}   [cfg.processNoise=0.1]      Q = I6 * processNoise
         * @param {number}   [cfg.measurementNoise=10]   R = I3 * measurementNoise
         * @param {number}   [cfg.maxMissedFrames=10]    isLost() threshold
         * @param {number}   [cfg.dt=1]                  timestep between frames
         */
        constructor(initialPos, cfg) {
            if (!Array.isArray(initialPos) || initialPos.length !== 3) {
                throw new Error('KalmanTrack: initialPos must be [x, y, z]');
            }
            cfg = cfg || {};

            this._processNoise     = (cfg.processNoise     != null) ? cfg.processNoise     : 0.1;
            this._measurementNoise = (cfg.measurementNoise != null) ? cfg.measurementNoise : 10;
            this._maxMissedFrames  = (cfg.maxMissedFrames  != null) ? cfg.maxMissedFrames  : 10;
            this._dt               = (cfg.dt               != null) ? cfg.dt               : 1;

            // State (6x1): position + velocity; velocity starts at zero.
            this._x = [
                [initialPos[0]],
                [initialPos[1]],
                [initialPos[2]],
                [0],
                [0],
                [0]
            ];

            // Covariance (6x6): high initial uncertainty.
            this._P = scale(identity(6), 100);

            // Process / measurement noise matrices.
            this._Q = scale(identity(6), this._processNoise);
            this._R = scale(identity(3), this._measurementNoise);

            // State transition F (6x6): position += velocity * dt.
            this._F = this._buildF(this._dt);

            // Observation H (3x6): observe [x, y, z] only.
            this._H = [
                [1, 0, 0, 0, 0, 0],
                [0, 1, 0, 0, 0, 0],
                [0, 0, 1, 0, 0, 0]
            ];

            this._missedFrames = 0;
        }

        _buildF(dt) {
            return [
                [1, 0, 0, dt, 0,  0 ],
                [0, 1, 0, 0,  dt, 0 ],
                [0, 0, 1, 0,  0,  dt],
                [0, 0, 0, 1,  0,  0 ],
                [0, 0, 0, 0,  1,  0 ],
                [0, 0, 0, 0,  0,  1 ]
            ];
        }

        /**
         * Predict step:
         *   x = F * x
         *   P = F * P * F^T + Q
         * Increments _missedFrames. Returns a flat copy of the predicted state.
         *
         * @returns {number[]} length-6 [x, y, z, vx, vy, vz]
         */
        predict() {
            this._x = mul(this._F, this._x);
            var Ft = transpose(this._F);
            this._P = add(mul(mul(this._F, this._P), Ft), this._Q);

            this._missedFrames += 1;

            return [
                this._x[0][0], this._x[1][0], this._x[2][0],
                this._x[3][0], this._x[4][0], this._x[5][0]
            ];
        }

        /**
         * Update step given a 3D observation:
         *   S = H * P * H^T + R
         *   K = P * H^T * S^-1
         *   x = x + K * (z - H * x)
         *   P = (I - K * H) * P
         * Resets _missedFrames to 0. Returns a flat copy of the updated state.
         *
         * @param {number[]} observation3D  [x, y, z]
         * @returns {number[]} length-6 [x, y, z, vx, vy, vz]
         */
        update(observation3D) {
            if (!Array.isArray(observation3D) || observation3D.length !== 3) {
                throw new Error('KalmanTrack.update: observation must be [x, y, z]');
            }

            var z = [[observation3D[0]], [observation3D[1]], [observation3D[2]]];
            var Ht = transpose(this._H);

            // Innovation y = z - H*x
            var Hx = mul(this._H, this._x);               // 3x1
            var y  = sub(z, Hx);                          // 3x1

            // Innovation covariance S = H*P*H^T + R
            var S = add(mul(mul(this._H, this._P), Ht), this._R);  // 3x3
            var Sreg = this._regularize3x3(S);
            var Sinv = invert3x3(Sreg);

            // Kalman gain K = P*H^T*S^-1
            var K = mul(mul(this._P, Ht), Sinv);          // 6x3

            // x = x + K*y
            this._x = add(this._x, mul(K, y));

            // P = (I - K*H)*P
            var KH = mul(K, this._H);                     // 6x6
            this._P = mul(sub(identity(6), KH), this._P);

            this._missedFrames = 0;

            return [
                this._x[0][0], this._x[1][0], this._x[2][0],
                this._x[3][0], this._x[4][0], this._x[5][0]
            ];
        }

        /**
         * Add a tiny diagonal regularization to a 3x3 matrix so that
         * near-singular innovation covariances (e.g. R=0 with degenerate P)
         * still invert cleanly. Returns a new matrix.
         *
         * @param {number[][]} S  3x3
         * @returns {number[][]}
         */
        _regularize3x3(S) {
            var EPS = 1e-9;
            return [
                [S[0][0] + EPS, S[0][1],       S[0][2]      ],
                [S[1][0],       S[1][1] + EPS, S[1][2]      ],
                [S[2][0],       S[2][1],       S[2][2] + EPS]
            ];
        }

        /** @returns {boolean} true when the track has missed more than maxMissedFrames updates. */
        isLost() {
            return this._missedFrames > this._maxMissedFrames;
        }

        /**
         * Mahalanobis distance from `observation3D` to the current predicted
         * position, using the innovation covariance
         *
         *     S = H * P * H^T + R
         *
         * Distance = sqrt( y^T * S^-1 * y )  where y = observation - H*x.
         *
         * @param {number[]} observation3D
         * @returns {number}
         */
        mahalanobisDistance(observation3D) {
            if (!Array.isArray(observation3D) || observation3D.length !== 3) {
                throw new Error('KalmanTrack.mahalanobisDistance: observation must be [x, y, z]');
            }

            var z = [[observation3D[0]], [observation3D[1]], [observation3D[2]]];
            var Ht = transpose(this._H);
            var Hx = mul(this._H, this._x);
            var y  = sub(z, Hx);                          // 3x1

            var S = add(mul(mul(this._H, this._P), Ht), this._R);  // 3x3
            var Sreg = this._regularize3x3(S);
            var Sinv = invert3x3(Sreg);

            // y^T * S^-1 * y  -> 1x1 scalar
            var Sinv_y = mul(Sinv, y);                    // 3x1
            var m = y[0][0] * Sinv_y[0][0] +
                    y[1][0] * Sinv_y[1][0] +
                    y[2][0] * Sinv_y[2][0];

            if (!isFinite(m)) return Infinity;
            if (m < 0) m = 0;  // tiny numerical negatives from near-zero residual
            return Math.sqrt(m);
        }

        // ----- Read-only getters -----

        get position()     { return [this._x[0][0], this._x[1][0], this._x[2][0]]; }
        get velocity()     { return [this._x[3][0], this._x[4][0], this._x[5][0]]; }
        get missedFrames() { return this._missedFrames; }
        /** Returns a deep copy so callers can't corrupt internal covariance. */
        get covariance()   { return copyMatrix(this._P); }
    };

    // ============================================
    // Export
    // ============================================

    window.LucidDART.KalmanTrack = KalmanTrack;
    window.LucidDART.KalmanMath  = KalmanMath;
})();
