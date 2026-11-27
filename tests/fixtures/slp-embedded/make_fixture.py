"""Build the `.slp` files with embedded images for `tests/e2e/slp-embedded-images.mjs`.

Every image is a 2x2 grey PNG of one value, so a test reads a pixel and knows
exactly which video and frame it is looking at.

    two_sessions.pkg.slp    two sessions of two cameras each, with their own
                            calibration, images stored as fixed-width rows.
                            Session 1's first labeled frame has no image.
    mixed_external.pkg.slp  one embedded video and one external video.
    images_only.pkg.slp     images and no labels at all, stored as variable-length
                            uint8 rows, with no width or height attribute, and a second
                            video with no images. Neither names a source video.
    raw_pixels.pkg.slp      uncompressed pixels: a grey video whose last pixel is 0, with
                            no format attribute, and a colour one with format "hdf5" that
                            says BGR, which Python ignores for these.
    flat_no_sizes.pkg.slp   all images in one run of bytes and no `frame_sizes`, as
                            sleap-io.js wrote them before March 2026.
    image_sequence.pkg.slp  a video whose source is an image sequence: its file name is
                            a list of its images. Python 0.9.5 can't open this one, nor
                            the sleap-io.js fixture with the same layout
                            (`spilled_source_video.pkg.slp`).
    colors.pkg.slp          colour images, one video stored BGR and one RGB (says so).
    colors_old_format.pkg.slp  colour images, format 1.2: BGR, and does not say so.

The other two files here are copies from sleap-io.js `tests/data/slp`:
`minimal_instance.pkg.slp` is a real SLEAP package (variable-length int8 rows, the
real file's 384x384 image), and `out_of_order_embedded.pkg.slp` has fixed-width rows
and video groups numbered out of list order (its generator is beside the original).

Written with h5py alone, then checked against Python sleap-io (the contract the
readers must match):

    uv run --no-project --python 3.12 --with "sleap-io==0.9.5" --with h5py --with numpy \
        python tests/fixtures/slp-embedded/make_fixture.py
"""
import json
import struct
import zlib
from pathlib import Path

import h5py
import numpy as np

HERE = Path(__file__).resolve().parent
STR = h5py.string_dtype()
HEIGHT, WIDTH = 2, 2

SKELETON = {
    "directed": True,
    "graph": {"name": "mouse", "num_edges_inserted": 1},
    "links": [
        {
            "edge_insert_idx": 0,
            "key": 0,
            "source": 0,
            "target": 1,
            "type": {"py/reduce": [{"py/type": "sleap.skeleton.EdgeType"}, {"py/tuple": [1]}]},
        }
    ],
    "multigraph": True,
    "nodes": [{"id": 0}, {"id": 1}],
}
METADATA = {
    "version": "2.0.0",
    "skeletons": [SKELETON],
    "nodes": [{"name": "head"}, {"name": "tail"}],
    "videos": [],
    "tracks": [],
    "suggestions": [],
    "negative_anchors": {},
    "provenance": {},
}
POINT = np.dtype([("x", "f8"), ("y", "f8"), ("visible", "?"), ("complete", "?")])
PRED_POINT = np.dtype(POINT.descr + [("score", "f8")])
INSTANCE = np.dtype(
    [
        ("instance_id", "i8"),
        ("instance_type", "u1"),
        ("frame_id", "u8"),
        ("skeleton", "u4"),
        ("track", "i4"),
        ("from_predicted", "i8"),
        ("score", "f4"),
        ("point_id_start", "u8"),
        ("point_id_end", "u8"),
        ("tracking_score", "f4"),
    ]
)
FRAME = np.dtype(
    [
        ("frame_id", "u8"),
        ("video", "u4"),
        ("frame_idx", "u8"),
        ("instance_id_start", "u8"),
        ("instance_id_end", "u8"),
    ]
)


def png(value) -> bytes:
    """A 2x2 PNG with every pixel `value`: grey, or colour for an (r, g, b) tuple."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    colour = isinstance(value, tuple)
    pixel = bytes(value) if colour else bytes([value])
    scanlines = b"".join(b"\x00" + pixel * WIDTH for _ in range(HEIGHT))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 2 if colour else 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(scanlines))
        + chunk(b"IEND", b"")
    )


def raw_pixels() -> None:
    with h5py.File(HERE / "raw_pixels.pkg.slp", "w") as f:
        begin(f, {**METADATA, "skeletons": [], "nodes": []})
        grey = np.full((1, HEIGHT, WIDTH, 1), 77, dtype="u1")
        grey[0, HEIGHT - 1, WIDTH - 1, 0] = 0
        colour = np.empty((1, HEIGHT, WIDTH, 3), dtype="u1")
        colour[0, :, :] = (10, 20, 30)
        entries = []
        for group, pixels, order, source in (("video0", grey, "RGB", "grey.mp4"), ("video1", colour, "BGR", "colour.mp4")):
            g = f.create_group(group)
            d = g.create_dataset("video", data=pixels)
            if group != "video0":
                d.attrs["format"] = "hdf5"
            d.attrs["channel_order"] = order
            g.create_dataset("frame_numbers", data=np.array([4], dtype="i8"))
            source_video = {"filename": source, "backend": {"filename": source, "shape": [20, *pixels.shape[1:]]}}
            g.create_group("source_video").attrs["json"] = json.dumps(source_video)
            entries.append(
                json.dumps(
                    {
                        "filename": ".",
                        "backend": {
                            "type": "HDF5Video",
                            "shape": list(pixels.shape),
                            "filename": ".",
                            "dataset": f"{group}/video",
                            "input_format": "channels_last",
                            "convert_range": False,
                            "has_embedded_images": True,
                            "grayscale": pixels.shape[3] == 1,
                            "fps": None,
                        },
                        "source_video": source_video,
                    }
                )
            )
        strings(f, "videos_json", entries)
        strings(f, "tracks_json", [])
        strings(f, "suggestions_json", [])
        tables(f, [])


def embed(f, group, images, source, variable_length=False, flat=False, channels=1, channel_order="RGB") -> str:
    """Write one embedded video; returns its `videos_json` entry."""
    # (A variable-length or flat video here also leaves its size for the reader to find.)
    blobs = [png(value) for value in images.values()]
    g = f.create_group(group)
    if flat:
        d = g.create_dataset("video", data=np.frombuffer(b"".join(blobs), dtype="u1"))
    elif variable_length:
        d = g.create_dataset("video", shape=(len(blobs),), maxshape=(None,), dtype=h5py.vlen_dtype(np.uint8))
        for row, blob in enumerate(blobs):
            d[row] = np.frombuffer(blob, dtype="u1")
    else:
        rows = np.zeros((len(blobs), max(len(blob) for blob in blobs)), dtype="i1")
        for row, blob in enumerate(blobs):
            rows[row, : len(blob)] = np.frombuffer(blob, dtype="i1")
        d = g.create_dataset("video", data=rows)
    d.attrs["format"] = "png"
    if channel_order:
        d.attrs["channel_order"] = channel_order
    if not (variable_length or flat):
        d.attrs["height"] = HEIGHT
        d.attrs["width"] = WIDTH
    d.attrs["channels"] = channels
    g.create_dataset("frame_numbers", data=np.array(list(images), dtype="i8"))
    entry = {
        "filename": ".",
        "backend": {
            "type": "HDF5Video",
            "shape": [len(images), HEIGHT, WIDTH, channels],
            "filename": ".",
            "dataset": f"{group}/video",
            "input_format": "channels_last",
            "convert_range": False,
            "has_embedded_images": True,
            "grayscale": channels == 1,
            "fps": None,
        },
    }
    if source:
        if isinstance(source, list):  # an image sequence, as Python writes a long one
            source_video = {"filename": source, "backend": {"type": "ImageVideo", "shape": [20, HEIGHT, WIDTH, 1], "grayscale": True}}
            g.create_group("source_video").create_dataset("json", data=np.bytes_(json.dumps(source_video)))
        else:
            source_video = {"filename": source, "backend": {"filename": source, "shape": [20, HEIGHT, WIDTH, 1]}}
            g.create_group("source_video").attrs["json"] = json.dumps(source_video)
        entry["source_video"] = source_video
    return json.dumps(entry)


def external(filename: str) -> str:
    """The `videos_json` entry of a video that is not in the file."""
    return json.dumps(
        {
            "filename": filename,
            "backend": {
                "type": "MediaVideo",
                "shape": [20, HEIGHT, WIDTH, 1],
                "filename": filename,
                "grayscale": True,
                "bgr": False,
                "dataset": "",
                "input_format": "",
            },
        }
    )


def tables(f, labeled) -> None:
    """One user instance on each `(video list index, frame_idx)`, at distinct points."""
    points, instances, frames = [], [], []
    for i, (video, frame_idx) in enumerate(labeled):
        points += [(1.0 + i, 2.0 + i, True, True), (3.0 + i, 4.0 + i, True, True)]
        instances.append((i, 0, i, 0, -1, -1, 0.0, 2 * i, 2 * i + 2, 0.0))
        frames.append((i, video, frame_idx, i, i + 1))
    f.create_dataset("points", data=np.array(points, dtype=POINT))
    f.create_dataset("pred_points", data=np.zeros(0, dtype=PRED_POINT))
    f.create_dataset("instances", data=np.array(instances, dtype=INSTANCE))
    f.create_dataset("frames", data=np.array(frames, dtype=FRAME))


def begin(f, metadata=METADATA, format_id=1.4) -> None:
    grp = f.create_group("metadata")
    grp.attrs["format_id"] = format_id
    grp.attrs["json"] = np.bytes_(json.dumps(metadata, separators=(",", ":")))


def strings(f, name: str, values) -> None:
    f.create_dataset(name, data=values, dtype=STR, maxshape=(None,))


def calibration(names) -> dict:
    cal = {
        str(i): {
            "name": name,
            "size": [WIDTH, HEIGHT],
            "matrix": [[100.0, 0.0, 1.0], [0.0, 100.0, 1.0], [0.0, 0.0, 1.0]],
            "distortions": [0.0, 0.0, 0.0, 0.0, 0.0],
            "rotation": [0.1 * i, 0.2, 0.3],
            "translation": [10.0 * i, 5.0, 300.0],
        }
        for i, name in enumerate(names)
    }
    cal["metadata"] = {}
    return cal


def session(names, videos) -> str:
    return json.dumps(
        {
            "calibration": calibration(names),
            "camcorder_to_video_idx_map": {str(i): str(v) for i, v in enumerate(videos)},
            "frame_group_dicts": [],
        }
    )


def two_sessions() -> None:
    with h5py.File(HERE / "two_sessions.pkg.slp", "w") as f:
        begin(f)
        videos = [
            embed(f, "video0", {3: 30, 8: 31}, None),
            embed(f, "video1", {8: 32}, None),
            embed(f, "video2", {6: 50}, None),
            embed(f, "video3", {6: 51, 12: 52}, None),
        ]
        strings(f, "videos_json", videos)
        strings(f, "tracks_json", [])
        strings(f, "suggestions_json", [])
        strings(f, "sessions_json", [session(["north", "south"], [0, 1]), session(["east", "west"], [2, 3])])
        # Session 1's first labeled frame (1) has no image; session 2 has labels on 6.
        tables(f, [(0, 1), (0, 8), (1, 8), (2, 6)])


def mixed_external() -> None:
    with h5py.File(HERE / "mixed_external.pkg.slp", "w") as f:
        begin(f)
        strings(f, "videos_json", [embed(f, "video0", {2: 70}, "inside.mp4"), external("outside.mp4")])
        strings(f, "tracks_json", [])
        strings(f, "suggestions_json", [])
        strings(f, "sessions_json", [])
        tables(f, [(0, 2), (1, 4)])


def images_only() -> None:
    with h5py.File(HERE / "images_only.pkg.slp", "w") as f:
        begin(f, {**METADATA, "skeletons": [], "nodes": []})
        videos = [embed(f, "video0", {10: 80, 20: 81}, None, variable_length=True), embed(f, "video1", {}, None, variable_length=True)]
        strings(f, "videos_json", videos)
        strings(f, "tracks_json", [])
        strings(f, "suggestions_json", [])
        tables(f, [])


def flat_no_sizes() -> None:
    with h5py.File(HERE / "flat_no_sizes.pkg.slp", "w") as f:
        begin(f, {**METADATA, "skeletons": [], "nodes": []})
        strings(f, "videos_json", [embed(f, "video0", {2: 90, 5: 91, 9: 92}, None, flat=True)])
        strings(f, "tracks_json", [])
        strings(f, "suggestions_json", [])
        tables(f, [])


def image_sequence() -> None:
    with h5py.File(HERE / "image_sequence.pkg.slp", "w") as f:
        begin(f)
        names = ["seq/frame_00000.png", "seq/frame_00001.png", "seq/frame_00002.png"]
        strings(f, "videos_json", [embed(f, "video0", {1: 95}, names)])
        strings(f, "tracks_json", [])
        strings(f, "suggestions_json", [])
        tables(f, [(0, 1)])


def colors() -> None:
    with h5py.File(HERE / "colors.pkg.slp", "w") as f:
        begin(f, {**METADATA, "skeletons": [], "nodes": []})
        videos = [
            embed(f, "video0", {0: (10, 20, 30)}, "stored_bgr.mp4", channels=3, channel_order="BGR"),
            embed(f, "video1", {0: (10, 20, 30)}, "stored_rgb.mp4", channels=3, channel_order="RGB"),
        ]
        strings(f, "videos_json", videos)
        strings(f, "tracks_json", [])
        strings(f, "suggestions_json", [])
        tables(f, [])
    with h5py.File(HERE / "colors_old_format.pkg.slp", "w") as f:
        begin(f, {**METADATA, "skeletons": [], "nodes": []}, format_id=1.2)
        strings(f, "videos_json", [embed(f, "video0", {0: (10, 20, 30)}, None, channels=3, channel_order=None)])
        strings(f, "tracks_json", [])
        strings(f, "suggestions_json", [])
        tables(f, [])


def check() -> None:
    import sleap_io as sio

    labels = sio.load_slp(str(HERE / "two_sessions.pkg.slp"))
    assert [v.backend.dataset for v in labels.videos] == [f"video{i}/video" for i in range(4)]
    assert [(labels.videos.index(lf.video), lf.frame_idx) for lf in labels.labeled_frames] == [
        (0, 1),
        (0, 8),
        (1, 8),
        (2, 6),
    ]
    assert len(labels.sessions) == 2
    assert [c.name for c in labels.sessions[1].cameras] == ["east", "west"]
    assert int(np.asarray(labels.videos[3][12]).ravel()[0]) == 52

    labels = sio.load_slp(str(HERE / "mixed_external.pkg.slp"))
    assert [v.filename for v in labels.videos][1] == "outside.mp4"
    assert labels.videos[0].backend.dataset == "video0/video"
    assert int(np.asarray(labels.videos[0][2]).ravel()[0]) == 70

    with h5py.File(HERE / "images_only.pkg.slp") as f:
        assert h5py.check_dtype(vlen=f["video0/video"].dtype) == np.uint8
        assert f["video0/frame_numbers"][()].tolist() == [10, 20]
    assert len(sio.load_slp(str(HERE / "images_only.pkg.slp")).labeled_frames) == 0

    with h5py.File(HERE / "image_sequence.pkg.slp") as f:
        assert json.loads(f["video0/source_video/json"][()])["filename"][1] == "seq/frame_00001.png"

    # Uncompressed pixels, as Python reads them.
    video = sio.load_slp(str(HERE / "raw_pixels.pkg.slp")).videos
    assert np.asarray(video[0][4])[1, 1, 0] == 0 and np.asarray(video[0][4])[0, 0, 0] == 77
    assert np.asarray(video[1][4])[0, 0].tolist() == [10, 20, 30], "shown as stored, BGR or not"

    # Colours as Python itself returns them: the rule the viewer has to match.
    video = sio.load_slp(str(HERE / "colors.pkg.slp")).videos
    assert np.asarray(video[0][0])[0, 0].tolist() == [30, 20, 10], "stored BGR"
    assert np.asarray(video[1][0])[0, 0].tolist() == [10, 20, 30], "stored RGB"
    video = sio.load_slp(str(HERE / "colors_old_format.pkg.slp")).videos
    assert np.asarray(video[0][0])[0, 0].tolist() == [30, 20, 10], "format 1.2 with no attribute: BGR"


if __name__ == "__main__":
    two_sessions()
    mixed_external()
    images_only()
    flat_no_sizes()
    image_sequence()
    colors()
    raw_pixels()
    check()
    for path in sorted(HERE.glob("*.slp")):
        print(path.name, path.stat().st_size, "bytes")
