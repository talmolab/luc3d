# Panel A: acquisition-room figure — checkpoint

*Written August 13, 2026. Companion to `../../HANDOFF.md`, which covers the science text,
budget, and mechanism. This file covers only the figure pipeline.*

**Status: Panel A renders and is close to final.** Panels B and C are not started, and the
~400-word section text is not written.

Current render: `panelA_current.png`. Regenerate with the command in §2.

---

## 1. What the panel shows

Isometric two-wall cutaway of a **4.2 × 4.2 × 2.55 m** behavioral testing room:

- **8 machine-vision cameras** — 4 on two ceiling truss rails, 4 on wall brackets. Every one
  mounts to geometry the figure actually draws.
- **A 9th camera in the wall corner at 0.55 m**, dog head height, on a short bracket. This
  replaced a floor tripod, which put a stand inside the animal's space.
- **Sync/data path** in vermilion: a jumper from each camera to the truss, one run along the
  truss, one drop into the acquisition rack. Drawn as a single path because the point is that
  one timebase reaches every sensor.
- **Dog**: D-SMAL mean shape, facing the experimenter with its muzzle raised toward them.
- **Experimenter**: SMPL body, standing, arm extended in a "wait"/stay gesture toward the dog.
  Rendered flat blue, untextured.

Both figures' headings are **computed, not hand-tuned** — see §5, "Mutual facing".

The dog's upward gaze is a **local mesh deformation, not a rigged pose**: `tilt_head()` in
`panelA.py`. `HEAD_PITCH = 26` deg; tune with `--head-pitch`. 26° reads as attentive, 40°
starts to look like a howl. Must run before `place_mesh` applies heading, while the dog still
faces +X, and it touches only x and z — pure pitch, no lateral change. The full D-SMAL `.pkl`
would allow a proper LBS pose if more articulation is ever wanted, but that is a lot of
machinery for one joint.

**It is an arc bend, and it has to be.** The first version rotated each vertex about a fixed
pivot by a smoothstep-weighted angle. That moves vertices along *chords*, so the neck axis came
out shorter than it started and the ventral side bunched — a visibly squashed neck. The current
version re-parameterises the neck axis onto a circular arc of radius `R = L/theta`, which
preserves its arc length exactly, with the head forward of the bend riding along rigidly.
`dog_neck_profile.png` is a side view for checking this; regenerate with
`./bpyenv/bin/python dogonly.py 26`.

## 2. How to run

```bash
cd <this directory>
uv venv --python 3.13 bpyenv
uv pip install --python bpyenv/bin/python bpy numpy scipy pillow
./bpyenv/bin/python panelA.py --dog dsmal --face --res 2600 --samples 220 --out panelA_final
```

**`scipy` is not optional.** The D-SMAL `.pkl` stores `J_regressor` as a
`scipy.sparse.csr_matrix`, so `dogface.py` fails at unpickle time without it — and the
failure is a bare `ModuleNotFoundError` well after argument parsing, which does not
look like a dependency problem. `pillow` is only for contact sheets.

`rig.py` holds parametric geometry (room, truss, camera units, sync path, rack). `panelA.py`
is the render pass: materials, lighting, asset import, staging, camera.

Useful flags: `--style flat` (Freestyle line art instead of shaded render) · `--dog
dsmal|mujoco|shiba|beagle|gsd` · `--human smpl|quaternius` · `--fov` (view volumes, off by
default, see §6) · `--harness` (telemetry band on the dog, off) · `--no-lines`.

**Asset paths were repointed at `assets/` on August 13, 2026** (the old `hunt/`, `dogtest/`,
`humantest/` scratchpad prefixes are gone from `panelA.py`, `dogface.py`, and `sit.py`).
Verified end-to-end: a clean `bpyenv` on bpy 5.2.0 LTS / CPython 3.13 renders Panel A from the
grant folder and reproduces `panelA_current.png`. Cycles reports the GPU as
`Apple M5 Max (GPU - 40 cores)`; a 1100 px / 48-sample frame takes 7.8 s.

### Performance

| | |
|---|---|
| EEVEE, 1600 px | ~3 s |
| Cycles GPU, 2600 px / 220 samples | ~13 s |
| Cycles GPU with volumetrics | ~78 s |
| First Cycles GPU render, ever | **~63–106 s of one-time Metal kernel compilation** |

That last row matters: a single cold benchmark makes Metal look 100× slower than CPU. Kernels
persist on disk across processes. Burn one throwaway render before timing anything.

## 3. Assets and provenance

Everything is under `assets/`.

**Dog — D-SMAL mean shape (used).** `assets/dsmal/39dogsnorm_newv3_dog_mean.obj`, 3,889
vertices / 7,774 faces. This is the genuine canine parametric shape model from BITE (Rüegg et
al., CVPR 2023), fetched from the author's own HuggingFace Space. The full model is alongside
it as `my_smpl_39dogsnorm_newv3_dog.pkl` (37 MB) with a 78-dimensional shape space, a 35-joint
kinematic tree, and LBS weights — so it is fully posable if a later panel needs that.

**Verified bit-exact:** `v_template` exported from the `.pkl` matches the mean OBJ with max
per-vertex difference **0.000000**. So the caption may state that the figure shows the mean
shape of a canine parametric shape model, exactly, not approximately.

*Note the official `smal.is.tue.mpg.de` download and the BITE/BARC owncloud links are all
dead or gated; the HuggingFace Space mirrors are what work.*

**Dog — dm_control / MuJoCo (alternative).** `assets/anat_dmcontrol_SKINbody.stl`, 16,952
verts. Anatomically excellent and the cleanest small-size silhouette of everything tested.
Use it if D-SMAL's 3.9k faceting ever shows. Its `.xml` is alongside.

**Human — SMPL (used).** `assets/human/SMPL_stay_lean.obj`, 6,531 verts, posed standing with
the right arm extended in a stay gesture, head already replaced with a smooth ovoid via the
model's own skinning weights.

**Use a lean shape, not the default.** SMPL's `betas=0` is the population *mean* body — soft
and slightly heavyset, and it read oddly for an experimenter at panel size. `beta[0]` is height
and `beta[1]` is slimness (positive = leaner); `betas=[1.0, 2.0]` gives the 1.83 m lean adult
used here. `SMPL_stay_slim.obj` and `SMPL_stay_athletic.obj` are alternatives, and
`render_smpl_stay_lean_450px.png` shows the chosen one at true print size — **always judge these
at 450 px, not at 1400 px**, because the differences that matter invert with scale.

Also present: `smpl_neutral_arrays.npz` (the whole model as plain numpy, no chumpy needed),
`SMPL_neutral_template.obj`, `SMPL_tpose.obj`, and — most reusable — `extract_smpl.py` and
`pose_smpl.py`, a **pure-numpy SMPL forward-kinematics and LBS implementation** with no torch,
no chumpy, and no `smplx` package. Any new pose or body shape can be generated from those two
files alone. `mhr_lod3_stay.obj` (Meta's MHR, 4,899 verts) is there as an alternative.

Both SMPL and SMPL-X were obtained from public HuggingFace mirrors with no registration; the
official MPI-IS registration route is documented in the workflow output if a canonical copy is
ever wanted.

**Rejected.** Quaternius CC0 game-art dogs and human (4.7k verts) — the human was the single
worst thing in the panel. The Quaternius German Shepherd additionally wears a saddlebag that
reads as a sensor harness at small size.

## 3b. Face sub-panel — `dogface.py`

`dogface_keypoints.png` (2600 px) and `dogface_keypoints_4k.png` (4000 px): near-frontal view
of the dog's face with **41 colour-coded facial keypoints**, transparent background, for
compositing into a sub-panel. Groups: muzzle/lips (red, 13) · eyes and lids (yellow, 8) ·
cranium and brow (violet, 7) · ears (teal, 8) · jaw, cheek and throat (green, 5).

```bash
# current best — real fur, derived landmarks, ~55 s at 2600 px
./bpyenv/bin/python dogface.py --shade coat --fur --ears 45 \
    --eye-r 0.018 --nose-r 0.042 --res 2600 --samples 420 --out dogface_v3
```

Flags: `--jaw 17` `--ears 13` `--smile 1.0` `--dist 2.25` `--subdiv 3` `--no-keypoints`
`--no-eyes` `--no-tongue`. `kpcheck.py` prints where each keypoint snaps and probes the head
surface — run it before moving any landmark.

**On sharpness.** Output resolution was never the limit; render at whatever size you need. The
softness in the first version had two unrelated causes, both now fixed:

1. **The coat pattern is a per-vertex colour attribute, so it cannot be sharper than the mesh.**
   At 1,316 head verts (~1 cm spacing) the muzzle-mask edge was linearly interpolated across
   whole faces. The mesh is now Catmull-Clark subdivided and **baked** (`--subdiv 3`, 1,316 →
   125,185 verts) *before* the colours are evaluated, which sharpens the mask and also cleans up
   the faceted ear and skull silhouettes. Note the order matters: subdividing *after* writing
   colours just interpolates them more smoothly and sharpens nothing.
2. **Depth of field at f/3.6** was defocusing the ears and the back of the skull, which read as
   general softness rather than depth. Now f/6.3.

The fur bump is procedural, so it is evaluated per shading point and is resolution-independent —
it was never a contributor. Its scale and strength were raised (620 / 0.48) now that the rest is
crisp enough to show it.

**Marker seating.** Keypoints are offset along the **posed vertex normal** (`vertex_normals()`),
not radially from a guessed head centre. Radial offset is nearly tangent to the thin ear plates,
and subdivision pulls the rendered surface inward from the control cage, so markers placed on the
cage sank into the ears. Marker radius is 0.0068 in model units.

**Built from the `.pkl`, not the OBJ**, because the model file carries the skinning weights
and joint positions. That buys two things the OBJ cannot: the happy-face pose is a real
single-joint LBS rotation, and keypoints snap to anatomy on the *rest* mesh and are then read
off the *posed* mesh, so they track the pose. Note the `.pkl` `v_template` is **Z-up** while
the exported OBJ is Y-up, so this script needs no axis correction.

**D-SMAL has explicit jaw and ear joints** — j32 (jaw), j33/j34 (ears), all children of j16
(head), with j15 the neck. So the happy face is: jaw opened 17°, ears tilted forward 13°, and
lip corners drawn back and up with a smooth radial falloff (the relaxed open-mouth "play
face"). Plus a dark mouth cavity and a tongue, which is the single strongest happy-dog cue.

**Corrected August 14, 2026 — the earlier claim here was wrong.** This section used to say
"D-SMAL has no eyeballs… two dark spheres are placed at the measured eye position… the head
surface at eye height is at |y| ≈ 0.139." **D-SMAL does model the palpebral fissure**: a real
lens-shaped lid aperture with a rim crease and distinct medial and lateral canthi. What it
lacks is an *eyeball* inside that aperture. The |y| ≈ 0.139 measurement found the lateral
skull wall, not the eye, so the spheres went on the *side of the head* — the herbivore eye
configuration, and the single largest reason the panel read as a calf rather than a dog.

**Why the error was invisible.** Under the diffuse clay/fur shading the fissure is a barely
perceptible dimple. Under `--shade normal` it is unmistakable. That is the one solid use for
the normals mode §3c otherwise rejects: **it is the diagnostic, not the panel.**

**Corrected placement** (rest-mesh coordinates, mirrored in y):

| | Old | New |
|---|---|---|
| eyeball centre | 1.116, ±0.118, 0.158 | **1.177, ±0.087, 0.152** (vertex 713) |
| eyeball radius | 0.025 | **0.021** |
| \|y\| as fraction of head half-width | 0.43 | **0.32** |

Now `--eye-pos` and `--eye-r`. The old radius was sized to read as an eye pasted on a flat
wall; seated in the real aperture 0.017 goes beady and 0.021 holds at sub-panel size.

**`--probe "x,y,z; x,y,z"`** places numbered high-contrast markers at model coordinates. This
is how the fissure was located, and it is the tool to use for any further landmark work.
`kpcheck.py` tells you where a landmark snaps; `--probe` shows you. **A numeric concavity
detector was tried first and found a nasal fold, not the eye** — so probe visually, and do not
trust a curvature score on a mesh this coarse (~1 cm vertex spacing at the orbit, which is why
several distinct probe targets collapse onto the same vertex).

**Superseded August 14, 2026.** The whole landmark set is now derived from the mesh by
`derive_landmarks.py` (§3f) rather than hand-typed, which is what finally fixed the eye
points. **DogFLW was investigated as the reference scheme and deliberately dropped**: its
46-landmark definitions live in a figure and a supplementary spreadsheet, not in the paper
text, and neither the arXiv version, the Scientific Reports full text, nor the GitHub repo
reproduces them. Chasing exact DogFLW parity is not worth it for a TR01 figure — the set
needs to look anatomically right, not to be citable as a landmark standard. Do not describe
the panel's scheme as DogFLW-compliant.

Eyeball geometry is also superseded — see §3g, which carves an actual socket.

**One addition the model genuinely does not provide.** The mesh is trimmed to head + jaw +
ears + neck stub, because the shoulder was intruding into the lower-left of a panel that is
supposed to be a face.

**Removing the added geometry entirely was tested and is worse.** `--no-eyes` alone leaves the
face reading blank at sub-panel size, because the model's own lids are nearly invisible in
diffuse shading. `--no-eyes --no-tongue` additionally turns the open jaw into a hollow dark
void; if the bare model is ever wanted, close the jaw too (`--jaw 0`). The mouth cavity and
tongue are doing real work.

**Coat colour is computed per-vertex in numpy, not procedurally.** A Texture Coordinate →
SeparateXYZ → MapRange → ColorRamp chain rendered flat grey: the factor sat mid-ramp everywhere,
so both the tonal variation and the dark muzzle mask were invisible. `coat_colors()` instead
derives a dark muzzle mask, a pale chin, faint brow marks, and fine tonal break-up directly from
vertex position, and writes them to a `FLOAT_COLOR` point attribute read by a Attribute node.

**A colour attribute is consumed as LINEAR.** Authoring those values as sRGB display numbers
made the dark muzzle (0.14 sRGB) arrive as 0.14 linear ≈ 0.40 sRGB and render as mid-brown, so
the mask looked absent even once the plumbing was right. `coat_colors()` converts on the way
out. An earlier Mix node addressed by socket **index** (6/7) also silently failed to connect —
prefer named sockets or single-input Math chains.

### 3c. Surface treatment, and why it is not the coat — August 13, 2026

`--shade coat|normal|clay`. Keypoints, eyes, tongue and mouth keep their own materials
in every mode, because the keypoint colours are the legend.

**`normal` was tried and rejected.** Shading by the camera-space surface normal is the
technically honest answer to "the coat carries no information and cannot out-resolve
the mesh" — and the field even supports it, since DogWeave (arXiv 2026) reconstructs
canine geometry by *normal* fusion. It still fails here, structurally: a normal render
spends the entire hue circle on the surface, and this panel's legend is 41 colour-coded
keypoints. Red markers disappear on the magenta ear, green on the green skull, teal on
cyan. Gamma tuning changes how garish it is, not whether the legend survives. Kept
behind `--shade normal` as a geometry diagnostic only.

**`clay`** — neutral matte surface, same lighting rig describing the form, fur bump
retained, no coat pattern. Every keypoint colour reads cleanly. Superseded as the
default by `--fur` (§3e), but still the cleanest option when markers must dominate.

**Revisited August 14, 2026, after the geometry was fixed.** Comparison sheet:
`shapesweep/NORMALS_COMPARE.png`.

*Normals on the bare geometry is now much better than the first verdict allowed.* With
the ears at 45°, the eyeballs in the real fissure and a black rhinarium anchoring the
muzzle, the form reads, the dog reads, and the surface spans mostly a green-to-magenta
sweep rather than the full hue circle. It has genuine graphic presence and holds up at
sub-panel size. The keypoint conflict is reduced but **not** gone — red markers still
collide with the magenta muzzle flanks and green ones with the green forehead. Using it
as the panel would mean abandoning coloured markers for something achromatic with dark
outlines, or moving the legend out to leader lines.

**Resolved August 14, 2026: `--normal-style mono|duotone` + `--kp-style`.** Comparison
sheet: `shapesweep/NORMALS_PANEL.png`. Two independent fixes, both of which work:

- **`mono` / `duotone` spend only LIGHTNESS on the normal.** The facing term is what
  describes the form; the other two channels are what make an RGB normal map garish and
  are also exactly what collides with the marker colours. Ramping facing into a pearl
  grey (`mono`) or a cool-shadow/warm-light pair (`duotone`) keeps the normal as the
  quantity being shown and leaves the entire hue circle free for the legend. **This is
  the recommended panel treatment** — `duotone` reads best.
- **`--kp-style achromatic` gives near-white beads with a dark Fresnel rim**, which
  survive against full RGB normals. The rim is what does the work: a dark edge that
  tracks viewing angle is a local contrast boundary, so it separates the bead from any
  background, where a flat white bead vanishes into the pale facing highlights just as a
  red one vanishes into the magenta flank. `auto` selects this under `rgb` normals.

**Take the facing term as an explicit `DOT_PRODUCT` of the normal with `Incoming`, never
as a component of the camera-space vector.** The first mono/duotone attempt read
camera-space Z and rendered a completely flat silhouette. This build's CAMERA space is
not the Y-up / −Z-forward convention — which the rgb render had already been saying, by
coming out green-dominant instead of the familiar blue-dominant. The dot product has no
convention to get wrong.

**Caption precision:** `mono`/`duotone` show the surface normal's relationship to the
view direction, not the normal vector's components. Call it normal-derived shading of the
recovered surface, not a normal map.

**Current panel: `dogface_normals_dense.png` — duotone normals, colour markers, 84
landmarks** (10 midline + 37 mirrored pairs), all derived by `derive_landmarks.py`.

```bash
./bpyenv/bin/python derive_landmarks.py            # regenerate the KEYPOINTS block
./bpyenv/bin/python dogface.py --shade normal --normal-style duotone --ears 45 \
    --eye-r 0.018 --nose-scale 0.82 --res 2600 --samples 420 --out dogface_normals_dense
```

Three things density exposed, all fixed:

- **Sample the eye as an ELLIPSE, not a circle.** The palpebral fissure is an almond
  about 2:1. Eight markers on a fixed-radius circle sit well above and below the lid
  margin and close into a daisy around the eyeball — the "flower stuck on the face"
  failure. The local patch's own SVD axes already align with the aperture, so an ellipse
  at `aspect=0.52` traces the lid instead.
- **Walk the ear outline by ARC LENGTH, not by hull index.** `plate_outline()` projects
  the pinna to its best-fit plane and takes the 2D convex hull; hull vertices bunch where
  the outline curves, so indexing them directly clusters markers at the tip.
- **Dedupe by vertex.** Independent derivations legitimately converge — the sagittal
  station nearest the crown *is* the crown, the rostral dorsum station *is* nose_top —
  and two markers on one vertex render as a doubled sphere with z-fighting. Two were
  dropped, which is why the count is 84 and not 86.

**`--wire` overlays a thin grey wireframe of the control cage.** This is what makes the
panel read as a recovered *mesh* rather than a rendered animal. Deliberately the base
cage (2.6k faces), not the rendered surface — the head is subdivided to level 3 for
shading, so a wireframe of what is actually drawn would be ~250k faces of moiré.

Getting a cage wire to sit on a subdivided surface took three passes, and the failures
are worth knowing because they look like different problems and are the same one:

1. **Offset outward along vertex normals** → a visibly detached wire shell hanging off
   the ears and jaw. The cage is a coarse polyhedron whose flat faces already stand
   proud of the limit surface at grazing angles; pushing it out turns that into a
   double outline.
2. **Shrinkwrap instead** (`NEAREST_SURFACEPOINT`) → the halo goes, but the wire renders
   as **asterisks radiating from every vertex**. Shrinkwrap moves *vertices* only, and a
   straight edge between two on-surface vertices chords BELOW a convex surface, so each
   edge is hidden along its middle. Worst on the skull, where the cage triangles are
   largest.
3. **Subdivide the cage once before shrinkwrapping** (`--wire-subdiv 1`) → fixed.
   Halving edge length cuts the sagitta about fourfold, and the lines close up. Combined
   with `--wire-offset 0.0011` to clear z-fighting.

Same root cause as the keypoint markers sinking into the ears in §3b: subdivision moves
the rendered surface away from the cage everything else is positioned against.

Bin by the axis a feature runs along, never by an extremum: the lower lip was cut to a
single point earlier because a min-z pick kept landing on the chin, where `chin` already
sits. Binning by x spreads three along the jaw margin parallel to the upper lip.

*Normals **plus** real fur is the worst of the three and should not be revisited.* Each
strand carries its own shading normal, so the per-strand variation is high-frequency and
averages to a uniform yellow-green: the head renders as **moss**. It does kill the
rainbow, which sounds like the fix, but it takes the form with it — no shading gradient
survives to describe the shape, and the realism is gone too. The strands do follow the
shade mode (`fur_normal`), so this is one flag away and worth knowing is a dead end.

### 3d. The model is not the limit — the ears are

**There is no better dog model available, and this was checked properly.** Every
canine 3D asset in `../../dog-cv.md` is a *body* model whose head is a fraction of a
small vertex budget; the literature's dog-face work (DogFLW, DogFACS, dog_dynamics,
the geometric-morphometrics line) is **2D landmarks on real images**. No 3D canine
face model exists.

| Candidate | Verts | Verdict |
|---|---|---|
| **D-SMAL** (BITE 2023) — in use | 3,889 | Best available; ~1,316 on the head |
| RGBT-Dog (WACV 2024) | **2,426** | *Fewer.* Has a PCA texture model we lack, but no public model download found |
| MAMMAL canine (Nat Commun 2023) | 4,653 | Marginally denser, beagle-based, body model |
| SMAL / SMBLD / BARC | 3,889 | Same topology; SMAL was learned from 41 toy figurines |
| VAREN (CVPR 2024) | — | The "real scans + anatomical skeleton" model, but **equine** |
| PlanetZoo (CASA) | — | Photoreal rigged assets, but African wild dog / arctic wolf, and game-content licensing |

Resolution was never the binding constraint anyway — §3b already removes it by
subdividing and baking before shading.

**The real defect is that the mean shape reads as a fawn, not a dog.** It is an
average over 39 dogs of mixed breed, so it is a shape no real dog has. Two experiments:

1. **Shape space (`--betas`, sweeping PC0/1/3/5 at ±2.5).** Does **not** fix it. PC0 is
   mostly head scale; the others change ear size and skull width. In every variant the
   ears stay wide-set and laterally splayed and the muzzle stays straight — because
   those are inherited from SMAL's pan-quadruped template, not from the canine refit.
   Contact sheet: `shapesweep/SHEET.png`.
2. **Ear angle (`--ears`). This is the lever that works. Use 45°.** At the default 13°
   the ears sit half-erect and splayed in a wide V, an in-between belonging to no
   breed, and that V is most of the fawn reading. At 45° they fold forward and down
   over the sides and the head reads as a hound or retriever. Note −25 sweeps them
   back and is *worse*. Erect-and-forward is not reachable on this axis — the mean is
   already the most erect state — so pendant is the achievable direction.
   `shapesweep/EARS_KP.png` compares 13 / 30 / 45 / 60 with keypoints, at sub-panel
   size on top and 2× below.

   **A scale trap, in the opposite direction from the SMPL one in §3.** A no-keypoint
   sweep at 620 px made 75° look best; at full size 75° reads as long lop lobes, the
   ears start occluding the outer brow, and the ear keypoints land confusingly. 60° is
   already past the mark. §3's rule was to judge small rather than large — here the
   correct read needed *both* sizes, because ear silhouette resolves small and keypoint
   legibility only resolves large.

Two consequences before adopting either:

- **`--betas` breaks the added geometry.** The eyeballs, mouth cavity and tongue are
  placed at hard-coded model coordinates measured against the *mean* mesh (§3b). Change
  the shape and they detach — visible in the sweep as eyes floating outside the skull.
  They must be re-derived from the mesh before `--betas` is used for a real render.
- **Caption.** Off the mean, "the mean shape of a canine parametric shape model" is no
  longer available, and FIGURE-NOTES verified that claim bit-exact. "A shape drawn from
  the shape space of a canine parametric shape model (D-SMAL, Rüegg et al. 2023)" is
  still exact but weaker. Ear angle costs nothing here — posing a published model is
  not a shape claim.

### 3e. Making it read as a real dog — August 14, 2026

Current render: `dogface_v3.png`. Before/after at sub-panel size and 2×:
`shapesweep/FACE_BEFORE_AFTER.png`. The brief was that the panel must look real, not be
maximally accurate — a TR01 reviewer, not a canine-behaviour study section.

**Real fur, `--fur`.** Hair particles with the Principled Hair BSDF, not a bump map.
This is the single biggest lever: a bump-shaded surface always reads as painted clay at
the *silhouette*, and the silhouette is exactly where a coat shows. ~16k parent strands,
length 0.0072, melanin 0.17 (fawn). Furless zones are cut at the rhinarium and at both
eye apertures — left furry, the eyes are buried and the face loses them entirely.

**Rhinarium.** Its own near-black, lightly-coated material with a fine Voronoi cobble,
assigned to faces inside a ball at the nose leather. D-SMAL gives the nose no separate
material and no relief beyond the nostril creases, so without this the nose is the same
value as the cheek — and the nose is the single feature people identify a dog by.

**Eyes.** Iris and pupil from a ColorRamp on object-space radius, roughness 0.055 with a
coat layer. The hard specular catchlight is what makes them read as wet and alive at
sub-panel size; a flat black ball does not.

Three sizing lessons, all found by rendering: a plane cut for the nose (`x > const`)
wrapped the whole muzzle end and read as a snout mask, so the region is a ball; fur at
0.0165 reads as a teddy bear on a head only ~0.35 long; and marker radius 0.0068, fine
against flat clay, reads as gumballs against real fur — 0.0055 now.

**Two more bpy traps, both silent.**

- **Principled Hair BSDF `parametrization` defaults to `'COLOR'`, which DISABLES the
  Melanin, Melanin Redness and Tint sockets.** Assigning them still succeeds — no error,
  no warning — and is ignored, so the coat renders the default `Color` of
  (0.018, 0.006, 0.002), a near-black brown. Several renders came out as a chocolate
  bear at melanin 0.17 before this surfaced. Set `parametrization` first; `socket.enabled`
  is the tell, and `hair_material()` now warns rather than failing quietly.
- **`seed` and `vertex_group_density` live on the particle SYSTEM, not on its settings.**
  Settings objects are shared between systems, so anything referring to a specific
  object's data is on the system. Both raise `AttributeError` on the settings.

### 3f. The landmark set is now derived, not typed — `derive_landmarks.py`

**50 landmarks: 8 midline + 21 mirrored pairs.** Regenerate and re-inject with:

```bash
./bpyenv/bin/python derive_landmarks.py          # prints a KEYPOINTS block
./bpyenv/bin/python derive_landmarks.py --probe  # prints a --probe string
```

The old 41 were hand-typed model coordinates, which is precisely how the eight eye
points ended up on the lateral skull wall (§3b): nothing tied them to a feature, so
nothing caught the drift. Every landmark now anchors to something the mesh has:

- the **jaw/head skinning seam is the lip line** — vertices blended between j32 and j16
- the **ear skinning seam is the attachment ring**
- the **palpebral fissure** is sampled as an even ring in its own best-fit plane
- nose tip, crown and occiput are geometric extremes

Left side is derived and the right is mirrored, so the set is exactly symmetric.
`KEYPOINTS_v1_backup.py` keeps the old set as the worked example of the failure.

**Constraints that were not obvious and each produced a wrong landmark first:**

- **`SKULL` must exclude the ear plates.** The ears out-top the cranium by 0.04, so
  "highest head vertex" returns an *ear tip* and crown, temple and brow all silently
  land on the ear.
- **The lip seam must be clipped to x > 1.05.** The raw jaw/head blend continues under
  the throat, and its global min-x vertex sits on the midline — not a commissure.
- **Bin the lip line along x, not y.** Binning by y and taking max-x returns lower-jaw
  vertices rather than the lip margin.
- **The brow anchors to the measured eye centre**, not to a z extreme, which returns
  the crown.
- **The eye ring is geometric, not crease-based.** The orbit is sampled at ~0.005, finer
  than the rest of the head, and its lid creases score 0.004–0.015 — inside the noise of
  the surrounding surface. An absolute crease threshold grew a ring of exactly one
  vertex. A numeric concavity detector, tried first, returned a *nasal fold*.
- **Ring radius 0.0215 > eyeball radius 0.018.** At the aperture radius the eyeball
  simply occludes the landmarks; at 6 points they close into a rosette that reads as a
  flower stuck on the face, so it is 4.

**On DogFLW.** Reconciling against it was attempted and abandoned deliberately. DogFLW
(Martvel et al., *Sci Rep* 15:21886, 2025) is the right reference — 46 DogFACS-grounded
landmarks over 120 breeds — but **the per-landmark definitions are not in the paper**.
The text points to a figure and to a supplementary spreadsheet, and the arXiv version
says only "all details and landmark descriptions are available in the spreadsheet."
The GitHub repo does not carry them either. Matching it properly needs that manual from
the authors. Our set is anatomically sensible and internally consistent, not a DogFLW
crosswalk, and the caption should not imply otherwise.

### 3e. Realism pass — August 14, 2026

`--fur` · `--shade uv` · mesh-derived rhinarium. Best current combination:

```bash
./bpyenv/bin/python dogface.py --shade uv --fur --ears 45 --eye-r 0.018 \
    --nose-scale 0.82 --res 2600 --samples 400 --out dogface_real
```

**Real fur, not a bump map.** Particle hair plus the Chiang Principled Hair BSDF, both
available headless. This is the largest single realism gain: a bump-shaded surface always
reads as painted clay *at the silhouette*, and the silhouette is exactly where a coat
shows. ~7 s at 1400 px. Fur is cut back at the nose and the eyes via a `furless` vertex
group — left furry, the eyes are buried and the face loses them.

**Three bpy traps, all silent failures:**

- `ParticleSettings` has no `seed` and no `vertex_group_density`. Both live on the
  **ParticleSystem**, because settings are shared between systems and anything referring
  to one object's data has to sit on the system.
- **`ShaderNodeBsdfHairPrincipled.parametrization` defaults to `'COLOR'`, which
  *disables* the Melanin sockets.** Assigning them still succeeds, silently, and is then
  ignored — the coat renders the default `Color` of (0.018, 0.006, 0.002) and comes out
  as a near-black bear at any melanin value. Set `parametrization` first. `socket.enabled`
  is the tell, and `hair_material()` now warns instead of failing quietly.
- `ndarray.ptp()` was removed in numpy 2; use `np.ptp(arr)`.

**The rhinarium is measured, not guessed — this was the snout bug.** The nostrils are by
far the sharpest crease on the head (0.81 where nothing else on the face clears 0.02), so
they are trivial to find. The first version used a hand-set ball at z = 0.055, which sat
on the **bridge** of the snout covering z 0.032–0.090 while the nostrils sit at z = 0.007
— a black pad pasted across the top of the muzzle with the real nostrils bare below it.
`rhinarium_frame()` now derives centre and extent from the nostril creases and the rostral
tip. Second half of the same bug: the creases are only ~0.004 deep, so on a glossy pad the
specular filled them in and the nose rendered as a featureless blob; the nostrils are now
darkened and roughened explicitly so they read as openings.

**UV: the coat is a baked texture now, not a vertex attribute.** `cylindrical_uv()` +
`bake_coat_texture()`, both pure numpy.

- **Not `bpy.ops.uv.smart_project`.** It scatters the head into unpredictable islands, and
  a layout you cannot predict is one you cannot author into — which is the whole point of
  going to UV. A cylinder about +X is the natural parameterisation for a muzzle: *v* runs
  occiput to nose, *u* runs around the head, seam under the jaw. Faces straddling the
  atan2 wrap get their low corners shifted by +1 or they smear across the whole map.
- Unwrap and bake happen on the **base** mesh. Catmull-Clark interpolates UVs, so this
  rasterises ~2.6k triangles instead of ~250k for an identical result. ~1 s at 2048².
- **This is what UV actually buys:** the mask edge is now a texel rather than a mesh edge.
  §3b got the vertex-colour version as sharp as it can go by subdividing to 125k verts,
  but that only moves the limit; a texture removes it.
- Islands are dilated 6 px, or bilinear filtering samples the void and draws a dark seam
  around every island.

**A vertex-resolution artifact that only appeared once baked.** `coat_colors`' tonal
break-up was `sin(x)·sin(y)·sin(z)` — separable, i.e. a **3D checkerboard**. At ~1 cm
vertex spacing against a 0.10 period it aliased into something that passed for noise, so
it was invisible for the entire life of the vertex-colour version. At 2048² it resolves
into an obvious regular grid across the face. Replaced with `_value_noise()`, aperiodic
and sampling-rate independent. Worth remembering as a general point: **raising resolution
exposes patterns the old sampling rate was hiding**, and a "deterministic noise" built
from separable trig is not noise.

Known remaining: the unwrap wastes ~19% of the map, and there is a small seam patch under
the jaw, visible on smooth `uv` and hidden once `--fur` is on.

### 3g. The eyes — socket, lids and iris (August 14, 2026)

The bare-sphere eye read as uncanny for two separate reasons, and both are fixed.

**The iris was never visible, and it was a units bug.** `eye_material()` drives iris and
pupil from a radial ramp over *Object* coordinates. `rig.put()` sets `obj.location` rather
than baking the offset into the mesh, so Object space here is **local** and runs −r…+r =
±0.018 — while the ramp stops were authored as if the range were 0…1, at 0.16 and 0.42.
Every point on the globe therefore fell below the first stop and the entire eye rendered
as flat pupil black. The radius is now divided out, the stops are fractions
(`--eye-*` fracs), and there is a limbal ring at the iris edge.

**The globe stayed a circle because the clipping logic was backwards.** D-SMAL models no
lids — the fissure is a ~0.004 crease — so a sphere on a convex, featureless face keeps a
perfectly round silhouette no matter what the surrounding skin does. `eye_socket()` now
carves a real orbit on the rest mesh, before subdivision, like `smile()`:

- the aperture is an **ellipse** (0.0255 × 0.0142, ~1.8:1) aligned to the fissure via an
  SVD of the local patch, so the visible eye is almond rather than round
- a low annulus outside it reads as upper and lower lid folds
- **the globe is sunk 0.017 along the local normal.** This is the part I first got wrong:
  at the aperture edge a globe centred on the surface still stands *proud* of the skin, so
  the lids have nothing to cut. Sinking it until the skin wins at the aperture edge is what
  produces the almond. A sink sweep is the fast way to tune it.

It has to be geometry, not shading: the panel ships as normal-derived shading, so there is
no albedo channel to fake an eyelid in.

Two smaller fixes found here:

- **A `sqrt` falloff on the socket gate rendered as concentric ripples** in the skin below
  each eye once subdivided and normal-shaded. Use smoothstep.
- **Square area lights leave square catchlights**, which on a wet eye read as two white
  blocks. The rig is now `DISK`, and the coat weight is down from 1.0 to 0.28 — a
  full-strength coat over a dark globe blew out into a glass bead.

**The iris is centred on the gaze axis, not on +X.** A second, subtler version of the
same class of bug. The globe is an axis-aligned sphere, so a radial distance in the
object YZ plane centres the iris on the model's +X — straight ahead — while the aperture
`eye_socket()` carves is centred on the local surface **normal**, which on a dog points
forward *and well laterally*. The iris therefore sat off-centre in its own opening. The
shader now normalises the object position and dots it with the gaze vector, so zones run
outward from where the eye actually looks. Radius drops out of the maths entirely, which
also permanently removes the units trap above. **One material per eye** — the gaze axis
is mirrored, and a shared material centres the right eye's pupil on the left eye's
direction.

**Sclera.** Zones are fractions of `1 - cos(theta)`: pupil, iris, a thin dark limbal
ring, then sclera, tuned by `--eye-sclera` (lower shows more white). It appears as pale
wedges at the **canthi**, not as a white ring, and that is geometrically forced rather
than a stylistic choice: the socket aperture is only ~42° tall but effectively open to
90° along the fissure, so the corners are the only place the outer globe is unoccluded.
That is also exactly where a real dog shows white, so the honest way to show more is to
lower `--eye-sclera` rather than to widen the aperture. Default 0.210.

**Knock-on: the eye landmarks had to move outward.** Ring radius 0.023 was correct against
the old bare sphere, but once a real aperture existed the beads (r = 0.0068) overlapped it
and hid the eye. The ring is now 0.031 × 0.56, which puts the bead inner edges just outside
the aperture so they describe the orbital rim and leave the eye clear.

### Current panel

### 3h. Marker seating — the cage-vs-limit-surface problem, third occurrence

`--kp-seat`, default **0.36**. This is the same underlying issue as the wireframe (§3f note)
and the ear markers in §3b, and it has now failed in *both* directions, which is the useful
part:

1. Markers placed at the cage vertex **sank into the ears** — Catmull-Clark pulls the limit
   surface inward from its cage.
2. The fix was to push out along the vertex normal by ~0.95 r. That over-corrected and left
   beads visibly **floating** at the ear tips, the crown midline and under the jaw.

Both are wrong because **the cage-to-limit gap is not constant** — it is largest at convex
extremities, which is exactly those three places. A single offset cannot satisfy both a flat
cheek and an ear tip. Measured on the current mesh: **16 of 84** landmarks sit more than
0.5 marker-radii off the cage.

The fix is to stop guessing and ask: `dog.closest_point_on_mesh()` returns the real surface
point and normal on the *subdivided* mesh, and the bead is seated from there. `--kp-seat` is
the bead-centre height in units of marker radius — 1.0 is tangent, lower embeds it so it
reads as sitting **on** the skin. 0.62 still looked proud on silhouette edges; 0.30 was
clean with no loss of legibility, and 0.36 is the chosen margin.

General rule for this file: **anything positioned against `V` (the cage) and rendered
against the subdivided surface will be wrong somewhere.** Project it.

**Treatment is settled (August 14, 2026): duotone normals. No UV coat, no fur.**

```bash
./bpyenv/bin/python derive_landmarks.py            # regenerate the KEYPOINTS block
./bpyenv/bin/python dogface.py --shade normal --normal-style duotone --wire \
    --ears 45 --nose-scale 0.82 --res 2600 --samples 440 --out dogface_normals_final
```

`dogface_normals_final.png` — duotone normal-derived shading · 84 colour-coded landmarks ·
subtle cage wireframe · carved eye sockets with gaze-centred iris, limbal ring and sclera ·
mesh-derived rhinarium with darkened nostrils · ears at 45°.

`--shade uv` and `--fur` still work and are documented in 3e, but they are **not** the
panel. Keep them only as the photoreal comparison; the caption language differs, and the
two treatments make different claims (3c).

**Render settings differ from Panel A on purpose.** `Standard` view transform, not AgX: AgX
rolled the saturated keypoint colours off to pastels, which is unacceptable when the colours
are the legend. Light energies are cut hard to compensate for the missing highlight roll-off.
Perspective 105 mm lens with depth of field at f/3.6, which is what gives the sub-panel its
depth; `--dist 2.25` is what frames the whole head at that focal length.

## 4. Panel geometry

An isometric 4.2 m room projects **landscape**, roughly 1.6:1. It cannot sit in a 7.5 × 3.0 in
strip beside two equal panels — an early attempt at that cropped it to fragments.

Current plan: Panel A at **4.0 × 2.5 in** on the left, with the two data panels stacked to its
right. `PANEL_W_IN` / `PANEL_H_IN` in `panelA.py` drive both the render aspect and the
Freestyle line weight.

The room was reduced from 5.0 m to **4.2 m** deliberately: it is just as plausible for a canine
testing room and buys ~19% linear scale on the subject, which matters because the dog was near
the size at which a silhouette stops being recognizable. **Do not fix small-dog legibility by
drawing the dog oversized** — that is a scale lie in a figure whose job is asserting we can
measure a room.

## 5. bpy traps, all hit and diagnosed

Worth reading before touching the code. Several cost real time.

**Geometry and transforms**

- `obj.evaluated_get(dg).to_mesh()` is **invariant to the object transform** in this build.
  Every measurement comes back identical and any scale derived from it is silently wrong.
  Measure `obj.data.vertices` directly instead.
- `bpy.ops.object.transform_apply` proved unreliable here. Use `mesh.transform(matrix)`, which
  edits vertex coordinates directly and needs no operator context or depsgraph.
- **Object rotation is about the WORLD origin.** Setting `rotation_euler` on a figure standing
  at (1.05, 0.45) swings it along an arc of radius |loc| and leaves separately-built parts
  behind. Use `place_mesh()`: centre on origin → rotate the data → translate to target.
- **Both D-SMAL and SMPL OBJs are authored Y-up.** D-SMAL only *looked* splayed on its side;
  it was standing all along. Heuristic: a standing quadruped or human has height > width, so
  if `sz < sy`, rotate. The sign matters — **−90° about X**; +90° produces a belly-up dog.

**glTF import**

- Quaternius rigs ship a junk `Icosphere` helper mesh alongside the animal. Pick the mesh with
  the **highest vertex count**, not the first.
- The importer leaves an **action assigned** whose fcurves target `rotation_quaternion` and
  silently overwrite anything written to `rotation_euler` on the next depsgraph evaluation.
  Clear `animation_data` before hand-posing.
- Scope action lookups to the **current import**. The Quaternius animal and human rigs both
  name a clip "Idle", and the dog imports first.
- Scale a hand-posed figure from its **bind-pose** height. A seated figure measures 1.0 m, so
  normalising its posed height to 1.72 inflates it by 70%.

**Rendering**

- Cycles Metal: assign `compute_device_type = 'METAL'` **without validating against the enum**,
  which reads empty in background mode. Then `get_devices()`, set `d.use` for METAL devices,
  `scene.cycles.device = 'GPU'`.
- `'CYCLES'` is likewise **not** in `RenderSettings.bl_rna.properties['engine'].enum_items`
  (Cycles registers as an addon engine) but assigns fine. Never enumerate to decide availability.
- EEVEE's engine id in Blender 5 is plain `'BLENDER_EEVEE'`; the 4.2-era `'BLENDER_EEVEE_NEXT'`
  is gone. EEVEE **does** work headless — the old GL-context blocker is resolved.
- `transparent_max_bounces` defaults to **8**, and Cycles terminates rays past it as **black**.
  Nine view volumes cost two transparent crossings each, which turned the room into a dark
  mass. This looked exactly like an opacity problem and was not.
- Boolean modifier solver enum in Blender 5 is `FLOAT|EXACT|MANIFOLD`. `FAST` was renamed.
- AgX looks are `'AgX - Base Contrast'`, `'AgX - Medium High Contrast'`, etc. There is no plain
  `'AgX - Medium Contrast'`.

**Freestyle** (only used by `--style flat`)

- Enabling it **auto-creates `linesets[0]` with `linestyle = None`**, which crashes the line
  pass inside `parameter_editor.py`. The usual `if len(linesets)==0` guard never fires, and
  creating a second valid lineset does not help — the broken one is still processed. Repair
  every lineset with a null linestyle.
- Thickness is in **pixels**, so derive it from output resolution and final printed panel
  width, or a weight tuned at preview size vanishes in print.
- No SVG output: `render_freestyle_svg` is not among the 13 addons bundled in the wheel.
- Filter by collection to give a figure silhouette-only lines.

**De-identification**

- **SMPL bodies are already faceless** — no eye, brow, or mouth geometry at all. Rendered
  untextured, the head reads as a mannequin. The `deface()` cut-and-cap pass is *not* used for
  SMPL and only introduced a neck seam.
- `deface()` remains for meshes that do have modelled faces (the Quaternius human had visible
  eyes and a nose surviving as silhouette and border edges even with creases suppressed). Two
  fixes are baked in: anchor the cut a fixed anatomical distance **below the crown**, not a
  fraction of total height (a seated figure is 1.0 m and gets decapitated at the shoulders);
  and place the cap at the **neck stump centroid**, not the body's XY centre, which drifts
  forward when the legs extend.

**Mutual facing**

`native_gesture_bearing()` measures the figure's forward direction from its own extended hand
rather than guessing the export's forward axis. Two traps: no upper z bound (the stay gesture
raises the hand to ~1.9 m; a 1.55 m ceiling locked onto a torso vertex and returned exactly
0°), and the threshold must be a **fraction of the figure's own height**, because this runs
before the mesh is dropped to the floor and SMPL's origin sits at the pelvis.

## 6. The camera field-of-view problem — unresolved

**Four treatments were tried. All four read badly at panel size. They are currently OFF.**

| Treatment | Failure |
|---|---|
| 8 filled cones | Occluded the entire room |
| 8 wireframe frusta | Spaghetti; repetition destroys meaning |
| 1 filled wedge + capture-volume solid | Best of the four, but the wedge crossed the subject |
| 9 boolean-clipped volumes, emissive surfaces | Hard clip edges, banded overlaps, read as low-poly crystal |
| Same, as Volume Scatter | Banding fixed, but coverage voids where fewer cameras overlap still read as artifacts |

The Volume Scatter approach is the technically right primitive — no Surface connection, so the
cone surfaces are invisible and scattering integrates along the ray, giving genuinely weighted
additive overlap. It is preserved behind `--fov` with `--fov-opacity` tuning density.

**If this is revisited**, the design research (see §7) is prescriptive and was not fully
followed: draw exactly **one** representative wedge, label it *"field of view (1 of 8 shown)"* —
the parenthetical is what makes it honest — give the other cameras a small direction tick, and
put all 8 camera positions in a small **plan inset** in a corner instead. That advice was
sound; the all-nine-volumes direction was a later request that overrode it.

## 7. Design constraints still binding

From a research pass on small-figure conventions (Points of View columns, OpenMonkeyStudio,
DANNCE, SLEAP, NIH format rules):

- True isometric, parallel projection, two-wall corner cutaway. Crop the near corner off the
  bottom edge — buys ~40% linear scale and kills the floating-diorama look.
- Draw the actual machine-vision silhouette (rectangular body, short lens barrel), never a
  CCTV or dome icon, which reads as clip-art to anyone who has built a rig.
- **Mixed projection systems are the single most reliable "assembled from clip-art" signal.**
  Everything in one projection is why this is built in 3D rather than composited.
- Line weight floor 0.28 pt at final size; working band 0.5–1.5 pt.
- **A palette check is worth re-running if colours change.** The house palette from the Simons
  Quantitative Phenotyping figure failed grayscale separation in six adjacent pairs, including
  wall-vs-floor at ΔL\*=3.7 — which was exactly the "room doesn't read as a container" problem,
  quantified. The fix was light fills with dark outlines, not better values.

**Caption constraint.** With D-SMAL and SMPL in place, the caption may name them. It must not
describe either as output of this project's own reconstruction pipeline — they are published
models used to illustrate the setup.

## 8. Open items

1. ~~Repoint asset paths from scratchpad-relative to `assets/`.~~ **Done August 13, 2026** (§2).
2. Panels B (analysis) and C (validation) — not started. Proposed: 3D pose + dense scene
   reconstruction; then time-aligned behavior segments over kinematics with EEG/EKG/IMU on a
   shared axis.
3. The ~400-word section text — not started. Budget from Kaf: 3/4 page total including figure,
   under three headings (Acquisition · Analysis · Validation), which works out to ~365–415
   words of body text plus a ~50-word caption.
4. Top rail cameras are grazed by the frame edge.
5. The left third of the room is emptier than the right now that both figures sit right of
   centre.
6. Field of view — see §6.
7. **Face sub-panel is at candidate-final** (`dogface_normals_eyes.png`, §3g). Remaining
   nits, none blocking: the socket aperture clips slightly unevenly left vs right because
   the ellipse meets the sphere on a curved skull; the iris/pupil structure does not
   resolve at sub-panel size and is carrying colour only. (The UV seam and wasted-map
   items are moot now that UV is not the shipping treatment.)
8. ~~Decide which face treatment ships.~~ **Settled: duotone normals, no UV, no fur.**
9. Panel A still uses the pre-August-14 eye/ear/nose work — none of §3d–3g has been applied
   to the full-room dog, which is at a scale where none of it would be visible. Worth a
   check only if Panel A is ever recropped tighter.
