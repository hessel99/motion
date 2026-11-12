# Components

> Animated components: make a logo sting / lower third / title card reusable, expose its text and colors, add formats and themes, place instances with their own timing, build a showreel.

## When to make a component
- A piece that is used again with other content or in other places: logo sting, lower third, title card, end card, transition wipe, a social cut of the same piece, cards in a showreel.
- Not for one-off scenes (use precompose) and not for interactive states: there are no state machines here.
- Build and animate the piece first (top-level layers of the active composition), then make_component {ids, name}. Its layers move into their own composition; one instance stays in place.

## Anatomy
- Component = a composition (layers + animation + duration) with named parts. make_component finds in / hold / out when the animation rests in the middle; otherwise set_component_parts {parts: [{name: "in", from: 0, to: 0.6}, ...]}.
- Properties = what an instance may change. expose_property {component, name, layer, field}:
  - "text" (titles, names, roles), "fill" / "stroke" (accent color), "image" (logo swap), "visible" (show / hide a part: subtitle, badge)
  - "opacity" / "rotation" / "scale": a number; on an animated property it scales the swing (intensity)
  - "delay": seconds that layer starts later (stagger knob)
  - one property may drive several layers (targets), e.g. "Accent" on the bar and the underline
- Variants = the same layers and animation with differences, one per group, combinable:
  - Format: add_variant {formats: ["9:16", "1:1", "4:5"]} lays them out responsively (backgrounds stretch, content fits 90%). Check each with open_composition + edit_variant + contact_sheet, fix positions / sizes / font sizes while it is shown, then edit_variant {variant: null}.
  - Theme (Dark / Light): add_variant {group: "Theme", name: "Dark"}, edit_variant, recolor, edit_variant null.
  - Language: group "Language", change the texts while shown.
  - Cut: group "Cut" name "Short" with play {speed: 1.5} or {range: "in"}: a default timing.
  - Keyframe timing edited while a variant is shown applies to every variant: animate once.

## Instances are time-aware
- start: when it begins. play:
  - range "in" | "hold" | "out" (or from / to in seconds)
  - duration: stretch the played part to N seconds (a 3s card in a 2s slot), or speed
  - loop "loop" | "pingpong" (loops: count), reverse, hold "first" | "last" | "both" (freeze before / after)
- Typical: logo sting at the end of a video: start 8, hold "last". A looping badge: range "hold", loop "loop". A transition wipe: play {duration: 0.6}; reversed for the way out.

## Recipes
- "Make this logo sting a component with text and colour properties": make_component {ids, name: "Logo sting"} → list_components → expose_property Title (text) and Brand color (fill of the mark, targets for every layer in that color) → add_variant formats if social versions are wanted.
- Lower third: name + role texts exposed, accent fill, "Show role" visible toggle. Instances: add_component_instance {values: {Name: "Ada Lovelace", Role: "Engineer"}, start, play: {hold: "none"}}.
- "Build a showreel of 6 title cards from the Title component": build_sequence {component: "Title", into: "Showreel", overlap: 0.3, items: [{values: {Title: "..."}, duration: 2}, ...]}. Then contact_sheet. Vertical version: build_sequence again with into: "Showreel 9:16", variants {Format: "9:16"}.
- End card: hold "last" so it stays to the end; exposed CTA text and URL.
- Change one instance later: set_instance {ids, values / variants / play}.

## Rules
- Edit the component itself (open_composition on it) to change what every instance shows; use properties for per-instance differences. Do not detach.
- Prefer few, well-named properties (Title, Subtitle, Accent, Logo, Show badge) over exposing everything.
- Name parts in / hold / out when the piece has an entrance and an exit, so instances can trim or loop them.
- After building, look: contact_sheet on the composition with the instances.
