# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/mikeykun477/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/mikeykun477/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer. `parse.js` exports `parse(markdown)`, which returns exactly the HTML that marked 18.1.3 produces with its default options (GFM on, breaks off, pedantic off) — block structure, inline parsing, tables, task lists, autolinks and all the edge cases — while running faster than marked itself. Zero dependencies, plain Node, no network at runtime.

## Run it

```sh
node main.ts
```

It reads cases from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`) and writes `/output/html.json` (or `$MAKEFUN_OUTPUT_DIR`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=mbwma2wq&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
