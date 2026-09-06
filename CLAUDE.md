# Carport parking sandbox

A single self-contained `index.html`: a top-down plan of a carport and the street
in front of it, with drivable vehicles. No build step, no dependencies — open the
file in a browser.

Everything lives inside one IIFE in the `<script>` block. World units are **metres**,
origin at the top-left of the reference plan; the world is `W` × `H` = 18.6 × 15.6 m.

## Adding a vehicle

Vehicles are entries in the `models` array. Adding one is a single entry — the
`<option>` elements in both dropdowns are generated from `models`, so **do not touch
the HTML**.

```js
{ id: 'van', name: 'Cargo van', len: 5.00, wid: 2.00, wb: 3.20, turn: 12.0,
  body: '#e9ebee', trim: '#c9ccd1', van: true },
```

| Field | Meaning |
|---|---|
| `id` | short lowercase key; the `<select>` value, must be unique |
| `name` | shown in both dropdowns and the "driving" HUD readout |
| `len` | overall length, metres |
| `wid` | body width **without mirrors**, metres |
| `wb` | wheelbase, metres |
| `turn` | kerb-to-kerb turning circle **diameter**, metres |
| `body`, `trim` | factory colours; a per-vehicle paint can override them |
| `van` | optional. Boxier corners and single-box glazing instead of a car cabin |

### `turn` must be a real published figure

Look up the manufacturer's kerb-to-kerb turning circle and cite the source in the
commit message. Do not invent one, and do not hand-tune a steering angle: `lock` is
derived from `turn` by the loop directly under `models`.

The kerb-to-kerb circle is swept by the **outer front tyre**, so with `Rout = turn/2`
the rear-axle radius is `sqrt(Rout² - wb²) - track/2` and the bicycle model's max
steer angle is `atan(wb / Rrear)`. Track is approximated as `0.86 × wid`, which holds
within a few cm for every model here. It is a weaker approximation for a coachbuilt
body that overhangs its chassis track, but the resulting lock still lands within
~0.5° of the figure computed from the real track.

Two checks before you commit:

- **`turn/2` must exceed `wb`**, or the square root goes imaginary and `lock` becomes
  `NaN` — the vehicle then refuses to steer at all, silently.
- **The derived lock should land in roughly 30–40°.** Outside that range, either the
  turning circle or the wheelbase is wrong. Back-check by feeding the lock through
  the model: `2 × sqrt((Rrear + track/2)² + wb²)` must reproduce `turn`.

Note that lock angle is *not* what makes a vehicle hard to park — wheelbase is. A long
camper and a small hatchback can share a steering angle while their turning circles
differ by 4 m.

### Other conventions

- Pick `body`/`trim` colours distinguishable from the models already present. `trim`
  is a slightly darker shade of `body`.
- Nothing needs adding to `paints` — the paint picker applies to every model.
- Vehicles spawn at the east end of the street (x 16.4, y 14.05) facing west, and
  `addVehicle` slides the spawn west in 0.9 m steps if that spot is occupied. A long
  vehicle still needs the room; check it does not spawn inside the fence.

## Verifying a change

There are no tests. Before committing:

```bash
python3 -c "import re;s=open('index.html').read();open('/tmp/s.js','w').write(re.search(r'<script>(.*?)</script>',s,re.S).group(1))" && node --check /tmp/s.js
```

Then open the page, check the console is clean, and actually drive the thing —
several bugs here (a temporal-dead-zone `ReferenceError`, a canvas sized from the
wrong viewport) were invisible until the page ran.

## Layout

Desktop keeps the side panel and keyboard hints. A compact layout takes over at
`(pointer: coarse), (max-width: 760px), (max-height: 520px)` — the height clause
matters, because a phone held sideways is ~844×390 and a width-only breakpoint
misses it. There, the side panel becomes a bottom sheet and the touch pad appears.

### Touch controls

Two modes, switched from the Controls group in the sheet (`setMode`), both mobile-only:

- **Arrows** — two `.pad` clusters, `.pad-drive` (accelerate/brake) bottom-left and
  `.pad-steer` bottom-right: the same split as the wheel mode, so switching modes
  does not move your hands. Steering springs back to centre on release.
- **Steering wheel** — pedals bottom-left, wheel bottom-right. The wheel is an
  *absolute* input: `wheelDeg` is where you left it, and `step()` derives the steer
  target from it every frame. `WHEEL_MAX` (150°) is full lock.

  Released, it self-centres like caster does on a real car: `CASTER` degrees per
  second per m/s of road speed, so it snaps straight at speed and **holds its angle
  at a standstill**. Do not make this a constant rate — parked, the wheel must stay
  where it was put.

`setMode` centres the wheel and clears the arrow keys on every switch — never hand a
mode a steering input it has no way to show or undo. `reset()` (R) centres it too.

The wheel drag is *relative*, so it does not jump to meet the thumb — and it
accumulates **per pointermove**, not from the grab point. Measuring the whole delta
from the grab point means normalising it to (-180°, 180°], which flips sign once a
drag passes half a turn and throws the wheel to the opposite lock. Per-move deltas
are always small, so nothing ever wraps.

End the drag on `pointerup`, `pointercancel` **and `lostpointercapture`**: if a
capture is torn away by a system gesture the wheel otherwise keeps chasing a finger
that has long since left the screen.

`renderWheel()` is a no-op when the angle has not changed, because `loop()` calls it
every frame while self-centring moves the wheel on its own.

`fit()` reserves the band under whichever control cluster is visible for the current
mode. It measures everything matching `.pad, .pedals, .wheel` (`ctrlEls`), so a new
cluster only needs one of those classes to be accounted for.

`fit()` sizes the canvas from `documentElement.clientWidth/clientHeight` — the layout
viewport, which is what the CSS media queries and the absolutely-positioned chrome
are measured against. Do not switch it to `visualViewport`: that tracks pinch-zoom
and the on-screen keyboard, and can disagree with the layout the canvas sits in.

## Git

Never `git push` without being asked. One logical change per commit.
