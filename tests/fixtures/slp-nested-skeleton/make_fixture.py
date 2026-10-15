"""Build the four `.slp` files of a per-camera folder whose skeleton entries are
stored in BOTH layouts SLEAP has written, with non-identity global node orders.

`metadata.json.skeletons[0]` is a networkx node-link graph, stored either FLAT
(`{directed, graph, links, multigraph, nodes}`) or, in classic PyQt-SLEAP's
jsonpickled template form, NESTED under `nx_graph`
(`{description, nx_graph: {...}, preview_image}`). Column `i` of the
`points`/`pred_points` tables is the node `metadata.nodes[graph.nodes[i].id]`,
so a reader that misses the nesting falls back to the GLOBAL node order and
names every column after the wrong node, and finds no links.

The real case is a SLEAP 1.2.9 prediction file on the Falkner Lab drive
(`2022-10-07/10072022142111/back/...predictions.slp`): nested, with the global
order below. This fixture reproduces it with the real 15-node mouse skeleton:

    back-nested.slp     NESTED, that file's exact global node order
    mid-flat.slp        FLAT, another global order, same COLUMN order
    side-reordered.slp  FLAT, a DIFFERENT column order (same node names)
    top-renamed.slp     FLAT, one node renamed (`Nose` -> `Snout`)

Every file carries the 14 body edges of the real file plus two symmetric pairs
(each in both directions). Links are written jsonpickle-style: each EdgeType in
full the first time it appears and as `{"py/id": n}` afterwards, so the second
and later symmetries are references only — the form a reader that recognises
only the inline spelling turns into body edges.

Every keypoint's coordinates encode its node NAME, whatever column it sits in:
instance `t` of frame `f` puts node `n` at

    x = 100 * (CANON.index(n) + 1) + 1000 * t,   y = 10 * f + CANON.index(n)

(`Snout` counts as `Nose`), so a test can check name-to-column agreement
directly. Frame 0 also has a user instance (the `points` table), and on frame 2
instance 1's `Tail_2` is missing (NaN). Written by Python sleap-io (genuine
SLEAP compound-dtype tables), then the metadata JSON is rewritten with h5py.

    uv run --with sleap-io --with numpy --with h5py python tests/fixtures/slp-nested-skeleton/make_fixture.py
"""
import json
from pathlib import Path

import h5py
import numpy as np
import sleap_io as sio

HERE = Path(__file__).parent

# Column order of the real file (and of every other camera in that session).
CANON = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0',
         'Tail_1', 'Tail_2', 'Shoulder_left', 'Shoulder_right', 'Haunch_left',
         'Haunch_right', 'Neck']
# The real nested file's GLOBAL `metadata.nodes` order.
REAL_GLOBAL = ['Ear_L', 'TailTip', 'Trunk', 'Haunch_left', 'Tail_1', 'Tail_2', 'Neck',
               'Ear_R', 'Tail_0', 'TTI', 'Haunch_right', 'Shoulder_right', 'Nose',
               'Shoulder_left', 'Head']
# The real file's 14 links, in its order.
BODY = [('TTI', 'Head'), ('TTI', 'Tail_0'), ('TTI', 'Tail_1'), ('TTI', 'Tail_2'),
        ('TTI', 'Haunch_left'), ('TTI', 'Haunch_right'), ('TTI', 'Trunk'),
        ('TTI', 'TailTip'), ('Head', 'Nose'), ('Head', 'Neck'),
        ('Head', 'Shoulder_left'), ('Head', 'Shoulder_right'), ('Head', 'Ear_R'),
        ('Head', 'Ear_L')]
SYMMETRIES = [('Ear_L', 'Ear_R'), ('Ear_R', 'Ear_L'),
              ('Shoulder_left', 'Shoulder_right'), ('Shoulder_right', 'Shoulder_left')]
# Interleaved so the SYMMETRY type is first defined between two body edges.
LINKS = [(BODY[0], 1), (SYMMETRIES[0], 2)] + [(e, 1) for e in BODY[1:]] + [(s, 2) for s in SYMMETRIES[1:]]

N_FRAMES, MISSING = 4, (2, 1, 'Tail_2')   # (frame, instance, node) left NaN


def canon_index(name):
    return CANON.index('Nose' if name == 'Snout' else name)


def write(path, columns, global_order, nested, alias=None):
    skel = sio.Skeleton(nodes=list(columns), name='Skeleton-0')   # it converts the list in place
    video = sio.Video(filename=path.stem + '.mp4', open_backend=False)
    tracks = [sio.Track('track_0'), sio.Track('track_1')]

    def pts(f, t):
        a = np.array([[100.0 * (canon_index(n) + 1) + 1000.0 * t, 10.0 * f + canon_index(n)]
                      for n in columns])
        if (f, t) == MISSING[:2]:
            a[columns.index(MISSING[2])] = np.nan
        return a

    lfs = []
    for f in range(N_FRAMES):
        insts = [sio.PredictedInstance.from_numpy(pts(f, t), skeleton=skel, track=tracks[t],
                                                  point_scores=np.full(len(columns), 0.9), score=0.9)
                 for t in range(2)]
        if f == 0:
            insts.append(sio.Instance.from_numpy(pts(f, 0), skeleton=skel, track=tracks[0]))
        lfs.append(sio.LabeledFrame(video=video, frame_idx=f, instances=insts))
    sio.save_slp(sio.Labels(labeled_frames=lfs, videos=[video], skeletons=[skel], tracks=tracks), str(path))

    # Rewrite the skeleton: global node list in `global_order`, column i -> its
    # global id, links by global id with jsonpickle py/id references.
    gid = {n: i for i, n in enumerate(global_order)}
    seen = {}
    links = []
    alias = alias or {}
    for k, ((src, dst), etype) in enumerate(LINKS):
        src, dst = alias.get(src, src), alias.get(dst, dst)
        if etype in seen:
            t = {'py/id': seen[etype]}
        else:
            seen[etype] = len(seen) + 1
            t = {'py/reduce': [{'py/type': 'sleap.skeleton.EdgeType'}, {'py/tuple': [etype]}]}
        links.append({'edge_insert_idx': k, 'key': 0, 'source': gid[src], 'target': gid[dst], 'type': t})
    graph = {'directed': True, 'graph': {'name': 'Skeleton-0', 'num_edges_inserted': len(links)},
             'links': links, 'multigraph': True, 'nodes': [{'id': gid[n]} for n in columns]}
    with h5py.File(path, 'r+') as h:
        meta = json.loads(h['metadata'].attrs['json'])
        meta['nodes'] = [{'name': n, 'weight': 1.0} for n in global_order]
        meta['skeletons'] = [{'description': 'Template skeleton', 'nx_graph': graph, 'preview_image': None}
                             if nested else graph]
        h['metadata'].attrs['json'] = np.bytes_(json.dumps(meta))
    print(path.name, 'nested' if nested else 'flat', 'columns:', columns[:4], '...')


if __name__ == '__main__':
    rng = np.random.default_rng(7)
    write(HERE / 'back-nested.slp', CANON, REAL_GLOBAL, nested=True)
    write(HERE / 'mid-flat.slp', CANON, [CANON[i] for i in rng.permutation(len(CANON))], nested=False)
    reordered = CANON[::-1]
    write(HERE / 'side-reordered.slp', reordered, [CANON[i] for i in rng.permutation(len(CANON))], nested=False)
    renamed = ['Snout' if n == 'Nose' else n for n in CANON]
    write(HERE / 'top-renamed.slp', renamed, [renamed[i] for i in rng.permutation(len(renamed))], nested=False,
          alias={'Nose': 'Snout'})
