# ARK Resource Maps - Architecture Documentation

## Overview

The production entry point is the extracted-3D resource viewer in `src/viewer.ts`.
Shared data, clustering, and coordinate modules support the production viewer.
The former flat viewer and standalone Island demo have been removed.

### Production terrain viewer

`root/index.html` loads `root/index.js`, bundled from `src/main.ts`. Run
`npm run build:core` after source changes: deployment publishes `root` directly,
without a build step. `npm run typecheck`, `npm test`, and `npm run lint` provide
validation.

The viewer loads `data/index.json`, the selected resource map, its image, and
`terrain/index.json`. Index URLs resolve relative to that index.
The version-2 per-map metadata retains calibrated centimeter bounds
(`originX`, `originY`, `maxX`, `maxY`, `minZ`, `maxZ`), a `mapKey`,
warnings, and optional `worldModel`, `blockModel`, and `progressiveModel` links.
There are no sampled height tiles, render strides, heightfield meshes, or
heightfield coverage masks. The original 5 m fallback tiles and display libraries
have been removed. Source collision heightfields still contribute triangles to
offline 3D extraction; they are not the retired single-height display grid.
Maps with no published 3D link report an explicit unavailable-extraction error.
Recorded resource coordinates remain unchanged and are never surface-clamped.

### Optional continuous collision-world skin

An optional terrain-manifest `worldModel: { "url": "world.json" }` enables the
continuous model. It loads automatically, fetches metadata with `no-store`,
and streams geometry within the limits below. `src/world-model.ts` validates the
version-1 `awm1` contract: centimeter XYZ vertices, outward Unreal winding,
uint32 triangle indices and per-triangle topmost/source-walkable flag bits.
Header/count/length/reserved/flag/index/coordinate checks reject malformed data.
LOD URLs are relative to the manifest; tile footprints must form a nonoverlapping
nominal XY grid. Each binary is capped at 32 MiB and metadata at 128 MiB
(the progressive hierarchy includes substantially more node descriptors).

The renderer preserves whole tiles and every floor within each resident tile.
Camera/frustum selection chooses error-based LODs, first covering nearby tiles
coarsely and then refining them, with a 1,000,000-triangle / 96 MiB resident geometry
budget. Visible tiles are prioritized by camera-to-bounds distance; orbit-target
distance only breaks ties, so a distant or stale focus cannot spend the budget
behind nearby terrain. Pending replacements reserve positive budget deltas. Two binary downloads
can be in flight; their declared-length buffers, temporary geometry during one
atomic LOD replacement, browser network buffers and the map image
cache are additional memory. This is not a promise of 96 MiB total browser memory.
There is no random vertex, point or floor thinning.

Topmost triangles use the existing calibrated image UVs. Covered mesh and block
faces sample a 5 x 5 pixel square around their projected XY location and average
the colors in linear space. Samples clamp to the image edge. An angle-based
multiplier gives covered upward faces 85%, vertical walls 60%, and undersides 35%
brightness, interpolating continuously between them. The original, unexaggerated
face orientation is used, including when viewed from behind; terrain lighting
still applies afterward and can be toggled independently. This is a material-only
change: no extra per-vertex attributes, geometry budget, or duplicate image texture.
Missing map images retain the disclosed charcoal fallback.
Source flag coloring uses original collision classification rather than normals
recomputed after simplification. Lighting, wireframe and
top-surface opacity work on the model. Covered skin remains opaque. A height cutaway
clips model and resource markers, allowing cave inspection; orbiting
below the surface is enabled only in world-model mode.

Outside resident tiles, unavailable geometry remains empty. In-flight LOD
changes keep the old complete tile until replacement is ready. Neither eviction
nor failed downloads invents a fallback surface. Picking intersects only resident
3D surfaces and applies map bounds and cutaway rules. Failures are visible with a
separate retry action, never disguised as a successfully loaded world tile.
The map texture is shared, not disposed by world-layer cleanup.

### Progressive 3D refinement

A manifest with `roots` and per-patch `children` uses the progressive path instead
of independent XY tile LODs. The optional terrain `progressiveModel` link exposes
**Triangles**. The selector offers only **Cubes** (default) and **Triangles**;
both stream a complete coarse base before local detail. `world=triangles`
selects triangles explicitly; old `world=progressive` and `world=mesh` links
remain aliases. Independent legacy mesh/block datasets remain on disk but
are not dropdown options. Triangle rendering is still experimental internally:
the triangle budget still limits some close views and coarse clustering can
look jagged.
A complete coarse 3D base is loaded first. Nothing is rendered or pickable until
all roots are ready.
The base remains represented throughout refinement; failed child requests retain
the complete parent and expose retry rather than introducing holes.

The offline hierarchy partitions the finest exported triangles into spatial
3D patches of at most 4,096 faces, then aggregates patches across source tiles.
Near levels use constrained endpoint simplification. Larger levels can use 3D
vertex clustering to obtain genuinely coarse geometry. Shared refinement
interfaces are locked; all children of a parent switch together. Each child
stores its exact parent-space endpoint correspondence. Collapsed child triangles
reproduce the parent's triangles, including winding, material flags and duplicate
multiplicity; the offline validator checks this relationship for every parent.
Version-2 hierarchies require one common base root and additionally declare
`fixed-interface-collar-v1`; independently simplified root forests are not
seam-certified. Each
interface locks all vertices of its incident triangles, not just vertices on the
boundary itself. The validator recursively carries ancestor interfaces into
descendants and proves their face collars remain identical and motionless,
including winding, flags and duplicate multiplicity. Shared sibling vertices
must have identical parent targets. This permits asymmetric refinement beside
a coarser neighbor without opening a new LOD seam during the GPU morph. It does
not repair gaps already present in the extracted source. Publication requires
version 2 and exact finest-triangle totals for every original source tile, so a
regional pilot cannot masquerade as complete map coverage.
Coarse clustering is an approximation, not topology preservation: features below
the recorded accumulated motion envelope can merge, then return on refinement.
It never selects only the highest floor at each XY.

### Cube LOD coverage

The optional `cubeModel` link points to a version-3 hierarchy with
`closed-voxel-partitions-v1`. Its AWM1 patches contain genuinely axis-aligned
cubes, not triangle geomorphs. Finest occupancy remains the existing 4 m,
strict-majority result. Coarse 8/16/32/64 m occupancy uses any existing child
solid, preventing repeated-majority erosion of thin barriers. It can thicken
surfaces and close narrow gaps at distance; it does not rerun source extraction.
The full 64 m base loads atomically. Internal XY partition walls close the
volume steps between different cube sizes; artificial outer-world side,
bottom and ceiling surfaces are never invented. Those internal walls can
be visible in transparent/cutaway views. Replacements are atomic, without
morphing cubes into sloped surfaces.

The client-side **Far cube target** slider selects powers of two times the map's
finest cube edge length, up to 64 m (initial target 4x). It supports both existing
4 m publications and 1 m intersection-based exports. Within 750 m of a partition,
the target remains the finest published size. Geometry budgets may keep more distant sections
coarser than the target, but never discard the complete base to meet it.
Changing the slider selects precomputed occupancy meshes; it does not
re-voxelize triangles or fetch all fine terrain in the browser.
Native validation reconstructs every mesh from its saved occupancy, verifies
parent solid coverage and lattice alignment, and rejects overlapping roots.
Some legacy tiles own only neighbor-boundary faces while having no own solid
cells; publication verifies those faces are covered by the new solid-owning
neighbor rather than requiring artificial geometry in the empty tile.

### Shared hierarchy streaming

CPU selection traverses the active frontier, not all source triangles, at most
every 50 ms. Projected error uses 2-pixel refine / 1-pixel coarsen hysteresis.
Lower-error sibling groups can coarsen to release budget for higher-error views.
Only one atomic replacement group is in flight, with at most two downloads.
The 1,000,000 surface-triangle limit remains unchanged; the 96 MiB geometry budget
also includes replacement patches waiting for activation.

Triangle morphing takes 250 ms in the vertex shader. Per-vertex parent position and
transition start/direction attributes are uploaded once per replacement; frame
updates change only the shared clock, not CPU positions or index buffers.
Positions, projected image UVs, covered-face shading, wireframes and clipping use
the morphed surface. GPU frustum bounds include both endpoints. Pointer raycasts
evaluate intermediate positions only on demand. AWP1 patches use 52 bytes per
vertex (including normals, UVs and transition attributes), plus 12 bytes per face.
The hierarchy metadata, binary downloads, texture, browser buffers and renderer
objects are additional memory. This is a WebGL mesh renderer, not GPU-driven
Nanite, occlusion culling, a visibility buffer or runtime mesh simplification.

The existing fixed-resolution cubic occupancy representation is unchanged; it
does not morph its cubes into the triangle hierarchy.

This layer renders exterior-connected collision skin, **not navigation**.
It does not establish player capsule clearance, spawn reachability, jumping,
swimming or locomotion rules. Geometry extraction accuracy, disconnected regions,
resolution and limitations belong in the export manifest warnings/statistics.

### Retained all-floor walkable surface library

The terrain manifest may add `walkability: { "url": "walkability/manifest.json" }`,
but the production viewer no longer exposes or instantiates the walkability
overlay and never downloads these optional records. The standalone library and
its tests are retained for offline inspection. The following limits describe
that library, not active viewer controls.
Viewer JSON discovery and the optional walkability manifest use `cache: no-store`,
so reloading after publishing an export cannot reuse an old manifest that omitted
the optional field. Binary tile requests retain normal browser caching.
Failures have a separate retry button and never replace the terrain or resource
settings. Disabling releases geometry and aborts downloads; revision guards
reject stale completions and warnings after map changes, toggles, or retries.

`src/walkability.ts` validates the version-1 `float32-le-xyz-normal` manifest
(24-byte stride, centimeter units, 500 cm spacing, candidate-only semantics),
exact tile lengths, finite world coordinates bounded to ±100,000,000 cm and
descriptor bounds (0.1 cm float tolerance), and normals within 0.02 of unit length.
Manifest JSON is capped at 4 MiB / 4,096 tiles; each streamed binary response is
capped at its declared length and **64 MiB per tile**. Larger exports fail
explicitly and require smaller export tiles. Tiles load sequentially, with only
one source tile retained at a time; the streaming buffer is at most 64 MiB,
besides fetch chunks and browser-managed network buffers.

Display is bounded to **200,000 patches / 400,000 triangles**. A bounded packed
sampler adaptively selects power-of-two spatial hash levels on original 5 m XY
columns, independent of tile order. Every vertical record of each retained
column survives, including identical XY cave/bridge floors; no highest-Z
reduction or tail truncation is used. Display thinning and original/displayed
counts are disclosed. Pathological coincident columns exceeding the budget fail
explicitly rather than discarding vertical layers. The CPU sampler and finished
instance records each occupy at most 4.8 MB (9.6 MB briefly during finalization);
the GPU instance buffer uses **24 bytes per patch**, not per-instance matrices.

A single instanced quad draw uses a shader tangent frame from each original
normal, a 0.85 × spacing patch width and a 3 cm normal bias. Original xyz/normal
records are immutable. World X/Y/Z map to centered scene X/Z/Y meters, with the
same parent Y exaggeration as terrain/resources. Despiking, layer height limits,
and terrain-style changes do not touch these samples. The bounded single draw
updates naturally with the camera; it does not allocate per-point meshes.
Depth testing remains on. At terrain opacity 1, hidden floors are occluded;
reduce existing Terrain opacity to inspect cave candidates. No settings are
silently changed.

The library exposes the **exported** floor-normal Z and angle thresholds, and keeps
every export warning in a scrollable list, including after tile failures.
These are static collision slope/body-override candidates sampled at 5 m,
not reachability, full capsule clearance, or water-state simulation.

### Rendering and interaction

Rendering uses centered meters (world X/Y/Z become scene X/Z/Y). Texture UVs and
clipping use the resource map's exact XY image bounds, not the rounded grid edge.
Camera presets target the selected layer's elevation.
Coverage and the exporter warning count are visible only with **Show debug**. The full
warnings, including asset paths, are accessible in a collapsed, scroll-bounded
details list; no warnings are discarded.

Map-image HTTP 404/410 responses explicitly announce an untextured,
charcoal 3D view.
This view preserves the extracted geometry, holes, LOD, resources, lighting and
opacity controls.
It does not invent imagery or replace terrain with a flat plane. Other image
HTTP failures, network errors, and image decoding failures remain explicit
retryable errors, as do failed 3D assets. Textured maps are unchanged.
Map changes abort requests, invalidate pending geometry, and
dispose geometry, materials, image bitmaps, and textures.

Resources use the existing `World` clustering in original centimeter XYZ,
including per-type counts, cluster centroids, filters, and member indices.
Marker picking, glow, cave visibility, opacity, lighting, debug
coordinates, and oblique/north-up navigation are part of the production UI.
The camera defaults to north-up Orthographic, fitted to the full window with a
small margin and no aspect-ratio cropping. A projection selector switches to
Perspective or back while preserving direction and apparent scale at the focus.
The controls panel has an always-accessible collapse/expand arrow. Numeric
coordinate and measurement displays use two decimal places.
Vertical exaggeration is fixed at 1 for both terrain and recorded resource XYZ.
The panel hides explanatory implementation text, coverage, world generation
details and render counts behind Show debug. Actionable image/load errors and
world-model retry messages remain visible with debug off. Debug visibility is
independent of map changes and representation updates.

Copy CCC and Paste CCC are always visible, including their success/failure status.
Paste reads the clipboard and restores the camera directly. With Show debug
enabled, Camera / ccc also offers a manual field and Go to ccc. The clipboard
format is five plain numbers, **X Y Z Yaw Pitch**: Unreal world coordinates in
centimeters and angles in degrees. It also accepts commas and an optional `ccc`
prefix on input. World X/Y/Z becomes scene X/Z/Y; positive pitch looks upward,
and yaw turns world +X toward +Y. Copy uses two decimal places for every field.
This replaces the former Pitch/Yaw ordering; old codes need their last two
fields swapped. Invalid inputs and orbit-limit violations are reported
without moving the camera. Clipboard failure leaves the captured text selected
and reports that manual copying is needed.

Camera coordinates apply to the currently selected map and representation.
They restore position and viewing direction, retaining the current focus distance,
cutaway, lighting and other render settings. They do not encode a map, resource
filters or a viewport size. `window.arkApp.ccc()` returns the clipboard-format
text; `window.arkApp.ccc(text)` restores it. World tiles stream at the new pose.

Left-drag orbits the surface under the initial press, preserving that point's
screen position instead of snapping it to the center. The camera and its look
target rotate together around this separate pivot. Right-drag and modified
left-drag still use OrbitControls panning, without residual damping drift.
The Movement mode selector and a middle-button click switch World/Camera; dragging
the middle button still dollies instead of toggling. The bottom-right cursor
panel permanently shows `Movement mode: World` or `Movement mode: Camera`, even when
the pointer leaves the canvas or resource picking updates the coordinates.
World retains the surface orbit and free movement. Camera left-drag rotates
only the viewing direction at a fixed position: drag left to look left, drag up
to look up by default. Invert vertical look reverses only Camera's vertical axis.
Pitch is clamped short of either vertical pole so mouse look cannot flip.

In Camera mode, all continuous movement (WASD, dolly, mouse/touch panning) and
projection-conversion travel is swept against the currently resident double-sided
3D surface before rendering. A center-ray sweep stops 0.25 m before the nearest
floor, ceiling or wall, including travel longer than thin barriers. Direction and
look-target distance are preserved when translation is shortened. Cutaway and
opacity do not remove physical collision; resource markers never collide.
Camera movement pauses explicitly until base geometry is resident. CCC restores
and home/north-up presets remain deliberate teleports and reset the sweep origin.
This is not the game's player capsule or exact collision union: coarse occupied
surfaces can close real passages, internal cube partition faces also collide,
and absent extraction geometry cannot block movement. Collision raycasts use
the existing morph-aware picking geometry during triangle transitions.
Clicking the map enables continuous WASD movement in both projections. In World
mode, W/S pan along camera yaw in the native X/Y plane and A/D strafe in that
same plane. Altitude (native Z), pitch, zoom, field of view and near plane stay
unchanged. The horizontal heading comes from camera-right, so an exact top-down
view still pans consistently without projecting a zero-length forward vector.
In Camera mode, W/S fly along the full view direction and A/D along camera-right,
with streamed terrain collision. Camera, look target and orbit
pivot translate together, preserving heading and focus distance. Diagonal travel
is normalized; Shift multiplies speed by four. Speed is captured from the
center-ray surface distance when movement starts, falling back to the look
target, at 40% of that distance per second clamped to 2–2000 m/s before Shift.
Frame elapsed time is capped at 50 ms to prevent a jump after a stalled frame.
Inputs are ignored in form controls/editable text and with Ctrl/Alt/Meta.
Focus loss, hidden pages, camera restore, presets, map changes and projection
changes stop movement. In Camera mode, orthographic W/S changes physical camera depth, not zoom;
wheel/pinch still controls apparent orthographic magnification.
Wheel and middle-drag physically dolly along the center ray, using the visible
resident collision skin there as the distance reference.
In Orthographic, wheel/middle-drag/pinch instead change the orthographic zoom
without translating the camera. Picking and triangle LOD error use orthographic
world-units-per-pixel; cubic refinement uses focus distance and visible view span
so zoom can request nearby detail despite the elevated camera position.
Movement is exponential in normalized wheel pixels (line/page deltas are
converted), so speed scales with distance to the landscape, not the old
map-center target. Travel has a minimum rate of 1 m per 100 normalized wheel
pixels, shared by wheel, middle-drag and pinch, so nearby walls cannot stall
movement. Surfaces are distance references, not collision barriers: scrolling
can pass through terrain to escape an enclosed view. The look target stays at
least 0.5 m ahead after crossing a surface, preventing OrbitControls from
reversing the camera. The field of view is unchanged, with a shorter near
clipping plane up close. If the center misses the surface,
the last look-target distance is retained as the reference. One-finger touch
orbits; two fingers retain panning and use the same surface-relative pinch dolly.
The native map dropdown has three sections: Canon (The Island, Scorched Earth,
Aberration, Extinction, Lost Colony, Genesis Main, Genesis Ocean), Official DLC
(alphabetical), and Other (alphabetical). Empty sections are omitted; new,
unclassified maps remain available under Other.
The Island is listed first and is the default map. The `map` query parameter
selects a map by its indexed key (for example, `/?map=TheIsland_WP`). Map changes
replace the current URL without adding history entries, preserving other query
parameters and the fragment. Shared URLs restore the selected map on startup;
browser history navigation also reads the URL. Unknown map keys display an error
instead of silently loading a different map. There is no browser-storage contract.
`window.arkApp` exposes
`switchToMap`, `getApplication`, `getAvailableMaps`, and `getCurrentMapData`
for diagnostics, plus the `ccc` capture/restore method described above.

### Optional reconstructed cubic world

Terrain metadata may additionally link `blockModel: { url: "blocks.json" }`.
The cube hierarchy loads by default when linked through `cubeModel`; the only
other selector option is Triangles, linked through `progressiveModel`.
Switching cancels previous downloads and releases geometry through the existing
world-layer lifecycle. Both modes keep complete coarse coverage. Maps without
either complete-base link report unavailability rather than falling back to
independent legacy tiles. Copy/Paste CCC remain visible regardless of debug mode.

Vertical block sides use the calibrated image UVs of their XY edge, stretched
vertically and averaged with nearby pixels as described above. The client assigns these triangles a separate mapped material group,
without changing source flags, positions, indices, or resident attribute budgets.
Covered horizontal faces use the same local average with angle-based shading.
Missing-image areas use dark charcoal instead of light gray. Side materials follow terrain opacity, lighting and clipping; mesh
mode retains its original source-based texture classification.

Blocks use the same validated, streamed AWM1 format, map
texture, clipping, picking and resource coordinates. They are preprocessed
occupancy volumes, not heightfield extrusions.
The offline exporter measures a strict >50% solid fraction directly from its
reconstructed classification grid (ties empty), emits only exposed faces and
greedily merges coplanar faces. A single block resolution avoids occupancy-LOD
seam mismatches. Source-slope coloring is disabled for blocks rather than
misrepresenting their axis-aligned normals as original collision walkability.
Optional block data is not downloaded until selected. Maps without either world
representation report that 3D extraction is unavailable.
Triangle degeneracy is checked in the original AWM centimeter coordinates.
Converting valid tiny faces to Float32 scene meters can make them sub-pixel or
zero-area for rendering; this rounding must not reject an otherwise valid tile.

## Source layout

- `main.ts`: application startup and error reporting.
- `viewer.ts`: production controls, rendering, navigation, and picking.
- `surface-navigation.ts`: surface-pivot rotation and distance-scaled physical dolly.
- `data/`: resource index, map loading, and coordinate types.
- `world/` and `clustering/`: resource clustering and spatial indexing.
- `resource-positions.ts`: recorded resource XYZ to centered scene coordinates.
- `map-navigation.ts`: map ordering and shareable URL selection.
- `terrain.ts`: calibrated 3D map bounds and model-link metadata validation.
- `map-image.ts`: image loading with explicit missing-image handling.
- `world-model.ts`, `progressive-world.ts`: 3D decoding, streaming, materials and refinement.

## Build commands

| Command              | Description                                  |
| -------------------- | -------------------------------------------- |
| `npm run build`      | Type-check, bundle the viewer, and run tests |
| `npm run build:core` | Rebuild the deployed `root/index.js` bundle  |
| `npm run typecheck`  | Check source types without writing output    |
| `npm test`           | Run the viewer's unit tests                  |
| `npm run dev`        | Serve `root` at http://localhost:8080        |

The deployed site has a single entry point at `/`. Resource maps and images live
under `root/data` and `root/images`; 3D map metadata and geometry live under `root/terrain`.
Repository configuration, workflows, and development tooling are retained.
