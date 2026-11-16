# markdown-render-speed-02

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/mikeykun477/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/mikeykun477/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A fast, dependency-free Markdown renderer for the [make.fun](https://make.fun/bounty/markdown-render-speed-02) competition `markdown-render-speed-02`. `parse.js` renders Markdown to exactly the HTML that marked 18.1.3 produces with its default options (GFM on), and `main.ts` drives it over a case file. The parser is hand-built from the CommonMark 0.31.2 specification and the GFM 0.29 extensions: a block pass that collects link reference definitions, then an inline pass with the delimiter-stack algorithm for emphasis, strong emphasis and strikethrough, plus links, images, autolinks, tables and task lists. No dependencies, no vendored code, no caching across cases.
