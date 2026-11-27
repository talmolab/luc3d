"""Build `py_written_30_columnar.slp`: a real file in SLP format 3.0.

Python sleap-io 0.10 writes format 3.0 by default: every table is a group of
columns instead of a compound dataset. LUC3D cannot read that layout yet and must
refuse it (`tests/e2e/slp-newer-format.mjs`), because read with the 2.x code it
opens as 0 frames with no error. The file holds one frame with one instance, so a
reader that reports 0 frames is wrong about it.

Run from this folder:

    uv run --with "sleap-io @ git+https://github.com/talmolab/sleap-io@release/0.10" \
        python make_fixture.py

The committed file came from release/0.10 at e5bf2b170 (2026-10-30), and is the
same file as `tests/data/slp/py_written_30_columnar.slp` in sleap-io.js (branch
`fix/refuse-newer-slp-format` on olinesn/sleap-io.js). Point the command at a tag
once sleap-io 0.10 is released.
"""

import numpy as np
import sleap_io as sio

skeleton = sio.Skeleton(nodes=["a", "b"], edges=[("a", "b")])
video = sio.Video(filename="clip.mp4", open_backend=False)
mouse1, mouse2 = sio.Track(name="mouse1"), sio.Track(name="mouse2")
animal = sio.Identity(name="animal_A")

frame = sio.LabeledFrame(
    video=video,
    frame_idx=0,
    instances=[
        sio.Instance.from_numpy(
            np.array([[1.0, 2.0], [3.0, 4.0]]), skeleton=skeleton, track=mouse1
        )
    ],
)

labels = sio.Labels(
    labeled_frames=[frame],
    videos=[video],
    skeletons=[skeleton],
    tracks=[mouse1, mouse2],
    identities=[animal],
    events=[
        sio.UserEvent(
            type=sio.EventType(
                name="attack",
                description="one mouse attacks another",
                metadata={"color": "#e6194b"},
            ),
            video=video,
            start_frame=100,
            end_frame=140,
            subject=mouse1,
            target=mouse2,
            source="manual",
            metadata={"note": "first"},
        ),
        sio.UserEvent(type="rear", video=video, start_frame=50, subject=animal),
        sio.PredictedEvent(
            type="attack",
            video=video,
            start_frame=200,
            end_frame=204,
            subject=mouse2,
            scores=[0.6, 0.8, 0.9, 0.7, 0.5],
            score=0.74,
            source="classifier",
        ),
    ],
)
labels.save("py_written_30_columnar.slp", embed=False)
print("wrote py_written_30_columnar.slp")
