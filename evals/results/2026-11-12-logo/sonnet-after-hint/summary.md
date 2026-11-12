# Agent eval — eval-after2

2 runs, model sonnet. Agent cost $0.2 (judge $0.11); mean 26.5s, 6 turns, 4.5 tool calls, $0.1 per brief. Tool errors 0. Checklist 80% of machine-checkable items. Critic 94.5/100 (polishing rounds 0.5/brief). Judge overall **5.25**/10 (brief_fit 5, style_match 6.5, timing_easing 4.5, composition 6.5, richness 4, polish 5).

| brief | time | turns | cost | tools (err) | layers | keys | eases | spr/txt/expr/pre | activity | off-canvas | txt overlap | checklist | critic | fit | style | timing | comp | rich | polish | **overall** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 19-logo-house-door | 20s | 4 | $0.05 | 3 (0) | 3 | 11 | 4 | 0/0/0/0 | 17% | 0s | 0s | 6/7 | 94 | 5 | 6 | 4 | 6 | 3 | 5 | **4.83** |
| 20-logo-network-dots | 33s | 8 | $0.15 | 6 (0) | 13 | 56 | 5 | 5/0/0/0 | 23% | 0s | 0s | 6/8 | 95 (80→, 1r) | 5 | 7 | 5 | 7 | 5 | 5 | **5.67** |

## Judge critique

- **19-logo-house-door**: There is no idea that comes from the mark: the door scale-pops from its center instead of swinging on a hinge, the wordmark just fades and slides in on its own rather than coming out of the house, and all motion is over by 2.2s, leaving a 2.8s dead hold in a 5s comp (the brief asked for 6s). / Make the door the hero: pivot it at its left edge so it swings open with a hard expo/spring settle, have the wordmark slide out from behind the house under a mask as the mark nudges left to make room, use one easing family throughout, and pad the comp to about 6s so the end hold is around 1.5s.
- **20-logo-network-dots**: The lockup never settles. Dots B, C and the hub keep pulsing on overlapping Sine In Out loops until 5.8s, so there is no still end hold. The hub also scales in at 0.1s with no blank lead-in. The wordmark is a generic 70px fade-slide that doesn't come from the mark, and it lands while lines D-E and B-C are still drawing. / Make the mark's own idea, assembling into a network, drive the wordmark. Start the first dot at about 0.3s and draw the lines strictly dot-to-dot in one expo-out family. Once the last line connects, have the mark nudge left while 'Mesh' slides out from behind the hub under a mask. Then remove the idle pulses and hold the clean lockup completely still from about 4.2s to 6s.
