# Motion — market research (Nov 2026)

Web research by an agent (search only; some sites were not reachable). Effect ranking is a synthesis, not survey data. Links in the original agent report; key sources listed per section.

## 1. Top pain points (After Effects and newer tools)
1. RAM preview far below real time, even on big machines (Adobe community threads).
2. Memory bloat; previews degrade until restart.
3. Weak multi-core / GPU use.
4. Instability and crashes, worse per release.
5. Motion blur and glow kill interactivity — people switch them off while animating.
6. Easing is clumsy (separate dimensions, no native springs) → paid plugins (Flow, Ease and Wizz).
7. Expression dependence for bounce/wiggle/loops; expressions don't survive Lottie.
8. Lottie handoff breaks (effects dropped, preview ≠ runtime).
9. Figma → AE import is lossy (AEUX/Overlord: text, invisible layers).
10. Plugin dependence and cost; updates break plugins.
11. Adobe subscription resentment.
12. No procedural repetition (duplicate + stagger needs expressions).
13. Confusing UI and effect naming.
14. Collaboration bolted on.
15. Newer tools: Jitter lags with images and lacks depth, Lottielab stability, Rive state machines hard for designers, Figma Motion lacks global time-stretch/looping.

## 2. Why newer tools are loved
- **Jitter**: zero install, low learning curve, clean Figma import, templates. Complaints: lag, few effects, free-tier limits.
- **Rive**: interactive state machines, tiny runtimes, Luau scripting (2026). Complaints: learning curve, devs needed to wire state machines.
- **Cavalry** (Canva, free tier): procedural Duplicator + Stagger, real-time playback. Complaints: smaller ecosystem.
- **Figma Motion** (Config 2026 beta): timeline on canvas, presets, springs, motion variables, Dev Mode export. Complaints: springs sampled in Lottie, effects don't export, paid seat.
- **Lottielab**: design-tool feel, AI "Magic Animator" from Figma frames, multiplayer. Complaints: stability, missing pro features.

## 3. AI in motion tools
- Today: AE AI Assistant (beta 2026, credits, per-action approval), Jitter AI + agents + MCP (Oct 2026), Rive AI coding agent + headless CLI for agents, Figma Motion agent features, community AE MCP servers.
- Designers want AI for tedious work: expressions, organizing/renaming, batch edits, versions/sizes, Lottie checks.
- Fears: jobs, generic output, loss of control, credit fees, training on their data.
- **Implication for Motion**: AI must produce editable keyframes (never baked pixels), reviewable change-sets, undo; "your own subscription, no training on your files" is a headline.

## 4. Effects by frequency (synthesis)
1. Motion blur · 2. Gaussian / directional blur · 3. Drop / inner shadow · 4. Glow · 5. Fill/tint, gradient ramp, color correction · 6. Mattes/masks with feather · 7. Trim/offset/repeater · 8. Turbulent displace, wiggle paths · 9. Noise/grain · 10. Echo/trails · 11. Motion tile/mirror · 12. Fractal noise · 13. Chromatic aberration · 14. Wave warp/ripple · 15. Particles.

Expectations: blur, shadow, glow, tint, mattes, trim — real-time at full fps. Motion blur real-time in draft mode, sample-accurate on export. Displace/noise/echo real-time at preview resolution. Particles may cache. Show a "Lottie-safe" badge per effect.

## 5. Proposed roadmap
- **v0.5 solid basics**: shapes, transforms, timeline, eases + springs, 60 fps with 1k+ layers, undo, MP4, first MCP tools.
- **v0.6 design-tool parity**: Figma paste, text, fills, masks/mattes, Lottie export with compatibility lint. Effects: drop shadow, gaussian blur.
- **v0.7 motion craft**: speed/value graphs, precomps, parenting, trim, repeater/stagger duplicator. Effects: motion blur (GPU sub-frame), glow.
- **v0.8 interop**: Lottie/AE import, built-in wiggle/loop behaviors, expressions. Effects: tint + color correction, noise/grain.
- **v0.9 collaboration + agent**: multiplayer, comments, agent approval queue and diff previews. Effects: turbulent displace, echo.
- **v1.0 pro**: motion tile, chromatic aberration, GPU particles, 2.5D camera, audio markers, code export (CSS/React/Swift springs), templates.

## Signature differentiators
1. **Never drop a frame** — real-time motion blur and glow, visible fps/budget meter.
2. **Springs and easing as tokens** — shared variables that round-trip with Figma Motion and export to CSS/iOS/Android.
3. **Same render everywhere** — one renderer for editor, export and runtime; per-property Lottie-safety lint.
4. **Bring-your-own-model agent** — edits keyframes not pixels, reviewable change-sets, parallel variations, no training on files.
5. **Procedural without expressions** — duplicator, stagger, wiggle, loop, follow-path as visual behaviors.
