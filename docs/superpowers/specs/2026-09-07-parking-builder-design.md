# Parking builder — design

Date: 2026-09-07
Status: approved design, not yet planned for implementation

## Purpose

Let users build their own parking layouts instead of driving the one hardcoded
carport, and package a layout as a self-contained entity that another user can open
and QA — "can a 7 m camper actually get into bay 2?"

The builder is the priority. Plants, obstacles and surface areas are designed only as
far as the extension seam. Sharing is designed as a document, not a transport.

## Decisions

| Question | Decision |
|---|---|
| What is it for | Accurate real-world planning first; data model general enough for challenge/puzzle features later |
| Today's hardcoded scene | Becomes layout #1. Nothing downstream reads literals |
| Wall connection | Shared corner nodes referenced by id |
| Sharing | Design the packable document only; transport deferred, server-backed later |
| Builder platform | Desktop only. Phones keep today's drive-only experience and can QA shared layouts |
| What QA means | The layout carries a brief (target bays + intended vehicles); a reviewer drives it and the outcome is recorded |
| Code layout | One `index.html` for the MVP, split into namespaces so the later move to modules is mechanical |
| Tests | Yes, for the three pure units only |
| Item/area scope | Registry contract and type list only |

## Architecture

Three layers, one direction of flow:

```
layout document  ──compile()──▶  runtime artifacts  ──▶  render + physics
   (editable,                    (solids, drawList,
    serialisable)                 extent, bays)
```

Nothing downstream reads literals; nothing downstream mutates the document. The
editor mutates the document and recompiles. Layouts are tens of items, so recompiling
wholesale on every edit is far simpler than incremental invalidation and costs
nothing measurable.

Seven namespaces inside the one file, each the shape of a future module:

| Namespace | Responsibility | Depends on |
|---|---|---|
| `geom` | SAT, quad-from-nodes. No app state | — |
| `layout` | Schema, validate, migrate, pack/unpack | — |
| `registry` | Type table: kind, z, solid, footprint, draw | — |
| `compile` | Document → solids, drawList, bounds, bays | `geom`, `registry` |
| `sim` | Physics. Essentially unchanged | `geom` |
| `render` | Canvas painting, camera | `registry` |
| `editor` | Tools, selection, snapping, undo, properties panel | all of the above |

Only `editor` and `render` touch the DOM. The MVP keeps one file; the split to
modules later is one file per namespace with no logic changes.

## The layout document

```js
{
  v: 1,                                  // schema version
  id: "lay_h7k2…",                       // stable identity, for the server later
  name: "Carport",
  plot: { w: 18.6, h: 15.6 },            // world extent; replaces the W/H constants
  nodes: { n1: [2.25, 0], n2: [2.25, 11.35] },
  walls: [ { id, from: "n1", to: "n2", t: 0.22, type: "wall" } ],
  areas: [ { id, type: "gravel", poly: [[x, y], …] } ],
  items: [ { id, type: "palm", at: [13.1, 1.4], a: 0 } ],
  bays:  [ { id, rect: [x, y, w, h], a: 0, label: "Bay 2" } ],
  dims:  [ { from: [x, y], to: [x, y], label: "7,98 m" } ],
  spawn: { at: [16.4, 14.05], a: 3.1416 },
  brief: { targets: ["bay2"], vehicles: [ … ], notes: "" }
}
```

Nodes are shared points referenced by id. That is what makes walls genuinely
connected rather than coincidentally adjacent, and it is the reason dragging a corner
moves every wall that meets there.

`solid` is deliberately **not** stored per instance. It comes from the type registry,
so it cannot drift between two instances of the same type and the document stays
compact.

### The vehicle snapshot

`brief.vehicles` stores each vehicle's id **and** a snapshot of the four fields that
affect physics:

```js
{ id: "camper", len: 7.00, wid: 2.30, wb: 4.035, turn: 14.4 }
```

Resolve by id when it still exists in the library, fall back to the snapshot when it
does not. The vehicle library is app data, not layout data — a brief that says only
`"camper"` silently changes meaning if that model is ever retuned, and the entire
point of QA is that the reviewer drives the car the author meant.

### Packing

`pack(layout)` returns a plain JSON-safe object: absolute metres, no app references,
no derived state. `unpack(json)` validates, migrates and returns either a document or
a list of errors. Both are transport-agnostic by construction — no URL encoding, no
compression, no server calls. A future server posts the output of `pack` unchanged.

Version migration is a chain keyed by `v`, applied in order until current.

## Type registry

One entry per type, owning everything that varies between types:

```js
wall:    { kind: 'wall', solid: true,  layers: [ { z: 40, stroke: '#a3a8ae' } ] }
gravel:  { kind: 'area', solid: false, layers: [ { z: 12, draw(g, a, view) { … } } ] }
bollard: { kind: 'item', solid: true,  footprint: { r: 0.12 }, layers: [ … ] }
deck:    { kind: 'item', solid: true,  footprint: { w: 10.47, h: 1.76 },
           layers: [ { z: 20, draw: deckPlanks } ] }
carport: { kind: 'item', solid: false,
           layers: [ { z: 30, draw: carportFloor },     // under the cars
                     { z: 60, draw: carportSlats } ] }  // over them
```

- `kind` — which document array the type may appear in. Enforced by validation.
- `layers` — one or more draw passes, each with its own `z`. A single `z` per type is
  not enough: today's carport paints its floor *under* the vehicles and its slatted
  roof and shadow band *over* them. Compile emits one drawList entry per
  (instance, layer).
- `solid` + `footprint` — whether compile emits a collision quad. A footprint is
  either `{ w, h }` for a rect or `{ r }` for a circle, the latter approximated as a
  quad.
- `draw` — the renderer for types with bespoke appearance.

Adding a type is a registry entry plus an editor palette row: no schema change and no
compile change. Today's ornament satisfies this — the carport's slat hatching and
clip region, the deck, and the palm fronds stay as registry `draw` functions
parameterised by their placement.

Intended types beyond the MVP, listed so the MVP can be validated against them:

| Type | kind | solid | Note |
|---|---|---|---|
| `grass`, `gravel`, `paving` | area | no | Surface appearance only in the MVP |
| `hedge`, `flowerbed` | area | no | |
| `palm`, `tree`, `shrub` | item | no | Canopy drawn over vehicles |
| `bollard`, `binstore`, `planter` | item | yes | Circular footprint approximated as a quad |
| `wall`, `fence`, `kerb`, `frame`, `post` | wall | yes | MVP set |
| `deck` | item | yes | Rect footprint. Solid today, and must stay so |
| `carport` | item | no | Drawn shell only; its beams and posts are `wall` entries |

## Wall geometry and compile

A wall is a rotated quad. From nodes `p` and `q`: centreline `p→q`, angle
`atan2(qy−py, qx−px)`, length `|q−p|`, quad = the centreline extruded `t/2` either
side. That feeds the existing `collide(corners, angle)` unchanged — the same call
vehicles already make. Static geometry simply stops being the only thing passing
angle `0`. **No physics changes.**

### Collision does not need mitred joints

Two walls meeting at a corner produce overlapping quads, and for a union of solids
overlap is harmless: a car that hits either quad is blocked, which is correct. So
collision stays one plain quad per wall — no convex decomposition, no joint geometry.

### Rendering mitres via canvas stroking

Group walls into *runs*: chains through nodes of degree 2 sharing thickness and type.
Stroke each run as a single path with `lineWidth = t`, `lineJoin = 'miter'` and a
`miterLimit`. The browser handles corner mitring and degenerate near-parallel joints
for free. Runs break at three points: a junction of degree ≥ 3, a thickness change, or
a type change. At degree-≥3 junctions strokes simply overlap, which is invisible when
they share a colour.

This replaces several hundred lines of offset-polygon and mitre-limit code with a
handful.

### Compile output

```js
{ extent:   { w, h },
  solids:   [ { corners, a } ],   // walls + solid items, ready for collide()
  bounds:   [ … ],                // derived from extent, not hand-written
  drawList: [ { z, type, … } ],   // sorted by registry z
  bays, spawn, brief }
```

`compiled.solids` replaces both places that read the world today, which deletes the
`staticObstacles[1]`-by-index deck lookup outright. `drawList` sorted by layer `z`
replaces the hardcoded paint order.

**Vehicles paint in the middle of that order**, not on top: today they are drawn after
the ground, walls and bay outlines but *before* the carport slats, palms and dimension
lines. So the renderer walks drawList up to `VEHICLE_Z` (50), draws the vehicles, then
walks the rest. Treating vehicles as a final overlay would visibly change the scene.

Compile enforces invariants: referenced nodes exist, no zero-length walls, `t > 0`,
polygons have ≥ 3 points, degree-0 nodes are garbage-collected.

### Camera

`plot.w/h` replaces the `W`/`H` constants, so `bounds` becomes derived. A user plot
can exceed the screen, so `render` gains a `view { scale, ox, oy }` and today's
`fit()` becomes one way to set it. Drive mode behaviour is unchanged; pan/zoom is
editor-only.

## Editor interaction model

### Input routing

Today's `keydown` handler is global: arrows drive, `r` resets. Build mode must not
pass those to the car, and editor shortcuts must not fire while typing in the
properties panel. The existing guard skips `SELECT` and `BUTTON` but **not `INPUT`**,
so typing `3.5` into a thickness field would today also trigger the `r` reset. Input
routing becomes mode-aware with an explicit text-field guard.

### Tools

Select/move, wall, bay. Nothing else in the MVP.

### Drawing

Press-drag-release draws one wall. Click, click, click chains a run, ending on `Esc`,
`Enter` or double-click. Chaining is what makes connecting walls feel native rather
than a snapping trick.

### Snapping

Candidates in priority order, all evaluated in **screen pixels (~10 px)** so the feel
is independent of zoom:

1. existing node — the merge case
2. wall centreline — drops a node onto it and **splits that wall in two**, sharing the
   new node, producing a real T junction
3. grid, 0.5 m
4. angle, 15° increments

Snapping is on by default, since most walls in a plan are orthogonal, with `Alt` to
suspend all of it. The live snap target is drawn so the user always knows what they
are about to connect to.

### Dragging

- Drag a node: every wall sharing it follows.
- Drag a wall body: both its nodes move, so connected neighbours stretch to follow.
- Drop a node within snap radius of another: they **merge** — the dragged node is
  deleted, its walls repointed, and any wall left with two identical endpoints is
  dropped.

### Properties panel

Thickness, length, angle, type for the selection.

Length carries a real ambiguity: with shared nodes, changing it must move one
endpoint, and which one is not obvious. Rule: hold the anchor end fixed and move the
far end along the current direction, with an anchor toggle (`⟵ ▪ ⟶`) in the panel.

Multi-select applies thickness and type to all; length and angle are disabled.

### Undo/redo

Snapshot the document before each committed mutation, stack capped around 50.
A drag commits **one** snapshot on release, never per `pointermove`.

### Guardrails

Drags under ~0.1 m abort rather than creating a degenerate wall. Thickness clamps to
0.02–1 m. Nodes clamp to the plot. A bay overlapping a solid or falling outside the
plot **warns rather than blocks** — it is a plan, and being told the bay is too tight
is the point of the tool.

## Brief and QA

```js
brief: {
  targets:  ["bay2"],
  vehicles: [ { id: "camper", len: 7.00, wid: 2.30, wb: 4.035, turn: 14.4 } ],
  notes:    "Can the camper get in without hitting the deck?"
}
```

Opening a layout with a brief spawns the briefed vehicle at `spawn`, highlights the
target bays and shows the notes.

Parking detection reuses the pattern this project had in its level-1 version: all four
corners inside the bay, heading within ~12°, speed under 0.05, held for ~1 s.

### Results are a separate entity

```js
QAResult { layoutId, layoutHash, outcome: { parked, collisions, seconds }, vehicleId, at }
```

A result is **never** written into the layout. The layout is the author's document; a
result is the reviewer's observation. `layoutHash` is what stops a result being
attributed to a layout that has since been edited — a stale "the camper fits" is worse
than no answer at all.

The MVP handles one target and one vehicle. The schema uses arrays so multiple pairs
can be added without a version bump.

## Migrating today's scene

Today's scene converts once into the default layout. That default must be an **inline
object literal, not a fetched `.json` file**: `fetch()` over `file://` is CORS-blocked,
and the app must keep opening by double-clicking `index.html`.

Conversion is per-kind and hand-checked once:

| Today | Becomes |
|---|---|
| 8 of the 9 `staticObstacles` boxes | walls — thickness from the short dimension, nodes along the long axis |
| `deck` (the 9th) | solid item with a rect footprint, **not** an area — it blocks the car today |
| `apron`, `path` | areas — painted surfaces, non-solid today |
| `carport` | item with a bespoke renderer (slats, shadow band, clip) |
| `palms` | items |
| `bays` | bays |
| 5 `drawDim` calls | dims |
| `W`, `H` | `plot` |
| spawn at 16.4/14.05 | `spawn` |

Note the boxes are not centrelines: a 0.22 × 11.35 wall box becomes a node pair along
its long axis with `t = 0.22`. The deck at 10.47 × 1.76 is not a wall at all — it is an
area — but a *solid* one, so it becomes a solid item rather than a surface area.
Hence per-kind conversion rather than a loop.

### Acceptance criteria

1. Compiled solids for the converted layout equal today's nine obstacle rects —
   eight walls plus the deck item. Any mismatch means driving behaviour changed.
2. The rendered converted layout matches the current screen.
3. Driving behaviour is unchanged: same collisions, same spawn, same feel.
4. `unpack(pack(default))` deep-equals `default`.
5. The builder can reproduce the converted layout from scratch — every element in it
   is reachable through the editor, except dims (see Out of scope).

## Validation and error handling

`unpack` treats input as hostile, because documents will arrive from a server:

- Every field type-checked; numbers clamped to sane ranges.
- **Every coordinate explicitly asserted finite.** A single `NaN` does not make SAT
  miss cleanly and does not throw: it returns a bogus collision with `d = NaN`, which
  pushes the vehicle to `NaN` coordinates and it vanishes. Verified against the real
  `collide`, which returns `{d: NaN, nx: 1, ny: 0}` for an all-`NaN` quad. This project
  has already been bitten once by a silent `NaN` — see the `lock` warning in CLAUDE.md.
- Unknown `type` values **warn and skip, not fail the load**, so a newer layout still
  mostly renders in an older client.
- Unknown top-level keys are preserved through pack/unpack so a round-trip in an older
  client does not destroy newer data.

## Testing

The project has no tests, which has been fine for a canvas toy. This feature
introduces the first pure units that fail *silently*, so the MVP adds a single
`node --test` file covering three namespaces only:

- `geom` — quad-from-nodes, SAT edge cases.
- `layout` — validate, migrate, and `unpack(pack(doc))` deep-equals `doc` as the
  cheapest high-value property.
- `compile` — document → solids and drawList, including the degree-≥3 junction and
  thickness-change run splits.

Rendering and interaction stay eyeball-verified exactly as they are today: extract the
script, `node --check`, then open the page and drive it.

## Out of scope

- **Transport for sharing.** Server-backed, later. This design stops at `pack`/`unpack`.
- **Dimension authoring.** `dims` are in the schema and rendered, so today's five
  survive migration, but no tool creates them in the MVP.
- **Touch editing.** Desktop builds, mobile drives.
- **Area and item tools.** Registry contract and type list only.
- **Automatic feasibility checking.** A reviewer drives; the app does not solve.
- **Surface physics.** Noted below.

## Risks and traps

| Risk | Mitigation |
|---|---|
| `fetch()` of a layout JSON fails over `file://` | Default layout is an inline literal |
| ES modules are CORS-blocked over `file://` | One file for the MVP; namespaces, not modules |
| A `NaN` coordinate yields a `NaN` push vector that teleports the vehicle | Assert finite on every coordinate in `unpack` |
| `r` reset fires while typing in a number field | Mode-aware input routing with an `INPUT` guard |
| Undo stack fills with drag intermediates | One snapshot per drag, on release |
| Stale QA result attributed to an edited layout | `layoutHash` on `QAResult` |
| Editor grows the single file past comfort | Namespace boundaries drawn at the future module seams |

**Surface physics is the one future item that is not additive.** "Grass and gravel slow
you down" needs a per-vehicle, per-frame surface query inside `step()`. Everything else
on the item/area list is a registry entry. Worth knowing before anyone assumes areas
are free.
