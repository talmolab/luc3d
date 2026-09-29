# Upstream changes LUCID needs in `sleap-io.js`

LUCID vendors `sleap-io.js` at `lib/sleap-io/` (pinned to **0.5.5**, built from
`talmolab/sleap-io.js@e8dbaef8c`). Six local patches are applied to that bundle.
Every one is **re-applied by hand after each re-vendor** — grep the markers:

```bash
grep -rn "LUCID local patch" lib/sleap-io/
```

This document is the upstream-facing version of those patches: what is wrong,
why it matters, and what the fix should look like in the real repository. The
goal is to get to **zero local patches**.

They are ordered by how much they matter to LUCID.

---

## 1. `writeSessions` boxes every row of `/session_data` (memory)

**Marker:** `luc3d #185`, `luc3d #189`, `luc3d #190`
**Files:** `chunk-X76PRJK6.js` (`writeSessions`, `createMatrixDataset`,
`instanceGroupMemberRows`)
**Severity:** blocks saving a large multi-camera project at all.

### The problem

`writeSessions` accumulates the whole `/session_data` group as arrays of boxed
JS arrays before flattening them into typed arrays at the end:

- `points_3d` / `pred_points_3d` — one `Array(3|4)` per 3D keypoint
- `frame_groups` — one `Array(3)` per frame group
- `instance_groups` — one `Array(8)` per instance group
- `instance_group_members` — one `Array(3)` per member

On the project that drove this work (180,210 frames × 5 cameras, 531,799
instance groups, 15 nodes) that is **7,976,985 + 531,799 + 531,799 + 2,627,453
boxed arrays**, all live simultaneously until `createGzipFloatMatrix` /
`createMatrixDataset` copy them out.

This matters more than it looks, because of *where* the bytes land. A Chrome
renderer hard-caps V8's pointer-compressed heap near 4 GB
(`jsHeapSizeLimit` measures 3.76–4.19 GB depending on build), and
`--max-old-space-size` does **not** raise it. Boxed arrays live in that heap. A
typed array's backing store does not — verified by allocating 6,272 MB of
`Float64Array` against a reported 4,192 MB limit with no failure
(`tests/e2e/_diag-cage-vs-external.mjs`).

Measured with `tests/e2e/_bench-writesessions.mjs`, scaling instance groups:

| groups | members | write time | peak heap |
|---:|---:|---:|---:|
| 25,000 | 125,000 | 631 ms | 132 MB |
| 100,000 | 500,000 | 1,341 ms | 324 MB |
| 200,000 | 1,000,000 | 2,098 ms | 508 MB |
| 400,000 | 2,000,000 | 3,767 ms | 1,190 MB |

Time is **linear** (25.2 → 9.4 µs/group as fixed costs amortize) — this is not
an algorithmic problem. It is ~1 GB of temporary allocation at the real
project's scale, landing on top of an already-large application baseline and
pushing the renderer past its cap. The symptom is not a clean OOM: V8 simply
never gets ahead of the collector. A merged save ran **30+ minutes without
finishing**.

### The fix

Accumulate directly into typed arrays.

For the 3D tables the row count is knowable in advance, so a counting pre-pass
plus an exactly-sized `Float64Array` works (this is what LUCID's `#185` patch
does: `Float64RowSink` + `createGzipFloatMatrixTyped`).

For the struct tables the member count is only knowable by running the member
generator, so LUCID uses a doubling `Float64GrowSink` + `createMatrixDatasetTyped`
rather than walking twice (`#190`). `instanceGroupMemberRows` also gained an
allocation-free twin, `instanceGroupMemberRowsInto(…, sink)`, that appends
straight into the sink instead of returning boxed rows — 2.6M short-lived arrays
inside a synchronous loop is churn V8 cannot keep up with.

Result at 400,000 groups: peak heap **1,190 → 1,008 MB**, write time
3,767 → 3,285 ms, output bytes unchanged.

**Suggested upstream shape:** a small internal `RowSink` abstraction (fixed-size
when the count is known, doubling otherwise) used by every `/session_data`
writer, with `create*Dataset` taking the sink. This is a pure internal change —
no API or format impact.

---

## 2. `reconstructColumnarFrameGroups` re-boxes an already-typed matrix (memory)

**Marker:** `luc3d #189`
**File:** `chunk-H7G4PJNA.js` (`reconstructColumnarFrameGroups`)
**Severity:** blocks *reopening* a large saved project.

### The problem

This is the exact mirror of #1 on the read side. `sessionData.points3d.flat` is
**already a `Float64Array`** straight from h5wasm. The reader then does:

```js
const points = [];
for (let r = pts3dStart; r < pts3dEnd; r++) {
  const base = r * ncols;
  points.push([
    Number(flat[base]), Number(flat[base + 1]), Number(flat[base + 2])
  ]);
  if (predicted) pointScores.push(Number(flat[base + 3]));
}
instance3d = new Instance3D({ points, skeleton, score });
```

On the real project that allocates **7,976,985 boxed rows (~410 MB)** into the
pointer-compressed heap on **every reopen**, for data that was already contiguous
and typed. Reopening the 1.4 GB project spent 8+ minutes in a GC death spiral at
the ceiling.

### The fix

Emit one compacted `Float64Array(3 * nNodes)` per instance group (and a
`Float64Array(nNodes)` of point scores for the predicted table).

Compacted rather than a `subarray` view of `flat`, for two reasons: the predicted
table is stride 4 (`x,y,z,score`) so a view would interleave scores into the
coordinates, and a view would keep the entire multi-hundred-MB matrix alive for
as long as any single instance group survives.

This changes the observable type of `Instance3D.points`, so it needs a decision
upstream (see **API note** below).

---

## 3. `Instance3D.points` should have one documented representation

**Marker:** `luc3d #189`
**Files:** `chunk-H7G4PJNA.js` (`Instance3D.nVisible`), `chunk-X76PRJK6.js`
(`writeSessions`)

Fix #2 makes the columnar reader produce a flat `Float64Array` while the legacy
`frame_group_dicts` path still produces boxed rows, so consumers must handle
both. LUCID patched the two places in the bundle that iterate it:

- `Instance3D.nVisible` — `points.filter(p => !p.some(Number.isNaN))` assumes
  boxed rows.
- `writeSessions` — its counting pre-pass used `points.length` as a *row* count,
  which over-counts 3× on a flat array and mis-sizes the sink. LUCID added
  `lucidCount3dRows(p)` (`ArrayBuffer.isView(p) ? p.length / 3 : p.length`),
  shared by the pre-pass and the write loop.

**Recommended upstream:** pick one representation and state it in the type.
A flat `Float64Array(3N)` is the better default — it is what the file format
already is, it avoids the boxing on both read and write, and it is what any
numeric consumer wants. If the boxed form must stay for compatibility, expose it
as an accessor (`instance3d.pointAt(k)` / `toRows()`) rather than leaving the
field polymorphic, and make `nVisible` representation-agnostic.

LUCID's own `InstanceGroup.points3d` is a flat `Float64Array(3N)` with an all-NaN
triple meaning "no point", which matches the SLP format's own convention (it
writes NaN, not null, for missing 3D keypoints).

---

## 4. `instances` table is written with a numpy dtype string h5wasm misreads

**Marker:** `sleap-io.js#231`
**File:** `chunk-X76PRJK6.js` (three `create*Dataset` sites)
**Severity:** silent data corruption on large files. **Already filed upstream as
sleap-io.js#231.**

The writer passes `dtype: "<f8"` for the `instances` table. h5wasm does **not**
speak numpy dtype strings — it parses `"<f8"` as **float32**. Above 2^24 point
rows, `point_id_start` / `point_id_end` quantize to even integers, silently
corrupting every instance's node assignment. The real project has 21.7M points,
well past the threshold.

LUCID writes `"<d"` (h5wasm's own float64 spelling) at the three sites that carry
*indices*. `points` / `pred_points` deliberately stay f32 — they hold coordinates
only, and f64 would inflate the file ~50% for no benefit.

**Fix upstream:** use h5wasm's dtype spellings, or normalize numpy-style strings
before handing them to h5wasm. Worth an assertion that index columns round-trip
exactly at >2^24 rows.

---

## 5. `MediaBunnyVideoBackend` builds its frame index in decode order

**Marker:** `luc3d #115`
**File:** `chunk-X76PRJK6.js` (`MediaBunnyVideoBackend.initialize`)
**Severity:** returns the wrong frame's pixels, deterministically.

`initialize()` builds `_frameTimes` by pushing `EncodedPacketSink.packets()`
timestamps in **iteration** order. mediabunny's documentation states `packets()`
yields packets in **decode** order — each packet's `.timestamp` is its true PTS,
but the iteration order is not sorted. For any B-frame-encoded video (routine for
real camera recordings), decode order ≠ presentation order, so `_frameTimes[i]`
is not the i-th frame in playback order and `decodeSingleFrame(i)` looks up the
wrong timestamp.

This is not a race — it is reproducible on a single, non-concurrent step.
Verified against an ffmpeg-generated B-frame video (`-bf 3 -g 10`): **18 of 30
frames (60%) decoded wrong** before the fix, 0 after.

**Fix:** sort `_frameTimes` ascending by timestamp at the end of `initialize()`.
Covered by `tests/e2e/mediabunny-bframe-decode-order.mjs`.

---

## 6. `MediaBunnyVideoBackend` leaks `VideoSample`s

**Marker:** `luc3d #115`
**File:** `chunk-X76PRJK6.js` (`decodeSingleFrame`, `decodeRange`)

Neither path calls `sample.close()` after `sample.toVideoFrame()`, producing
"A VideoSample was garbage collected without first being closed" and eventually
exhausting the WebCodecs frame pool over a long session.

**Fix:** `sample.close()` after converting. Two lines.

---

## Appendix: how these were measured

All figures come from harnesses in `tests/e2e/`, run against real headless
Chrome — none are modelled:

| harness | what it measures |
|---|---|
| `_diag-cage-vs-external.mjs` | that typed-array backing stores escape the ~4 GB cap |
| `_diag-repr-sizing.mjs` | per-object cost of each candidate representation |
| `_diag-instance-size.mjs` | the real `Instance` class, cage vs external |
| `_bench-writesessions.mjs` | `/session_data` writer scaling (the table above) |
| `_bench-save.mjs` | end-to-end save time + settled heap |
| `_real-roundtrip.mjs` | the full pipeline on the real 3.4 GB project |

One caveat worth stating explicitly, because it misled us for a while:
**`performance.memory.usedJSHeapSize` counts typed-array backing stores, but the
~4 GB cap does not apply to them.** Once data moves into typed arrays,
`usedJSHeapSize` stops being a proxy for crash risk and understates the benefit
of exactly the change you want to make.

---

## 7. `openFromFile` takes the WORKERFS branch on the main thread, where it aborts

**File:** `chunk-X76PRJK6.js` (`openFromFile`)
**Severity:** hard abort of the h5wasm module; currently latent for LUCID.

```js
if (fs.mount && fs.filesystems && fs.filesystems.WORKERFS) {
  fs.mount(fs.filesystems.WORKERFS, { files: [file] }, mountPath);   // <-- aborts
  ...
}
const buffer = new Uint8Array(await file.arrayBuffer());             // <-- never reached
fs.writeFile(localPath, buffer);
```

`FS.filesystems.WORKERFS` is **present** on the main thread — it is in the
`filesystems` table regardless — but mounting it there aborts the module.
Measured with `tests/e2e/_diag-h5-mount.mjs`:

```
filesystems : [ "MEMFS", "IDBFS", "WORKERFS" ]
hasWORKERFS : true
mountWorks  : false     Aborted(undefined). Build with -sASSERTIONS for more info.
```

So the guard is testing the wrong thing: availability in the table does not imply
mountability on this thread, and because the `fs.mount(...)` call is not wrapped
in `try`, the buffer fallback below it is unreachable. Any caller that reaches
`openFromFile` from the main thread with a `File` kills the module rather than
falling back.

**Fix:** gate on the execution context (`typeof WorkerGlobalScope !== 'undefined'`)
or wrap the mount in `try/catch` and fall through to the buffer path on failure.
The second is strictly better — it also covers future environments where WORKERFS
exists but refuses a particular file.

Worth noting the fallback is not free either: it copies the whole file into the
WASM heap, which `getHeapMax()` caps at 2 GiB. For a 1.4 GB project that leaves
very little room for anything else, so the WORKERFS path is the one you want to
actually work.
