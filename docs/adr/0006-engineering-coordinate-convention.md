# ADR-0006: East-North-Up engineering frame, with an explicit renderer mapping

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** Phase 1

## Context

Phase 1 introduces motion, which means every position, velocity and bearing now
has to be expressed in some frame. Two conventions are in play and they
disagree.

The domain convention is East-North-Up: pointing mounts, geodetic references and
every FSOC paper the project will be checked against use a Z-up local tangent
frame, with azimuth measured clockwise from North. The renderer's convention is
Three.js's, which is Y-up.

There is a third pressure. A pointing error caused by a frame mix-up looks
exactly like a tracking bug: the numbers are plausible, nothing throws, and the
tracker simply performs badly. That failure mode is the reason to decide this
once, in writing, rather than per module.

## Decision

**The engineering frame is `world-enu`.** X is East, Y is North, Z is Up, in
metres, right-handed so that `East x North = Up`. The origin is the scenario
datum and the frame is treated as inertial.

**Azimuth is clockwise from North** about +Up, wrapped to (-pi, pi]. North is
zero and East is +pi/2. **Elevation is positive upward** from the horizontal
plane, in [-pi/2, +pi/2].

It is worth stating plainly that azimuth is therefore a _left-handed_ rotation
about +Up even though the frame is right-handed. That is the compass
convention, it is what every gimbal datasheet uses, and choosing the
mathematical convention instead would produce numbers that disagree with the
hardware this project is eventually meant to drive.

**Angles in the core are radians.** Degrees appear at configuration and display
boundaries only, and the branded unit types from Phase 0 make a mix-up a
compile error rather than a silent factor of 57.

**The renderer mapping is explicit and lives in one function.**

```
  renderer.x =  east
  renderer.y =  up
  renderer.z = -north
```

North maps to -Z so that a default Three.js camera, which looks down -Z, faces
North: the scene reads like a map, with North away from the viewer and East to
the right. The mapping has determinant +1, so it is a rotation and preserves
handedness. Scene units are metres with no scale factor.

The domain convention is **not** changed to match Three.js. The renderer is a
consumer; consumers convert.

## Consequences

- Bearings computed in the core can be compared directly against hardware
  readings and published figures, with no convention note attached.
- The conversion exists in exactly one place, `core/simulation/coordinates.ts`,
  and is tested: axis mapping, round trip, handedness via a preserved cross
  product, and preservation of lengths and angles.
- Anyone writing renderer code has to remember that the axes are not the domain
  axes. The legend in the observer view states the mapping on screen, and the
  adapter converts before anything reaches a component, so the number of places
  this can be got wrong is small.
- A mirrored mapping would have passed a naive axis test while flipping every
  cross product and every azimuth drawn. The handedness test exists because
  that failure would otherwise be invisible.
- Azimuth is undefined when a target is directly overhead. It is reported as
  zero, with elevation carrying the full answer, rather than NaN.

## Alternatives considered

**North-East-Down.** Standard in aerospace and flight dynamics. Rejected
because AstraLock-X is a ground-referenced pointing tool where "up" being
positive matters constantly for readability, and because elevation being
positive downward would be a permanent source of sign errors in a project whose
whole subject is elevation angles.

**Adopting Three.js's Y-up frame as the engineering frame.** Removes the
conversion entirely. Rejected outright: it would make the renderer's
convenience the authority for the physics, which is the inversion ADR-0002
exists to prevent, and every bearing the system produced would need a
translation note before it could be compared with anything real.

**Converting at each call site rather than in an adapter.** Fewer indirections.
Rejected because it multiplies the number of places a sign can be dropped, and
because the conversion would then be untestable as a unit.
