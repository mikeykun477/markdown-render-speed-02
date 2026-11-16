# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/mikeykun477/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/mikeykun477/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer that produces byte-identical HTML to marked 18.1.3 across the full CommonMark + GFM spec set — and beats marked on speed. Pure Node, no network, no vendored code: the parser is a hand-built block/inline engine in a single `parse.js`.

## Run it

```sh
node main.ts
```

`main.ts` reads `$MAKEFUN_INPUT_DIR/cases.json` (default `/input`), renders every case on its own with `parse`, and writes `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output`).

<sub>Entered on [make.fun](https://make.fun/?ref=mbwma2wq&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
