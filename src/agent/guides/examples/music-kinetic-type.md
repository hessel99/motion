# Example: Kinetic type cut to music (120 BPM): words on downbeats, not on every beat
> tags: music, song, beat, bpm, rhythm, audio, kinetic, type, words, lyric, drop, sync, energetic, promo, cut to the beat

## Brief
"Kinetic type for our launch track (120 BPM, 4/4): MOVE / FAST / BREAK / THINGS, then the drop with the logo word NOW. 8 s."

## Tool calls
```json
[
  {"tool": "get_audio_analysis", "args": {}},
  {"tool": "build_scene", "args": {
    "comp": {"duration": 8, "background": "#111014"},
    "layers": [
      {"key": "w1", "text": "MOVE", "fontSize": 220, "fontWeight": 900, "tracking": -8, "align": "center", "center": [960, 540], "fill": "#F4F4F5",
       "animate": {"scale": [{"t": 0.0, "v": 130, "ease": "Expo Out"}, {"t": 0.35, "v": 100}], "opacity": [{"t": 0.0, "v": 0, "ease": "Ease Out"}, {"t": 0.15, "v": 100}, {"t": 1.9, "v": 100, "ease": "Ease In"}, {"t": 2.0, "v": 0}]}},
      {"key": "w2", "text": "FAST", "fontSize": 220, "fontWeight": 900, "tracking": -8, "align": "center", "center": [960, 540], "fill": "#A3E635",
       "animate": {"position": [{"t": 2.0, "v": [1360, 540], "ease": "Expo Out"}, {"t": 2.35, "v": [960, 540]}], "opacity": [{"t": 2.0, "v": 0, "ease": "Ease Out"}, {"t": 2.12, "v": 100}, {"t": 3.4, "v": 100, "ease": "Ease In"}, {"t": 3.5, "v": 0}]}},
      {"key": "w3", "text": "BREAK", "fontSize": 220, "fontWeight": 900, "tracking": -8, "align": "center", "center": [960, 540], "fill": "#F4F4F5",
       "animate": {"rotation": [{"t": 3.5, "v": -8, "ease": "spring:0.4"}, {"t": 4.0, "v": 0}], "opacity": [{"t": 3.5, "v": 0, "interp": "hold"}, {"t": 3.52, "v": 100}, {"t": 4.9, "v": 100, "ease": "Ease In"}, {"t": 5.0, "v": 0}]}},
      {"key": "w4", "text": "THINGS", "fontSize": 220, "fontWeight": 900, "tracking": -8, "align": "center", "center": [960, 540], "fill": "#F4F4F5",
       "animate": {"position": [{"t": 5.0, "v": [960, 640], "ease": "Expo Out"}, {"t": 5.3, "v": [960, 540]}], "opacity": [{"t": 5.0, "v": 0, "ease": "Ease Out"}, {"t": 5.12, "v": 100}, {"t": 5.9, "v": 100, "ease": "Ease In"}, {"t": 6.0, "v": 0}]}},
      {"key": "flash", "type": "rect", "x": 0, "y": 0, "w": 1920, "h": 1080, "fill": "#A3E635",
       "animate": {"opacity": [{"t": 6.0, "v": 0, "interp": "hold"}, {"t": 6.02, "v": 100, "ease": "Expo Out"}, {"t": 6.4, "v": 0}]}},
      {"key": "now", "text": "NOW", "fontSize": 360, "fontWeight": 900, "tracking": -14, "align": "center", "center": [960, 540], "fill": "#A3E635",
       "animate": {"scale": [{"t": 6.0, "v": 160, "ease": "Expo Out"}, {"t": 6.4, "v": 100}], "opacity": [{"t": 6.0, "v": 0, "interp": "hold"}, {"t": 6.02, "v": 100}]},
       "expr": {"scale": "value + [4*audio('beat', 0.3), 4*audio('beat', 0.3)]"}},
      {"key": "bar", "type": "rect", "x": 760, "y": 760, "w": 400, "h": 12, "fill": "#A3E635", "anchor": "left",
       "animate": {"scale": [{"t": 0.0, "v": [0, 100], "ease": "Linear"}, {"t": 6.0, "v": [100, 100]}]}}
    ]}},
  {"tool": "sync_to_audio", "args": {"mode": "bars"}}
]
```

## Why it works
- 120 BPM = a beat every 0.5 s, a bar every 2 s. Each word lands on a downbeat or half-bar (0, 2, 3.5, 5) and the drop (NOW + flash) hits the bar at 6 s: big moves on strong beats, the beats in between are left empty (restraint reads as rhythm).
- Every word gets a different entrance (scale punch, slide, rotation snap, rise) in the same snappy family (Expo Out, hold cuts): variety without chaos.
- Words never overlap: each one leaves on the frame the next arrives (cut on the beat).
- After the drop, NOW pulses with the music (an audio('beat') expression) and a progress bar fills linearly over the build: secondary motion tied to the track.
- With a real track: read get_audio_analysis first, then put the words on its bars / accents; sync_to_audio {mode: "bars"} snaps the landings to the analysed grid.
