# Example: Social promo, vertical 9:16 product drop with price and CTA
> tags: social, promo, ad, instagram, tiktok, story, reel, vertical, 9:16, product, sale, launch, price, cta, offer, shop, energetic

## Brief
"A 6 s vertical ad for our new sneaker 'AIR 2': product, name, price €129, 'Shop now' button. Energetic, bold colours."

## Tool calls
```json
[
  {"tool": "build_scene", "args": {
    "comp": {"width": 1080, "height": 1920, "duration": 6, "background": "#1E1B4B"},
    "layers": [
      {"key": "blob", "type": "path", "shape": "blob", "shapeOptions": {"seed": 4}, "x": 140, "y": 520, "w": 800, "h": 800, "fill": "#F43F5E",
       "enter": {"t": 0.0, "duration": 0.6, "from": {"scale": 0}, "ease": "Expo Out"}, "expr": {"rotation": "time*12"}},
      {"key": "product", "type": "rect", "x": 240, "y": 760, "w": 600, "h": 300, "radius": 150, "fill": "#F8FAFC", "rotation": -14,
       "enter": {"t": 0.2, "duration": 0.7, "from": {"dx": 900, "rotation": 20}, "ease": "Expo Out"}},
      {"key": "kicker", "text": "NEW DROP", "fontSize": 44, "fontWeight": 700, "tracking": 8, "x": 120, "y": 200, "fill": "#FDE047",
       "enter": {"t": 0.5, "from": {"opacity": 0, "dx": -40}}},
      {"key": "name", "text": "AIR 2", "fontSize": 220, "fontWeight": 900, "tracking": -8, "x": 110, "y": 260, "fill": "#F8FAFC",
       "textAnim": {"preset": "Pop letters", "start": 0.7}},
      {"key": "price", "type": "group", "children": [
        {"key": "tag", "type": "rect", "x": 640, "y": 1180, "w": 300, "h": 140, "radius": 70, "fill": "#FDE047", "rotation": 6,
         "enter": {"t": 1.6, "from": {"scale": 0, "rotation": -30}, "ease": "spring:0.45"}},
        {"key": "amount", "text": "€129", "fontSize": 84, "fontWeight": 900, "align": "center", "center": [790, 1250], "fill": "#1E1B4B", "rotation": 6,
         "enter": {"t": 1.72, "from": {"opacity": 0, "scale": 60}, "ease": "spring:0.45"}}
      ]},
      {"key": "cta", "type": "rect", "x": 140, "y": 1560, "w": 800, "h": 150, "radius": 75, "fill": "#F43F5E",
       "enter": {"t": 2.4, "from": {"opacity": 0, "dy": 120}}},
      {"key": "ctaText", "text": "Shop now", "fontSize": 64, "fontWeight": 800, "align": "center", "center": [540, 1635], "fill": "#FFFFFF",
       "enter": {"t": 2.5, "from": {"opacity": 0, "dy": 40}}}
    ]}},
  {"tool": "animate", "args": {"tracks": [
    {"id": "<product>", "prop": "position", "merge": true, "keyframes": [{"t": 1.0, "v": [540, 910], "ease": "Sine In Out"}, {"t": 2.0, "v": [540, 880], "ease": "Sine In Out"}, {"t": 3.0, "v": [540, 910], "ease": "Sine In Out"}, {"t": 4.0, "v": [540, 880], "ease": "Sine In Out"}, {"t": 5.0, "v": [540, 910], "ease": "Sine In Out"}, {"t": 6.0, "v": [540, 880]}]},
    {"id": "<cta>", "prop": "scale", "keyframes": [{"t": 3.6, "v": 100, "ease": "Cubic In Out"}, {"t": 3.8, "v": 106, "ease": "spring Quick"}, {"t": 4.3, "v": 100}, {"t": 4.8, "v": 100, "ease": "Cubic In Out"}, {"t": 5.0, "v": 106, "ease": "spring Quick"}, {"t": 5.5, "v": 100}]}
  ]}}
]
```

## Why it works
- Hook in the first 0.2 s (the colour blob bursts, the product whips in from the right with a tilt), then the order a viewer reads: name → price → CTA, each 0.5–0.9 s apart.
- Vertical layout on thirds: name top, product center, price tag overlapping the product's corner (depth), CTA at the bottom inside the safe area (above the platform UI).
- Energy = Expo Out entrances, springs on the price tag, a rotating blob and a floating product (Sine In Out bob) through the hold.
- The CTA pulses twice in the last 2.5 s: one focal change at a time, the call to action is the last thing that moves.
