"""ChArUco boards: the calib.io catalogue, board.toml I/O, and OpenCV objects.

A board is described the anipose / sleap-anipose / calibrat3 way:
``board_x`` squares along the long (x) edge, ``board_y`` squares along y,
``square_length`` and ``marker_length`` in mm, ``marker_bits`` x ``marker_bits``
markers from a ``dict_size`` dictionary. Inner corner ``id`` = row * (board_x - 1) + col,
at ((col + 1) * square, (row + 1) * square, 0) on the board.
"""
from __future__ import annotations

import tomllib
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np

# calib.io ChArUco targets (https://calib.io/products/charuco-targets), prices in USD
# as listed on 2026-10-29 (made to order; shipping and tax extra). Rows x columns there
# = board_y x board_x here. All use DICT_5X5 markers; every catalogue board has an odd
# row count, so the OpenCV 4.6 "legacy" layout change does not affect them.
CALIBIO = {
    # id: (plate mm, pattern, square mm, marker mm, board_x, board_y, price USD, P/N)
    "calibio-200x150-coarse": ((200, 150), "coarse", 15.0, 11.0, 12, 9, 132, "CCT200150C"),
    "calibio-300x200-coarse": ((300, 200), "coarse", 20.0, 15.0, 14, 9, 137, "CCT300200C"),
    "calibio-400x300-coarse": ((400, 300), "coarse", 30.0, 22.0, 12, 9, 153, "CCT400300C"),
    "calibio-600x400-coarse": ((600, 400), "coarse", 40.0, 30.0, 14, 9, 231, "CCT600400C"),
    "calibio-800x600-coarse": ((800, 600), "coarse", 60.0, 45.0, 12, 9, 311, "CCT800600C"),
    "calibio-200x150-fine": ((200, 150), "fine", 7.5, 5.5, 24, 17, 132, "CCT200150F"),
    "calibio-300x200-fine": ((300, 200), "fine", 10.0, 7.0, 28, 17, 137, "CCT300200F"),
    "calibio-400x300-fine": ((400, 300), "fine", 15.0, 11.0, 24, 17, 153, "CCT400300F"),
    "calibio-600x400-fine": ((600, 400), "fine", 20.0, 15.0, 28, 17, 231, "CCT600400F"),
    "calibio-800x600-fine": ((800, 600), "fine", 30.0, 22.0, 24, 17, 311, "CCT800600F"),
    # The 9 x 15 board on DICT_5X5_1000 is not a catalogue size; calib.io makes it as a
    # Custom Target (https://calib.io/products/custom-targets). Two plate options:
    "calibio-custom-9x15-25mm": ((400, 300), "custom", 25.0, 18.75, 15, 9, 206, "CUT400300"),
    "calibio-custom-9x15-38mm": ((600, 400), "custom", 38.0, 28.5, 15, 9, 291, "CUT600400"),
}


# Boards the lab printed itself, for simulations (same tuple layout; no price).
LAB = {
    # charuco_8x11x4.toml: 8 x 11 squares of 24 mm on letter paper (216 x 279 mm)
    "printed-8x11-24mm-4x4": ((216, 279), "printed", 24.0, 18.75, 8, 11, 0, "letter paper"),
}


def plate_info(board_id: str):
    return CALIBIO.get(board_id) or LAB[board_id]


@dataclass
class Board:
    board_x: int
    board_y: int
    square_length: float
    marker_length: float
    marker_bits: int = 5
    dict_size: int = 1000
    legacy: bool = False
    name: str = ""

    @property
    def n_corners(self) -> int:
        return (self.board_x - 1) * (self.board_y - 1)

    @property
    def pattern_mm(self) -> tuple[float, float]:
        return (self.board_x * self.square_length, self.board_y * self.square_length)

    def corner_points(self) -> np.ndarray:
        """(n_corners, 3) ideal inner-corner positions in mm, indexed by corner id."""
        cols = self.board_x - 1
        ids = np.arange(self.n_corners)
        return np.stack([(ids % cols + 1) * self.square_length,
                         (ids // cols + 1) * self.square_length,
                         np.zeros(self.n_corners)], axis=1).astype(np.float64)

    def neighbour_pairs(self) -> np.ndarray:
        """(n_pairs, 2) corner ids one square apart (rows and columns)."""
        cols, rows = self.board_x - 1, self.board_y - 1
        ids = np.arange(self.n_corners).reshape(rows, cols)
        h = np.stack([ids[:, :-1].ravel(), ids[:, 1:].ravel()], 1)
        v = np.stack([ids[:-1, :].ravel(), ids[1:, :].ravel()], 1)
        return np.concatenate([h, v])

    def cv_board(self):
        import cv2
        name = f"DICT_{self.marker_bits}X{self.marker_bits}_{self.dict_size}"
        d = cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, name))
        b = cv2.aruco.CharucoBoard((self.board_x, self.board_y), float(self.square_length),
                                   float(self.marker_length), d)
        if self.legacy:
            b.setLegacyPattern(True)
        return b

    def anipose_board(self):
        from aniposelib.boards import CharucoBoard
        b = CharucoBoard(self.board_x, self.board_y, square_length=self.square_length,
                         marker_length=self.marker_length, marker_bits=self.marker_bits,
                         dict_size=self.dict_size)
        if self.legacy:
            b.board.setLegacyPattern(True)
        return b

    def to_toml(self) -> str:
        lines = ['board_type = "charuco"']
        for k in ("board_x", "board_y", "square_length", "marker_length", "marker_bits", "dict_size"):
            lines.append(f"{k} = {getattr(self, k)}")
        if self.legacy:
            lines.append("legacy = true")
        if self.name:
            lines.append(f'name = "{self.name}"')
        return "\n".join(lines) + "\n"

    def describe(self) -> str:
        return (f"{self.board_x}x{self.board_y} squares, {self.square_length:g} mm squares, "
                f"{self.marker_length:g} mm markers, DICT_{self.marker_bits}X{self.marker_bits}_{self.dict_size}")


def read_board(path: str | Path) -> Board:
    """Read board.toml (keys case-insensitive, units mm or m, as calibrat3 accepts)."""
    d = {k.lower(): v for k, v in tomllib.loads(Path(path).read_text()).items()}
    sq, mk = float(d["square_length"]), float(d["marker_length"])
    if sq < 1:  # metres
        sq, mk = sq * 1000, mk * 1000
    return Board(int(d["board_x"]), int(d["board_y"]), sq, mk, int(d.get("marker_bits", 4)),
                 int(d.get("dict_size", 1000)), bool(d.get("legacy", False)), str(d.get("name", "")))


def catalogue_board(board_id: str) -> Board:
    if board_id in LAB:
        _, _, sq, mk, bx, by, _, _ = LAB[board_id]
        return Board(bx, by, sq, mk, 4, 1000, False, board_id)
    _, _, sq, mk, bx, by, _, _ = CALIBIO[board_id]
    return Board(bx, by, sq, mk, 5, 1000, False, board_id)


def board_image(board: Board, px_per_mm: float, margin_mm: float = 0.0) -> np.ndarray:
    """Render the pattern (uint8) at px_per_mm, with a white margin."""
    w, h = board.pattern_mm
    W, H = int(round((w + 2 * margin_mm) * px_per_mm)), int(round((h + 2 * margin_mm) * px_per_mm))
    m = int(round(margin_mm * px_per_mm))
    img = board.cv_board().generateImage((W - 2 * m, H - 2 * m), marginSize=0, borderBits=1)
    out = np.full((H, W), 255, np.uint8)
    out[m:m + img.shape[0], m:m + img.shape[1]] = img
    return out
