# Motion

A fast motion design editor (After Effects / Figma Motion style) with an AI agent sidebar.

- WebGL2 renderer: the whole composition in one draw call, smooth with thousands of animated layers
- Timeline with keyframes, easing curves and springs
- Paste from Figma (just ⌘C → ⌘V), import Lottie, SVG, After Effects `.aep`
- Agent sidebar: Claude Code / Codex / Gemini CLI with your own subscription, driving the editor via MCP

```bash
npm install
npm run electron      # desktop app
# or
npm run dev           # browser, plus `npm run bridge` for the agent sidebar
```

See [NOTES.md](NOTES.md) for architecture, measurements and roadmap. (Visual design is basic for now — design pass planned later.)
