# 3D-ish parallax
> Depth without 3D: layered planes moving at different speeds, scale-based dolly, soft shadows and atmospheric fades.

**Use for**: product showcases, landscapes/travel, app screens floating in space, cinematic intros.

## Palette
- Depth ramp: far `#1E2A4A` → mid `#3B4F7A` → near `#F2C57C`, or the brand with darker/desaturated far layers.
- Shadows `#000000` at 20–35 % opacity (soft ellipses under objects).

## Shapes
3–5 depth planes (one group per plane): background shapes, midground objects, foreground elements; device/card mockups with shadow ellipses. Far planes larger, lower contrast.

## Typography
Inter 700, 72–140 px, letterSpacing −0.02 × size, on its own plane (closest or mid). Support 32–40 px.

## Easing & timing
Family: `Cubic In Out`, `Quart In Out` for camera moves, `Expo Out` for arrivals. Camera moves 1.5–4 s. Parallax ratios of the camera move: far 0.2x, mid 0.5x, near 1.0x, overlays 1.3x (for both position and scale change).

## Signature moves
- Dolly in: planes scale up from the frame center: far 100 → 104, mid 100 → 110, near 100 → 125 over 3 s (`Cubic In Out`).
- Truck: planes shift horizontally by ratio (near −300 px, mid −150, far −60).
- Floating cards: position y sine expression with a phase per card (amplitude 6–12 px, period 3–4 s), rotation ±2°.
- Shadow sync: the shadow ellipse shrinks and fades as the object lifts.

## Transitions
Fly-through: the near plane scales past the camera (100 → 300, opacity → 0), revealing the next scene behind it.

## Do / Don't
- Do: consistent depth ratios, atmospheric contrast (far = low contrast), slow camera.
- Don't: all planes at one speed, cuts during camera moves, more than 6 planes.

## Mini scene plan (10 s)
1. 0–4 s: mountains in 3 planes; slow dolly in with parallax ratios; the title on the mid plane fades up.
2. 4–7 s: a phone mockup rises from below with its shadow; cards float around it with phased sines.
3. 7–10 s: fly through the near plane into the logo end card.
