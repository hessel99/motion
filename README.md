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

npm run dist          # build an installable app (on a Mac: .dmg + .zip in ./release)
```

For the agent sidebar, install and log in to the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) once (`npm i -g @anthropic-ai/claude-code`, then `claude`). Motion uses your own subscription through it. Codex CLI and Gemini CLI also work if they are installed.

Try **File → Run performance benchmark** to see real numbers on your machine.

See [NOTES.md](NOTES.md) for architecture, measurements and roadmap. (Visual design is basic for now — design pass planned later.)
