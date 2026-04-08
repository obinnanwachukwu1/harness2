# ui-opentui

OpenTUI frontend for `harness2`.

This package runs against the real Node `HeadlessEngine` through a small JSON
bridge over stdio. The goal is a stable transcript-heavy terminal UI with a
dedicated transcript viewport and experiment rail.

Run it directly:

```bash
cd /Users/obinnanwachukwu/Code/harness2/packages/ui-opentui
bun run dev -- --cwd /Users/obinnanwachukwu/Code/harness2
```

Or launch it from the main CLI:

```bash
cd /Users/obinnanwachukwu/Code/harness2
node dist/cli.js opentui
```

Controls:

```text
enter          send prompt
ctrl-c         quit
pageup/down    scroll transcript
home/end       jump to top/bottom
ctrl-t         toggle thinking
```
