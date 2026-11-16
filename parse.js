// parse.js — a fast CommonMark 0.31.2 + GFM parser whose output matches
// marked 18.1.3 (default options: gfm on, breaks off) for every input.
// Written from scratch: a line-based block parser and a delimiter-stack
// inline parser, both tuned for speed (char-code scanning, no regex in the
// hot loops, minimal allocation).
//
// Usage: parse(markdown) -> HTML string. No state is kept between calls.

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const refs = new Map();
  const lines = src.split('\n');
  // A trailing newline leaves a phantom empty element after split(); drop
  // it so the block parser sees only real lines. Remember the flag: an
  // html block at EOF keeps its trailing newline only when the input had
  // one.
  const endsWithNewline = src.endsWith('\n');
  if (endsWithNewline) lines.pop();
  const { root } = parseBlocks(lines, refs, endsWithNewline);
  return renderBlocks(root.children, refs);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK_TAG_SET = new Set(BLOCK_TAGS.split('|'));

// ASCII punctuation, for backslash escapes and flanking.
function isAsciiPunct(c) {
  return (
    (c >= 33 && c <= 47) ||
    (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) ||
    (c >= 123 && c <= 126)
  );
}

function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
}

// Unicode punctuation / symbol test for one code point (as a string of 1-2
// UTF-16 units). Only used at delimiter runs, so a regex test is fine.
const RE_PUNCT = /[\p{P}\p{S}]/u;
const RE_SPACE = /\s/;
function isPunctStr(s) {
  return s !== '' && RE_PUNCT.test(s);
}
function isSpaceStr(s) {
  return s !== '' && RE_SPACE.test(s);
}

// The character (one code point) ending at index i of str, or '' at the start.
function charBefore(str, i) {
  if (i <= 0) return '';
  const c = str.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const h = str.charCodeAt(i - 2);
    if (h >= 0xd800 && h <= 0xdbff) return str.slice(i - 2, i);
  }
  return str[i - 1];
}

// The character (one code point) starting at index i of str, or '' at the end.
function charAfter(str, i) {
  if (i >= str.length) return '';
  const c = str.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
    const l = str.charCodeAt(i + 1);
    if (l >= 0xdc00 && l <= 0xdfff) return str.slice(i, i + 2);
  }
  return str[i];
}

// ---------------------------------------------------------------------------
// Text escaping and entity handling
//
// Text is emitted by decoding numeric character references, then escaping
// & < > " ' — except that an & starting a valid-looking entity reference
// (&word; or &#digits; or &#xhex;) is left alone. That is exactly what
// marked does: named entities pass through untouched, numeric references
// decode (invalid ones become U+FFFD), and a decoded & is re-escaped.
// ---------------------------------------------------------------------------

function decodeNumeric(s, i) {
  // s[i] === '&', s[i+1] === '#'. Returns [codePointOrMinusOne, endIndex]
  // or null when this is not a numeric reference.
  let j = i + 2;
  let hex = false;
  if (s[j] === 'x' || s[j] === 'X') {
    hex = true;
    j++;
  }
  const start = j;
  let v = 0;
  let digits = 0;
  if (hex) {
    while (j < s.length) {
      const c = s.charCodeAt(j);
      let d = -1;
      if (c >= 48 && c <= 57) d = c - 48;
      else if (c >= 97 && c <= 102) d = c - 87;
      else if (c >= 65 && c <= 70) d = c - 55;
      else break;
      if (digits >= 6) return null; // more than 6 hex digits: not a reference
      v = v * 16 + d;
      digits++;
      j++;
    }
  } else {
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c < 48 || c > 57) break;
      if (digits >= 7) return null; // more than 7 decimal digits: not a reference
      v = v * 10 + (c - 48);
      digits++;
      j++;
    }
  }
  if (digits === 0 || j >= s.length || s[j] !== ';') return null;
  if (v === 0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) v = 0xfffd;
  return [v, j + 1];
}

// Does s starting at i look like a valid entity reference (&word; / &#n; /
// &#xhh;)? Used to decide whether a literal & stays unescaped.
function looksLikeEntity(s, i) {
  // s[i] === '&'
  if (i + 1 >= s.length) return false;
  if (s[i + 1] === '#') {
    return decodeNumeric(s, i) !== null;
  }
  let j = i + 1;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122)
    ) {
      j++;
      continue;
    }
    break;
  }
  return j > i + 1 && j < s.length && s[j] === ';';
}

// Escape a text run: decode numeric refs, escape & < > " ' (with the
// entity lookahead for &). Appends to `out` (an array of strings).
function escapeTextInto(out, s) {
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      // &
      const dec = s[i + 1] === '#' ? decodeNumeric(s, i) : null;
      if (dec !== null) {
        if (i > start) out.push(s.slice(start, i));
        out.push(String.fromCodePoint(dec[0]));
        i = dec[1];
        start = i;
        continue;
      }
      if (looksLikeEntity(s, i)) {
        i++;
        continue;
      }
      if (i > start) out.push(s.slice(start, i));
      out.push('&amp;');
      i++;
      start = i;
    } else if (c === 60) {
      // <
      if (i > start) out.push(s.slice(start, i));
      out.push('&lt;');
      i++;
      start = i;
    } else if (c === 62) {
      // >
      if (i > start) out.push(s.slice(start, i));
      out.push('&gt;');
      i++;
      start = i;
    } else if (c === 34) {
      // "
      if (i > start) out.push(s.slice(start, i));
      out.push('&quot;');
      i++;
      start = i;
    } else if (c === 39) {
      // '
      if (i > start) out.push(s.slice(start, i));
      out.push('&#39;');
      i++;
      start = i;
    } else {
      i++;
    }
  }
  if (n > start) out.push(s.slice(start, n));
}

// Escape with every & encoded (used for code spans, code blocks, and the
// text of link titles after their own processing).
function escapeEncodeInto(out, s) {
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      if (i > start) out.push(s.slice(start, i));
      out.push('&amp;');
      i++;
      start = i;
    } else if (c === 60) {
      if (i > start) out.push(s.slice(start, i));
      out.push('&lt;');
      i++;
      start = i;
    } else if (c === 62) {
      if (i > start) out.push(s.slice(start, i));
      out.push('&gt;');
      i++;
      start = i;
    } else if (c === 34) {
      if (i > start) out.push(s.slice(start, i));
      out.push('&quot;');
      i++;
      start = i;
    } else if (c === 39) {
      if (i > start) out.push(s.slice(start, i));
      out.push('&#39;');
      i++;
      start = i;
    } else {
      i++;
    }
  }
  if (n > start) out.push(s.slice(start, n));
}

// Unescape backslash escapes of ASCII punctuation (used in link destinations
// and titles). A backslash before anything else stays literal.
// A link destination: unescape backslashes, then encodeURI with %25 -> %.
// Returns null when encodeURI throws (lone surrogates).
function encodeHref(raw) {
  const cleaned = unescapeBackslashes(raw);
  try {
    return encodeURI(cleaned).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Normalize a link label: trim, collapse internal whitespace to one space,
// case-fold like marked (lower, upper, lower). Backslash escapes are NOT
// removed: a label `foo\!` does not match a definition `foo!`.
function normalizeLabel(label) {
  return label
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}

// Strip trailing blank lines from a block of text the way marked does
// (keeps at most one trailing newline).
// ---------------------------------------------------------------------------
// Line indentation helpers (tabs advance to the next multiple of 4 columns)
// ---------------------------------------------------------------------------

// Number of columns of leading whitespace of `line` (tabs expand to 4),
// with the line starting at absolute column `startCol`.
function indentColumns(line, startCol) {
  let col = startCol || 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col % 4);
    else break;
  }
  return col - (startCol || 0);
}

// Is the line blank (only spaces/tabs)?
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Remove `cols` columns of leading whitespace from `line`. When a tab
// straddles the boundary, the remainder becomes spaces. Returns null when
// the line has fewer than `cols` columns of leading whitespace. Tab widths
// are measured from absolute column `startCol`.
function stripColumns(line, cols, startCol) {
  const base = startCol || 0;
  let col = base;
  let i = 0;
  while (i < line.length && col - base < cols) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w - base > cols) {
        // Tab straddles the boundary: keep the remainder as spaces.
        return ' '.repeat(col + w - base - cols) + line.slice(i + 1);
      }
      col += w;
      i++;
    } else {
      return null;
    }
  }
  if (col - base < cols) return null;
  return line.slice(i);
}

// Remove up to `cols` columns of leading whitespace from `line`. Unlike
// stripColumns, a line with less leading whitespace than `cols` has all
// of it removed instead of returning null (fenced-code content lines are
// stripped by at most the fence's indent). Tab widths are measured from
// absolute column `startCol`. A tab that starts before the strip boundary
// is removed entirely (its remainder is discarded, not kept as spaces).
// A leading tab that remains is expanded to spaces at its absolute column
// only when the line sits inside a container (startCol > 0); at the top
// level a literal tab stays literal.
function stripColumnsUpTo(line, cols, startCol) {
  const base = startCol || 0;
  let col = base;
  let i = 0;
  while (i < line.length && col - base < cols) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w - base > cols) {
        // Tab starts before the boundary: remove it entirely.
        i++;
        col += w;
        break;
      }
      col += w;
      i++;
    } else {
      break;
    }
  }
  // Expand any leading tabs that remain, but only inside a container.
  if (base > 0) {
    let out = '';
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if (c === 32) {
        out += ' ';
        col++;
        i++;
      } else if (c === 9) {
        const w = 4 - (col % 4);
        out += ' '.repeat(w);
        col += w;
        i++;
      } else {
        break;
      }
    }
    return out + line.slice(i);
  }
  return line.slice(i);
}

// The leading whitespace (spaces/tabs) of a line, as a string.
function leadingWhitespace(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  return line.slice(0, i);
}

// ---------------------------------------------------------------------------
// Block parser
// ---------------------------------------------------------------------------

// Match a blockquote marker at the start of `line` (0-3 spaces, then `>`,
// then one column of following whitespace). Returns { rest, cols } (cols
// = columns consumed from the line start) or null. A following tab gives
// up one column of its expansion; the remainder becomes spaces in `rest`.
function matchBlockquoteMarker(line) {
  let i = 0;
  let col = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      col += 4 - (col % 4);
      i++;
    } else {
      break;
    }
  }
  if (col > 3 || i >= line.length || line.charCodeAt(i) !== 62) return null;
  i++;
  col++;
  // At most one column of following whitespace is consumed: a space is
  // consumed whole; a tab gives up one column of its expansion and the
  // rest stays as spaces. Never both a space and a tab.
  if (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      i++;
      col++;
    } else if (c === 9) {
      const w = 4 - (col % 4);
      col++;
      return { rest: ' '.repeat(w - 1) + line.slice(i + 1), cols: col };
    }
  }
  return { rest: line.slice(i), cols: col };
}

// Is `rest` a setext underline (0-3 spaces, then =+ or -+, then spaces)?
// Returns 1 for `=`, 2 for `-`, 0 otherwise.
function setextLevel(rest) {
  let i = 0;
  while (i < rest.length && rest.charCodeAt(i) === 32 && i < 3) i++;
  if (i >= rest.length) return 0;
  const c = rest.charCodeAt(i);
  if (c !== 61 && c !== 45) return 0;
  const level = c === 61 ? 1 : 2;
  i++;
  // The underline is one run of the same character; a space in the middle
  // (or another character after a space) disqualifies it (`= =` and
  // `--- -` are not setext underlines, though `--- -` is an hr).
  while (i < rest.length && rest.charCodeAt(i) === c) i++;
  while (i < rest.length) {
    const d = rest.charCodeAt(i);
    if (d !== 32 && d !== 9) return 0;
    i++;
  }
  return level;
}

// Pad a lazy setext-underline line's leading whitespace to 4 columns
// (tabs advance to the next multiple of 4; a line already at 4 or more
// columns is returned unchanged).
function padLazySetext(rest) {
  let col = 0;
  let i = 0;
  while (i < rest.length) {
    const c = rest.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      col += 4 - (col % 4);
      i++;
    } else {
      break;
    }
  }
  if (col >= 4) return rest;
  return '    '.slice(0, 4 - col) + rest;
}

// Is `rest` a thematic break (0-3 spaces, then 3+ of -, _, or *,
// separated by spaces/tabs only)?
function isHr(rest) {
  let i = 0;
  while (i < rest.length && rest.charCodeAt(i) === 32 && i < 3) i++;
  if (i >= rest.length) return false;
  const c = rest.charCodeAt(i);
  if (c !== 45 && c !== 95 && c !== 42) return false;
  let count = 0;
  while (i < rest.length) {
    const d = rest.charCodeAt(i);
    if (d === c) count++;
    else if (d !== 32 && d !== 9) return false;
    i++;
  }
  return count >= 3;
}

// Is `rest` a table delimiter row (0-3 spaces, then cells of dashes with
// optional colons, separated by pipes; must contain a | or a :)?
function isTableDelimiter(rest) {
  let i = 0;
  while (i < rest.length && rest.charCodeAt(i) === 32 && i < 3) i++;
  let hasPipeOrColon = false;
  let cells = 0;
  // A leading pipe is allowed (and counts as the required | or :).
  if (i < rest.length && rest.charCodeAt(i) === 124) {
    hasPipeOrColon = true;
    i++;
  }
  while (true) {
    while (i < rest.length && rest.charCodeAt(i) === 32) i++;
    if (i < rest.length && rest.charCodeAt(i) === 58) {
      hasPipeOrColon = true;
      i++;
      while (i < rest.length && rest.charCodeAt(i) === 32) i++;
    }
    let dashes = 0;
    while (i < rest.length && rest.charCodeAt(i) === 45) {
      dashes++;
      i++;
    }
    if (dashes === 0) return 0;
    while (i < rest.length && rest.charCodeAt(i) === 32) i++;
    if (i < rest.length && rest.charCodeAt(i) === 58) {
      hasPipeOrColon = true;
      i++;
      while (i < rest.length && rest.charCodeAt(i) === 32) i++;
    }
    cells++;
    if (i >= rest.length) break;
    if (rest.charCodeAt(i) !== 124) return 0;
    hasPipeOrColon = true;
    i++;
    if (i >= rest.length) break;
    if (rest.slice(i).trim() === '') break;
  }
  // Returns the cell count (0 when this is not a delimiter row).
  return cells >= 1 && hasPipeOrColon ? cells : 0;
}

// ATX heading: 0-3 spaces, 1-6 #, then a space/tab/EOL. Returns the level
// and the raw text after the hashes, or null.
function matchAtx(rest) {
  let i = 0;
  while (i < rest.length && rest.charCodeAt(i) === 32 && i < 3) i++;
  let level = 0;
  while (i < rest.length && rest.charCodeAt(i) === 35 && level < 7) {
    level++;
    i++;
  }
  if (level === 0 || level > 6) return null;
  if (i < rest.length) {
    const c = rest.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
  }
  return { level, text: rest.slice(i) };
}

// Fenced code opening: 0-3 spaces, then 3+ backticks or tildes. The info
// string of a backtick fence must not contain a backtick. Returns the fence
// info, or null.
function matchFence(rest) {
  let i = 0;
  while (i < rest.length && rest.charCodeAt(i) === 32 && i < 3) i++;
  if (i >= rest.length) return null;
  const c = rest.charCodeAt(i);
  if (c !== 96 && c !== 126) return null;
  let len = 0;
  while (i < rest.length && rest.charCodeAt(i) === c) {
    len++;
    i++;
  }
  if (len < 3) return null;
  const info = rest.slice(i);
  if (c === 96 && info.indexOf('`') !== -1) return null;
  return { char: c, len, indent: i - len, info };
}

// A list marker at the start of `rest` (0-3 spaces, then a bullet or an
// ordered marker). Returns marker info, or null.
function matchListMarker(rest) {
  let i = 0;
  while (i < rest.length && rest.charCodeAt(i) === 32 && i < 3) i++;
  const indent = i;
  if (i >= rest.length) return null;
  const c = rest.charCodeAt(i);
  let ordered = false;
  let bullet = '';
  let num = 0;
  let markerLen = 0;
  if (c === 42 || c === 43 || c === 45) {
    bullet = rest[i];
    markerLen = 1;
    i++;
  } else if (c >= 48 && c <= 57) {
    ordered = true;
    let j = i;
    let v = 0;
    let digits = 0;
    while (j < rest.length && rest.charCodeAt(j) >= 48 && rest.charCodeAt(j) <= 57 && digits < 9) {
      v = v * 10 + (rest.charCodeAt(j) - 48);
      digits++;
      j++;
    }
    if (digits === 0 || digits > 9) return null;
    if (j >= rest.length || (rest.charCodeAt(j) !== 46 && rest.charCodeAt(j) !== 41)) return null;
    num = v;
    bullet = rest[j];
    markerLen = j - i + 1;
    i = j + 1;
  } else {
    return null;
  }
  if (i >= rest.length) {
    return { ordered, bullet, num, markerLen, indent, contentIndent: indent + markerLen + 1, content: '', empty: true };
  }
  const d = rest.charCodeAt(i);
  if (d !== 32 && d !== 9) return null;
  // Columns of the whitespace gap after the marker. A tab expands to
  // the next multiple of 4 columns; the gap is ALL the whitespace after
  // the marker (not just up to the first tab), because a gap of more
  // than 4 columns changes the content indent (see below).
  let col = indent + markerLen;
  let j = i;
  while (j < rest.length) {
    const e = rest.charCodeAt(j);
    if (e === 32) {
      col++;
      j++;
    } else if (e === 9) {
      col += 4 - (col % 4);
      j++;
    } else {
      break;
    }
  }
  if (j >= rest.length) {
    return { ordered, bullet, num, markerLen, indent, contentIndent: indent + markerLen + 1, content: '', empty: true };
  }
  const gap = col - (indent + markerLen);
  const contentIndent = gap > 4 ? indent + markerLen + 1 : col;
  let content = rest.slice(j);
  if (col > contentIndent) content = ' '.repeat(col - contentIndent) + content;
  return { ordered, bullet, num, markerLen, indent, contentIndent, content, empty: false };
}

// Can this list marker interrupt a paragraph (non-lazy case)? The first
// item must be non-empty, and an ordered list must start with the literal 1.
function listInterruptsParagraph(m) {
  if (m.empty) return false;
  if (m.ordered && m.num !== 1) return false;
  return true;
}

// Does `rest` start an HTML block? Returns the type (1-7) or 0.
function htmlBlockType(rest) {
  let i = 0;
  while (i < rest.length && rest.charCodeAt(i) === 32 && i < 3) i++;
  if (i >= rest.length || rest.charCodeAt(i) !== 60) return 0;
  const s = rest.slice(i);
  const low = s.toLowerCase();
  if (
    low.startsWith('<script') ||
    low.startsWith('<pre') ||
    low.startsWith('<style') ||
    low.startsWith('<textarea')
  ) {
    const name = low.startsWith('<script')
      ? 'script'
      : low.startsWith('<pre')
        ? 'pre'
        : low.startsWith('<style')
          ? 'style'
          : 'textarea';
    const c = s[1 + name.length];
    if (c === undefined || c === ' ' || c === '\t' || c === '>') return 1;
    return 0;
  }
  if (s.startsWith('<!--')) return 2;
  if (s.startsWith('<?')) return 3;
  if (s.startsWith('<!') && s.length > 2 && s.charCodeAt(2) >= 65 && s.charCodeAt(2) <= 90) return 4;
  if (s.startsWith('<![CDATA[')) return 5;
  // Type 6: a block tag name followed by space, tab, end of line, > or /.
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(s);
  if (m6) {
    const name = m6[1].toLowerCase();
    const after = s[m6[0].length];
    if (BLOCK_TAG_SET.has(name) && (after === undefined || after === ' ' || after === '\t' || after === '>' || after === '/')) {
      return 6;
    }
  }
  // Type 7: a complete open or close tag alone on the line (any tag name).
  const m7 = /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*"[^"\n]*"|\s*=\s*'[^'\n]*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/.exec(s);
  if (m7) return 7;
  return 0;
}

// Split a table row into cells (unescaped pipes), trimmed.
// Is `line` a whitespace-only line of 0-3 spaces followed by exactly
// one tab? Marked treats such a line as an empty table body row; any
// other blank line ends a table.
function isTableTabRow(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i <= 3 && i + 1 === line.length && line.charCodeAt(i) === 9;
}

function splitTableRow(row) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < row.length; i++) {
    const c = row.charCodeAt(i);
    if (c === 92 && i + 1 < row.length && row.charCodeAt(i + 1) === 124) {
      cur += '|';
      i++;
    } else if (c === 124) {
      cells.push(cur);
      cur = '';
    } else {
      cur += row[i];
    }
  }
  cells.push(cur);
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

// Alignment of a delimiter row's cells.
function tableAlignments(delimiterRow) {
  return splitTableRow(delimiterRow).map((cell) => {
    const t = cell.trim();
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    if (left && right) return 'center';
    if (left) return 'left';
    if (right) return 'right';
    return null;
  });
}

// ---------------------------------------------------------------------------
// The block parser: a line-based container-stack parser.
// ---------------------------------------------------------------------------

function parseBlocks(lines, refs, endsWithNewline) {
  const root = { type: 'document', children: [] };
  const containers = [root];
  let para = null;
  // Was the paragraph's most recent line appended as a lazy continuation?
  // A lazy setext-1 underline after a lazy line is padded to 4 columns.
  let paraLastLazy = false;
  // A blank line was seen and the next block has not arrived yet. When it
  // does, it loosens the list or item it lands in (if that container
  // already has a child); a blank inside a blockquote never sets it.
  let blankPending = false;
  let i = 0;
  const n = lines.length;

  function innermost() {
    return containers[containers.length - 1];
  }
  function innermostItem() {
    for (let c = containers.length - 1; c >= 1; c--) {
      if (containers[c].type === 'item') return containers[c];
    }
    return null;
  }
  function innermostList() {
    for (let c = containers.length - 1; c >= 1; c--) {
      if (containers[c].type === 'list') return containers[c];
    }
    return null;
  }
  function closeContainers(depth) {
    if (depth < containers.length - 1) para = null;
    containers.length = depth + 1;
  }
  // Add a block node to the innermost container, applying the loose-list rule.
  function addBlock(node) {
    const parent = innermost();
    if (blankPending) {
      // The blank separates this block from the previous child of the
      // same item (when the parent is an item with content already).
      if (parent.type === 'item' && parent.children.length > 0 && parent.list) {
        parent.list.loose = true;
      }
      blankPending = false;
    }
    parent.children.push(node);
  }
  // Match the open containers against `line`. Returns { rest, matched,
  // startCol }: `matched` is how many containers (excluding the root)
  // matched, `rest` is the line after their prefixes, and `startCol` is
  // the absolute column where `rest` starts (tab widths in `rest` are
  // measured from it). A blank line matches an item or a list, but a
  // blockquote only when it carries the `>` marker.
  function matchContainers(line) {
    let rest = line;
    let matched = 0;
    let col = 0;
    // Tab expansion in fenced code counts only the outermost
    // blockquote's marker (plus any leading spaces) and the list-item
    // indents inside it; inner blockquote markers and list-item
    // indents above (outside) the outermost blockquote do not shift
    // the column. With no blockquote the absolute column is used.
    let listIndentTotal = 0;
    let firstBqCols = 0;
    let totalBqCols = 0;
    let listIndentBeforeFirstBq = 0;
    let hasBq = false;
    for (let c = 1; c < containers.length; c++) {
      const cont = containers[c];
      if (cont.type === 'blockquote') {
        const r = matchBlockquoteMarker(rest);
        if (r === null) break;
        col += r.cols;
        rest = r.rest;
        matched = c;
        totalBqCols += r.cols;
        if (!hasBq) {
          hasBq = true;
          firstBqCols = r.cols;
          listIndentBeforeFirstBq = listIndentTotal;
        }
      } else if (cont.type === 'item') {
        if (isBlankLine(rest)) {
          matched = c;
        } else {
          const ind = indentColumns(rest, col);
          if (ind >= cont.contentIndent) {
            const s = stripColumns(rest, cont.contentIndent, col);
            if (s === null) break;
            col += cont.contentIndent;
            listIndentTotal += cont.contentIndent;
            rest = s;
            matched = c;
          } else {
            break;
          }
        }
      } else {
        matched = c;
      }
    }
    return {
      rest,
      matched,
      startCol: col,
      tabCol: hasBq
        ? col - (totalBqCols - firstBqCols) - listIndentBeforeFirstBq
        : col,
    };
  }
  // The content of line j in the current container context (stripped of
  // container prefixes when it matches them; the raw line when it does not).
  function lineContent(j) {
    if (j >= n) return null;
    const { rest } = matchContainers(lines[j]);
    return rest;
  }
  // Does `header` (the content of line j) start a table, with line j+1 as
  // its delimiter row?
  function isTableStartAt(header, j) {
    if (j + 1 >= n) return false;
    if (header === null || header.trim() === '') return false;
    const delim = lineContent(j + 1);
    if (delim === null) return false;
    const cells = isTableDelimiter(delim);
    if (cells === 0) return false;
    // The delimiter row must have exactly as many cells as the header.
    return cells === splitTableRow(header).length;
  }

  // Parse a fenced code block starting at line i (rest holds the fence
  // line's content). Consumes lines until the closing fence or EOF.
  function parseFencedCode(rest) {
    const fence = matchFence(rest);
    const content = [];
    i++;
    while (i < n) {
      const m = matchContainers(lines[i]);
      let line;
      if (m.matched < containers.length - 1) {
        // The line does not belong to every open container. When the
        // first container it fails is a blockquote, the block (and the
        // code block inside it) ends there. When it is a list item, the
        // line is lazy code content — but only once the code block is
        // anchored by at least one matching content line (a first line
        // that does not match leaves the code block empty), only when
        // the line does not start an interrupting block (a list marker
        // ends the code block and starts a list), and only when it is
        // not indented past the matched containers (an indented line
        // there is a paragraph, not code content).
        const failed = containers[m.matched + 1];
        const firstCh =
          m.rest.length > 0 ? m.rest.charCodeAt(0) : 32;
        if (
          failed.type === 'blockquote' ||
          content.length === 0 ||
          startsInterruptingBlock(m.rest, true) ||
          firstCh === 32 ||
          firstCh === 9
        ) {
          break;
        }
        line = m.rest;
      } else {
        line = m.rest;
        // Closing fence: 0-3 spaces, then >= fence.len of the same char,
        // then only spaces.
        let k = 0;
        while (k < line.length && line.charCodeAt(k) === 32 && k < 3) k++;
        let run = 0;
        while (k < line.length && line.charCodeAt(k) === fence.char) {
          run++;
          k++;
        }
        if (run >= fence.len) {
          let ok = true;
          while (k < line.length) {
            const c = line.charCodeAt(k);
            if (c !== 32 && c !== 9) {
              ok = false;
              break;
            }
            k++;
          }
          if (ok) {
            i++;
            break;
          }
        }
      }
      // Content line: a backtick fence strips up to the fence's indent
      // (a line with less leading whitespace than the indent loses all
      // of it). A tilde fence strips no spaces: its content lines keep
      // their leading spaces exactly. Either way, tab widths are
      // measured from the absolute column where the line's content
      // starts, and a leading tab is expanded even when nothing is
      // stripped.
      const cl = stripColumnsUpTo(
        line,
        fence.char === 126 ? 0 : fence.indent,
        m.tabCol,
      );
      content.push(cl);
      i++;
    }
    let lang = '';
    const info = fence.info.trim();
    if (info !== '') {
      const word = info.split(/\s+/)[0];
      lang = word.replace(/\\([!"#$%&'()*+,./:;<=>?@\[\\\]^_`{|}~-])/g, '$1');
    }
    addBlock({ type: 'code', lang, text: content.join('\n'), fenced: true });
  }

  // Parse an indented code block whose first line's content is `first`
  // (already stripped of container prefixes, known to have >= 4 columns of
  // indent).
  function parseIndentedCode(first, startCol) {
    const content = [stripColumns(first, 4, startCol)];
    i++;
    while (i < n) {
      const m = matchContainers(lines[i]);
      if (m.matched < containers.length - 1) break;
      const line = m.rest;
      if (isBlankLine(line)) {
        // A blank line is part of the code block only when a code line
        // follows it.
        let j = i + 1;
        let found = false;
        while (j < n) {
          const mj = matchContainers(lines[j]);
          if (mj.matched < containers.length - 1) break;
          if (isBlankLine(mj.rest)) {
            j++;
            continue;
          }
          if (indentColumns(mj.rest, mj.startCol) >= 4) found = true;
          break;
        }
        if (!found) break;
        // The blank line keeps the whitespace left after stripping the
        // 4-column code indent (e.g. a 6-space blank line is 2 spaces).
        const bs = stripColumns(line, 4, m.startCol);
        content.push(bs === null ? '' : bs);
        i++;
        continue;
      }
      if (indentColumns(line, m.startCol) < 4) break;
      content.push(stripColumns(line, 4, m.startCol));
      i++;
    }
    // Strip trailing blank lines (keep at most one trailing newline's worth).
    while (content.length > 0 && content[content.length - 1] === '') content.pop();
    addBlock({ type: 'code', lang: '', text: content.join('\n'), fenced: false });
  }

  // Parse an HTML block starting at line i (rest is the first line, type
  // is 1-7). Consumes lines per the type's end condition.
  // After an html block, when the next line is an empty blank line inside a
  // list item: the blank line belongs to the item's inner source (so the
  // html text keeps its trailing newline) iff exactly one blank line
  // separates the block from the next item at the same level.
  function singleBlankBeforeNextItem() {
    const item = innermostItem();
    if (item === null) return false;
    let j = i;
    let blanks = 0;
    while (j < n) {
      const m = matchContainers(lines[j]);
      if (m.matched < containers.length - 1) break;
      if (m.rest !== '') break;
      blanks++;
      j++;
      if (blanks > 1) return false;
    }
    if (blanks !== 1 || j >= n) return false;
    const m2 = matchContainers(lines[j]);
    if (m2.matched >= containers.length - 1) return false;
    const lm2 = matchListMarker(m2.rest);
    if (lm2 === null) return false;
    return lm2.indent === item.markerIndent;
  }

  function parseHtmlBlock(rest, type) {
    const parts = [rest];
    i++;
    if (type === 1) {
      const tag = rest.trim().toLowerCase().startsWith('<script')
        ? 'script'
        : rest.trim().toLowerCase().startsWith('<pre')
          ? 'pre'
          : rest.trim().toLowerCase().startsWith('<style')
            ? 'style'
            : 'textarea';
      const endRe = new RegExp('</' + tag + '>', 'i');
      if (!endRe.test(rest)) {
        while (i < n) {
          const m = matchContainers(lines[i]);
          if (m.matched < containers.length - 1) break;
          parts.push(m.rest);
          if (endRe.test(m.rest)) {
            i++;
            break;
          }
          i++;
        }
      }
    } else if (type === 2) {
      if (rest.indexOf('-->') === -1) {
        while (i < n) {
          const m = matchContainers(lines[i]);
          if (m.matched < containers.length - 1) break;
          parts.push(m.rest);
          if (m.rest.indexOf('-->') !== -1) {
            i++;
            break;
          }
          i++;
        }
      }
    } else if (type === 3) {
      if (rest.indexOf('?>') === -1) {
        while (i < n) {
          const m = matchContainers(lines[i]);
          if (m.matched < containers.length - 1) break;
          parts.push(m.rest);
          if (m.rest.indexOf('?>') !== -1) {
            i++;
            break;
          }
          i++;
        }
      }
    } else if (type === 4) {
      if (rest.indexOf('>') === -1) {
        while (i < n) {
          const m = matchContainers(lines[i]);
          if (m.matched < containers.length - 1) break;
          parts.push(m.rest);
          if (m.rest.indexOf('>') !== -1) {
            i++;
            break;
          }
          i++;
        }
      }
    } else if (type === 5) {
      if (rest.indexOf(']]>') === -1) {
        while (i < n) {
          const m = matchContainers(lines[i]);
          if (m.matched < containers.length - 1) break;
          parts.push(m.rest);
          if (m.rest.indexOf(']]>') !== -1) {
            i++;
            break;
          }
          i++;
        }
      }
    } else {
      // Types 6 and 7 end at the first blank line.
      while (i < n) {
        const m = matchContainers(lines[i]);
        if (m.matched < containers.length - 1) break;
        if (isBlankLine(m.rest)) break;
        parts.push(m.rest);
        i++;
      }
    }
    // The html block's text is its lines joined with '\n', plus a trailing
    // newline in exactly these cases (pinned against marked 18.1.3):
    // - types 1-5 (ended by a marker): the next line inside the container
    //   is not empty (a whitespace-only line counts as non-empty);
    // - any type: the block runs to the end of its container's inner
    //   source and that source ends with a newline (only observable at
    //   EOF, where the flag tells us the input ended with one).
    // Types 6-7 end at a blank line, so a following line never adds one.
    // A block that runs to EOF with trailing blank lines loses them all.
    let end = parts.length;
    while (end > 0 && isBlankLine(parts[end - 1])) end--;
    const hadTrailingBlank = end < parts.length;
    let text = parts.slice(0, end).join('\n');
    let addNewline = false;
    if (i < n) {
      const m = matchContainers(lines[i]);
      if (m.matched >= containers.length - 1) {
        if (m.rest !== '') {
          // The next line inside the container has content. Types 1-5
          // keep the newline that ends the block's last line (a
          // whitespace-only line counts as content here); types 6-7
          // would have swallowed a content line, so this cannot happen
          // for them.
          if (type <= 5) addNewline = true;
        } else {
          // The next line is an empty blank line inside the container.
          // It belongs to the item's inner source (so the text keeps its
          // trailing newline) iff exactly one blank line separates the
          // block from the next item at the same level.
          addNewline = singleBlankBeforeNextItem();
        }
      }
    } else if (endsWithNewline && !hadTrailingBlank) {
      addNewline = true;
    }
    if (addNewline) text += '\n';
    addBlock({ type: 'html', text });
  }

  // Parse a table starting at line i, whose header line's content is
  // `headerLine`, with line i+1 as the delimiter row. Consumes body rows
  // while they look like table rows.
  function parseTable(headerLine) {
    const delimLine = lineContent(i + 1);
    const header = splitTableRow(headerLine);
    const aligns = tableAlignments(delimLine);
    const rows = [];
    i += 2;
    while (i < n) {
      const m = matchContainers(lines[i]);
      let rowText;
      if (m.matched < containers.length - 1) {
        // A lazy body row: the raw line after the matched prefixes.
        rowText = m.rest;
        if (isBlankLine(rowText)) {
          // A whitespace-only line of 0-3 spaces + exactly one tab is an
          // empty body row (marked quirk); any other blank line ends the
          // table.
          if (isTableTabRow(rowText)) {
            rows.push(splitTableRow(rowText));
            i++;
            continue;
          }
          break;
        }
        if (isHr(rowText) || matchAtx(rowText) || matchFence(rowText) || matchBlockquoteMarker(rowText) !== null) break;
        if (matchListMarker(rowText) || htmlBlockType(rowText) !== 0) break;
        if (indentColumns(rowText) >= 4) break;
      } else {
        rowText = m.rest;
        if (isBlankLine(rowText)) {
          if (isTableTabRow(rowText)) {
            rows.push(splitTableRow(rowText));
            i++;
            continue;
          }
          break;
        }
        if (isHr(rowText) || matchAtx(rowText) || matchFence(rowText) || matchBlockquoteMarker(rowText) !== null) break;
        if (matchListMarker(rowText) || htmlBlockType(rowText) !== 0) break;
        if (indentColumns(rowText) >= 4) break;
      }
      rows.push(splitTableRow(rowText));
      i++;
    }
    // Normalize each row to the header's cell count.
    const width = header.length;
    for (const row of rows) {
      while (row.length < width) row.push('');
      if (row.length > width) row.length = width;
    }
    addBlock({ type: 'table', header, aligns, rows });
  }

  // Try to parse a link reference definition starting at line i (rest is
  // the first line's content). A title may span several following lines,
  // so pass every following non-blank line (up to a cap). Returns the
  // number of lines consumed, or 0.
  function parseDef(rest) {
    const textLines = [rest];
    for (let k = 1; k <= 12 && i + k < n; k++) {
      const c = lineContent(i + k);
      if (c === null) break;
      if (c.trim() === '') break;
      textLines.push(c);
    }
    const text = textLines.join('\n');
    const d = parseDefText(text);
    if (!d) return 0;
    if (!refs.has(d.label)) refs.set(d.label, { href: d.href, title: d.title });
    i += d.lines;
    return d.lines;
  }

  // Handle a blank line: close the paragraph, arm the loose-list flag,
  // and close an empty item. Advances i.
  function handleBlankLine() {
    // A blank line arms blankPending unless it sits inside a blockquote
    // (the innermost open container is a blockquote): a blank inside a
    // blockquote does not loosen the ancestors above it.
    if (innermost().type !== 'blockquote') blankPending = true;
    if (para !== null) para = null;
    const item = innermostItem();
    if (item !== null && item.children.length === 0) {
      // An empty item ends at a blank line.
      const idx = containers.indexOf(item);
      closeContainers(idx - 1);
    }
    i++;
  }

  // Start a new block from already-stripped content (the current line, or
  // a blockquote/list remainder). Advances i past the block.
  function startBlock(content, startCol) {
    // A list holds only list items. If the innermost container is a list
    // and this block is not a list item of the same type, close the list
    // first (e.g. `-\n\nfoo` must not put a paragraph inside the list).
    if (innermost().type === 'list') {
      const lm0 = matchListMarker(content);
      const same =
        lm0 !== null &&
        !isHr(content) &&
        lm0.ordered === innermost().ordered &&
        lm0.bullet === innermost().bullet;
      if (!same) closeContainers(containers.length - 2);
    }
    if (isBlankLine(content)) {
      handleBlankLine();
      return;
    }
    if (indentColumns(content, startCol) >= 4) {
      parseIndentedCode(content, startCol);
      return;
    }
    const atx = matchAtx(content);
    if (atx !== null) {
      let text = atx.text.trim();
      const m = /^(.*?)[ \t]+#+$/.exec(text);
      if (m) text = m[1];
      else if (/^#+$/.test(text)) text = '';
      addBlock({ type: 'heading', level: atx.level, text });
      i++;
      return;
    }
    if (matchFence(content) !== null) {
      parseFencedCode(content);
      return;
    }
    if (isHr(content)) {
      addBlock({ type: 'hr' });
      i++;
      return;
    }
    const bq = matchBlockquoteMarker(content);
    if (bq !== null) {
      const node = { type: 'blockquote', children: [] };
      addBlock(node);
      containers.push(node);
      startBlock(bq.rest, (startCol || 0) + bq.cols);
      return;
    }
    const lm = matchListMarker(content);
    if (lm !== null) {
      startList(lm, startCol);
      return;
    }
    const htmlType = htmlBlockType(content);
    if (htmlType !== 0) {
      parseHtmlBlock(content, htmlType);
      return;
    }
    if (content.trimStart().charCodeAt(0) === 91) {
      // Possibly a link reference definition.
      if (parseDef(content) > 0) return;
    }
    if (isTableStartAt(content, i)) {
      parseTable(content);
      return;
    }
    // Otherwise, a paragraph.
    const p = { type: 'paragraph', text: content };
    addBlock(p);
    para = p;
    paraLastLazy = false;
    i++;
  }

  // Close the containers the line did not match, plus any list that is
  // now innermost but cannot contain the block the line starts (a list
  // holds only list items, so an hr, heading, fence, blockquote or html
  // block — or a list item of another type — must close it first, or it
  // would be nested inside the list instead of following it).
  function closeForNewBlock(matched, rest) {
    closeContainers(matched);
    const lm = matchListMarker(rest);
    // An hr beats a list marker: `* * *` looks like a bullet item, but
    // it is an hr and must close the list, not extend it.
    const isListItem = lm !== null && !isHr(rest);
    while (containers.length > 1 && innermost().type === 'list') {
      const list = innermost();
      if (isListItem && list.ordered === lm.ordered && list.bullet === lm.bullet) break;
      closeContainers(containers.length - 2);
    }
  }

  // The main loop.
  while (i < n) {
    const line = lines[i];
    const { rest, matched, startCol, tabCol } = matchContainers(line);
    if (matched < containers.length - 1) {
      // Some containers did not match. Whether the line is blank is
      // judged on `rest` (the line after the matched prefixes): a line
      // like `>` is blank in its container even though the raw line is
      // not, and it must close the paragraph, not join it lazily.
      if (para !== null && !isBlankLine(rest)) {
        // Lazy continuation? A table header belongs to the current
        // container; an interrupting block closes the containers; anything
        // else joins the paragraph.
        if (isTableStartAt(rest, i)) {
          para = null;
          parseTable(rest);
          continue;
        }
        if (startsInterruptingBlock(rest, true)) {
          // The paragraph is closed along with its containers.
          closeForNewBlock(matched, rest);
          para = null;
        } else {
          // A lazy continuation inside a container loses 4 columns of
          // leading whitespace when it has at least 4 (tabs measured by
          // absolute column; a straddling tab leaves remainder spaces).
          let lineText = rest;
          if (indentColumns(rest, startCol) >= 4) {
            lineText = stripColumns(rest, 4, startCol);
          }
          // A leading tab in the lazy continuation expands to spaces
          // by absolute column (a tab after the container marker, e.g.
          // `> \tbar`, becomes spaces; at the top level the tab is
          // kept literal, but a lazy line is always inside a container).
          lineText = expandLeadingTabs(lineText, tabCol);
          // A lazy setext-1 underline after a lazy line, inside a
          // blockquote, is appended with its leading whitespace padded
          // to 4 columns (it cannot become a heading, but it is not
          // appended bare either).
          if (
            paraLastLazy &&
            innermost().type === 'blockquote' &&
            setextLevel(lineText) === 1
          ) {
            lineText = padLazySetext(lineText);
          }
          para.text += '\n' + lineText;
          paraLastLazy = true;
          i++;
          continue;
        }
      } else if (!isBlankLine(rest)) {
        closeForNewBlock(matched, rest);
      } else {
        closeContainers(matched);
      }
    }
    // Recompute the line's content after any closing above.
    const cur = matchContainers(lines[i]);
    const content = cur.rest;

    if (isBlankLine(content)) {
      // A whitespace-only line (non-empty rest) that is the last line of
      // its innermost container's inner source is a paragraph
      // continuation, not a blank line: the container's inner source
      // never ends with a newline, so the trailing whitespace belongs to
      // the open paragraph. This holds inside a blockquote (and at the
      // top level when the input has no trailing newline), but never
      // inside a list item, whose content is trimmed.
      if (
        content.length > 0 &&
        para !== null &&
        !containers.some((c) => c.type === 'item') &&
        (innermost().type === 'blockquote'
          ? i === n - 1 || matchContainers(lines[i + 1]).matched < containers.length - 1
          : containers.length === 1 && i === n - 1 && !endsWithNewline)
      ) {
        para.text += '\n' + content;
        paraLastLazy = false;
        i++;
        continue;
      }
      handleBlankLine();
      continue;
    }

    if (para !== null) {
      // A paragraph is open: check for setext, a table, or an interrupting
      // block before adding the line to it.
      const level = setextLevel(content);
      if (level !== 0) {
        const text = para.text.trim();
        const parent = innermost();
        parent.children[parent.children.length - 1] = { type: 'heading', level, text };
        para = null;
        i++;
        continue;
      }
      if (isTableStartAt(content, i)) {
        para = null;
        parseTable(content);
        continue;
      }
      if (startsInterruptingBlock(content, false)) {
        para = null;
        // Fall through to start the new block below.
      } else {
        // A matched continuation line inside a list item loses 4 columns
        // of leading whitespace when it has at least 4 (tabs measured by
        // absolute column). Inside a blockquote, or at the top level, the
        // leading whitespace is kept as-is.
        let lineText = content;
        if (innermost().type === 'item' && indentColumns(content, cur.startCol) >= 4) {
          lineText = stripColumns(content, 4, cur.startCol);
        }
        // Inside a container, a leading tab in the continuation line
        // expands to spaces by absolute column (a tab after the
        // blockquote marker, e.g. `> \tbar`, becomes spaces; at the
        // top level the tab is kept literal).
        if (containers.length > 1) {
          lineText = expandLeadingTabs(lineText, cur.tabCol);
        }
        para.text += '\n' + lineText;
        paraLastLazy = false;
        i++;
        continue;
      }
    }

    startBlock(content, cur.startCol);
  }
  return { root, refs };

  // --- helpers that need the loop's state (hoisted function declarations) ---

  // Does `rest` start a block that interrupts a paragraph? With `lazy`
  // true (a line that did not match its containers), any list marker
  // interrupts; otherwise the list must be non-empty and, when ordered,
  // start with 1.
  function startsInterruptingBlock(rest, lazy) {
    if (matchAtx(rest) !== null) return true;
    if (matchFence(rest) !== null) return true;
    if (isHr(rest)) return true;
    if (matchBlockquoteMarker(rest) !== null) return true;
    const lm = matchListMarker(rest);
    if (lm !== null) {
      if (lazy) return true;
      // Inside a list item, any non-empty list marker starts a nested
      // list (an ordered list need not start with 1 there); elsewhere an
      // ordered list must start with 1 to interrupt a paragraph.
      if (innermost().type === 'item') return !lm.empty;
      return listInterruptsParagraph(lm);
    }
    const ht = htmlBlockType(rest);
    if (ht >= 1 && ht <= 6) return true;
    return false;
  }

  function startList(lm, startCol) {
    const parent = innermost();
    let list = null;
    if (parent.type === 'list' && parent.ordered === lm.ordered && parent.bullet === lm.bullet) {
      list = parent;
    } else {
      list = {
        type: 'list',
        ordered: lm.ordered,
        bullet: lm.bullet,
        start: lm.ordered ? lm.num : 1,
        loose: false,
        children: [],
      };
      addBlock(list);
    }
    if (blankPending && list.children.length > 0) list.loose = true;
    blankPending = false;
    const item = {
      type: 'item',
      contentIndent: lm.contentIndent,
      markerIndent: lm.indent,
      list,
      children: [],
    };
    list.children.push(item);
    containers.push(list, item);
    if (lm.empty) {
      i++;
    } else {
      // The item content starts at `contentIndent` columns into the
      // line, measured from the absolute column of the marker.
      startBlock(lm.content, (startCol || 0) + lm.contentIndent);
    }
  }
}

// Parse a link reference definition from `text` (one to three lines joined
// with \n). Returns { label, href, title, lines } or null.
function parseDefText(text) {
  let pos = 0;
  const n = text.length;
  // Up to 3 leading spaces.
  let spaces = 0;
  while (pos < n && text.charCodeAt(pos) === 32 && spaces < 3) {
    pos++;
    spaces++;
  }
  if (pos >= n || text.charCodeAt(pos) !== 91) return null;
  pos++;
  // Label: no nested [, no unescaped ], newlines allowed unless followed
  // by a blank line; must not be blank.
  let label = '';
  let labelLines = 1;
  let blankLabel = true;
  while (pos < n) {
    const c = text.charCodeAt(pos);
    if (c === 92 && pos + 1 < n) {
      // Keep the escape raw; normalizeLabel unescapes it (the same
      // unescaping the link's label gets, so the two agree).
      label += text[pos] + text[pos + 1];
      pos += 2;
      blankLabel = false;
      continue;
    }
    if (c === 91) return null;
    if (c === 93) {
      pos++;
      break;
    }
    if (c === 10) {
      // Newline in a label: allowed unless the next line is blank.
      let j = pos + 1;
      while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
      if (j >= n || text.charCodeAt(j) === 10) return null;
      label += '\n';
      labelLines++;
      pos++;
      continue;
    }
    if (c !== 32 && c !== 9) blankLabel = false;
    label += text[pos];
    pos++;
  }
  if (blankLabel || label === '') return null;
  if (pos > n || text[pos - 1] !== ']') return null;
  // The colon.
  if (pos >= n || text.charCodeAt(pos) !== 58) return null;
  pos++;
  // Optional spaces, then optionally a newline and spaces (dest on the
  // next line).
  while (pos < n && (text.charCodeAt(pos) === 32 || text.charCodeAt(pos) === 9)) pos++;
  if (pos < n && text.charCodeAt(pos) === 10) {
    let j = pos + 1;
    let k = j;
    while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
    if (k < n && text.charCodeAt(k) !== 10) {
      pos = k;
    }
  }
  // Destination: <...> or a bare run of non-space characters.
  let href = '';
  if (pos < n && text.charCodeAt(pos) === 60) {
    pos++;
    let ok = false;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 62) {
        ok = true;
        pos++;
        break;
      }
      if (c === 10 || c === 60) return null;
      if (c === 92 && pos + 1 < n) {
        href += text[pos] + text[pos + 1];
        pos += 2;
        continue;
      }
      href += text[pos];
      pos++;
    }
    if (!ok) return null;
  } else {
    // A bare destination: non-space characters, with backslash escapes
    // and balanced parentheses at any depth. A ')' at depth 0 ends it.
    const start = pos;
    let depth = 0;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 92 && pos + 1 < n) {
        pos += 2;
        continue;
      }
      if (c === 40) {
        depth++;
        pos++;
        continue;
      }
      if (c === 41) {
        if (depth === 0) break;
        depth--;
        pos++;
        continue;
      }
      pos++;
    }
    if (pos === start) return null;
    href = text.slice(start, pos);
  }
  // Optional title, possibly on the next line. Only move to the next line
  // when it actually starts a title quote; otherwise the definition ends
  // at the end of the destination's line (a following line that is not a
  // title, e.g. another definition, must not be swallowed). A title must
  // be separated from the destination by whitespace. A title that starts
  // on a FOLLOWING line and turns out invalid (unclosed, blank line
  // inside, junk after it) does not kill the definition: it stands
  // without the title and the following line is a paragraph. A title
  // that starts on the SAME line and is invalid kills the definition.
  let title = null;
  let save = pos;
  let hadSpace = false;
  let titleOnNextLine = false;
  while (pos < n && (text.charCodeAt(pos) === 32 || text.charCodeAt(pos) === 9)) {
    pos++;
    hadSpace = true;
  }
  if (pos < n && text.charCodeAt(pos) === 10) {
    let j = pos + 1;
    let k = j;
    while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
    const qc = k < n ? text.charCodeAt(k) : -1;
    if (k < n && qc !== 10 && (qc === 34 || qc === 39 || qc === 40)) {
      pos = k;
      hadSpace = true;
      titleOnNextLine = true;
    } else {
      pos = save;
      hadSpace = false;
    }
  }
  if (pos < n) {
    const c = text.charCodeAt(pos);
    if (c === 34 || c === 39 || c === 40) {
      if (!hadSpace) return null;
      const close = c === 34 ? 34 : c === 39 ? 39 : 41;
      let t = '';
      let ok = false;
      let bad = false;
      let p = pos + 1;
      while (p < n) {
        const d = text.charCodeAt(p);
        if (d === close) {
          ok = true;
          p++;
          break;
        }
        if (d === 92 && p + 1 < n) {
          t += text[p] + text[p + 1];
          p += 2;
          continue;
        }
        if (d === 10) {
          // A title may span lines but not a blank line.
          let j = p + 1;
          while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
          if (j >= n || text.charCodeAt(j) === 10) {
            bad = true;
            break;
          }
        }
        t += text[p];
        p++;
      }
      if (!ok || bad) {
        if (titleOnNextLine) {
          title = null;
          pos = save;
        } else {
          return null;
        }
      } else {
        title = t;
        pos = p;
      }
    }
  }
  // Only spaces to the end of the line.
  while (pos < n && (text.charCodeAt(pos) === 32 || text.charCodeAt(pos) === 9)) pos++;
  let endLine = pos < n && text.charCodeAt(pos) === 10;
  if (!endLine && pos !== n) {
    // Junk after the title (or after the destination). A title that was
    // on a following line is dropped and the check retried from the end
    // of the destination line.
    if (title !== null && titleOnNextLine) {
      title = null;
      pos = save;
      while (pos < n && (text.charCodeAt(pos) === 32 || text.charCodeAt(pos) === 9)) pos++;
      endLine = pos < n && text.charCodeAt(pos) === 10;
      if (!endLine && pos !== n) return null;
    } else {
      return null;
    }
  }
  // Count how many lines the definition spans.
  const consumed = text.slice(0, pos).split('\n').length;
  // The destination is unescaped (backslash before ASCII punctuation)
  // and encoded, exactly like an inline link's; the title is unescaped.
  const clean = cleanHref(unescapeBackslashes(href));
  if (clean === null) return null;
  return {
    label: normalizeLabel(label),
    href: clean,
    title: title === null ? null : unescapeBackslashes(title),
    lines: consumed,
  };
}

// ---------- Inline parsing ----------

// ASCII punctuation characters (for backslash escapes and flanking).
function isAsciiPunctCode(c) {
  return (
    (c >= 33 && c <= 47) ||
    (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) ||
    (c >= 123 && c <= 126)
  );
}

// Is the single character `ch` punctuation (ASCII punctuation, or a
// Unicode punctuation character)?
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
function isPunctChar(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isAsciiPunctCode(c);
  return UNICODE_PUNCT.test(ch);
}

function isSpaceChar(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isSpaceCode(c);
  return /\s/.test(ch);
}

// Escape text for HTML output, in a single pass: a numeric reference is
// decoded and the resulting character escaped (& -> &amp;, " -> &quot;,
// ...); a & that starts a valid entity reference (&copy; &#35; &#x41;) is
// left alone; any other & < > " ' is escaped. Numeric references have at
// most 7 decimal or 6 hex digits; 0, surrogates and values above 0x10FFFF
// become U+FFFD.
const ENTITY_AFTER_AMP = /^(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);/;
const NUMERIC_REF = /^#(?:([0-9]{1,7})|[xX]([0-9a-fA-F]{1,6}));/;
function escapeText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      // A numeric reference: decode it, then escape the result.
      const m = NUMERIC_REF.exec(s.slice(i + 1));
      if (m) {
        let cp = m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2], 16);
        let ch;
        if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
          ch = '�';
        } else {
          ch = String.fromCodePoint(cp);
        }
        let rep = ch;
        if (ch === '&') rep = '&amp;';
        else if (ch === '<') rep = '&lt;';
        else if (ch === '>') rep = '&gt;';
        else if (ch === '"') rep = '&quot;';
        else if (ch === "'") rep = '&#39;';
        out += s.slice(start, i) + rep;
        i += m[0].length;
        start = i + 1;
        continue;
      }
      // A valid entity reference is left alone.
      if (ENTITY_AFTER_AMP.test(s.slice(i + 1))) continue;
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else if (c === 60) {
      out += s.slice(start, i) + '&lt;';
      start = i + 1;
    } else if (c === 62) {
      out += s.slice(start, i) + '&gt;';
      start = i + 1;
    } else if (c === 34) {
      out += s.slice(start, i) + '&quot;';
      start = i + 1;
    } else if (c === 39) {
      out += s.slice(start, i) + '&#39;';
      start = i + 1;
    }
  }
  if (start === 0) return s;
  return out + s.slice(start);
}

// Escape an attribute value (href or title): like escapeText but numeric
// references are NOT decoded.
function escapeAttr(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      if (!ENTITY_AFTER_AMP.test(s.slice(i + 1))) rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  return out + s.slice(start);
}

// Escape code content: every & < > " ' is escaped, with no exception for
// entity references.
function escapeCode(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  return out + s.slice(start);
}

// Remove backslash escapes: a backslash before ASCII punctuation yields
// the punctuation character; anything else keeps the backslash.
function unescapeBackslashes(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isAsciiPunctCode(s.charCodeAt(i + 1))) {
      out += s.slice(start, i) + s[i + 1];
      start = i + 2;
      i++;
    }
  }
  if (start === 0) return s;
  return out + s.slice(start);
}

// Encode a link destination the way marked does: encodeURI, then put
// literal % back (so %20 stays %20). Returns null when encoding throws.
function cleanHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// ---------- GFM extended autolinks ----------

function isAlnumCode(c) {
  return (
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
  );
}

function isBackpedalPunct(c) {
  return (
    c === 63 || // ?
    c === 33 || // !
    c === 46 || // .
    c === 44 || // ,
    c === 58 || // :
    c === 59 || // ;
    c === 42 || // *
    c === 95 || // _
    c === 39 || // '
    c === 34 || // "
    c === 126 // ~
  );
}

// Trim a GFM autolink candidate: drop a trailing &word; entity-like
// suffix, drop a trailing run of punctuation, drop a trailing ')' that
// does not close a simple (...) group at the end, and drop a trailing
// '(' group that never closes.
function backpedalUrl(url) {
  for (;;) {
    // A trailing &word; is not part of the URL (it reads as an entity
    // reference); repeat, so &copy;&reg; loses both.
    if (url.length > 0 && url.charCodeAt(url.length - 1) === 59) {
      let k = url.length - 2;
      while (
        k >= 0 &&
        (isAlnumCode(url.charCodeAt(k)) || url.charCodeAt(k) === 95)
      ) {
        k--;
      }
      if (k >= 0 && url.charCodeAt(k) === 38 && k < url.length - 2) {
        url = url.slice(0, k);
        continue;
      }
    }
    let end = url.length;
    while (end > 0 && isBackpedalPunct(url.charCodeAt(end - 1))) end--;
    if (end < url.length) {
      url = url.slice(0, end);
      continue;
    }
    if (end === 0) return url;
    const last = url.charCodeAt(end - 1);
    if (last === 41) {
      // Is the final ')' part of a simple (...) group at the end?
      let open = -1;
      for (let k = end - 2; k >= 0; k--) {
        const c = url.charCodeAt(k);
        if (c === 40) {
          open = k;
          break;
        }
        if (c === 41) break;
      }
      if (open === -1) {
        url = url.slice(0, -1);
        continue;
      }
      return url;
    }
    // A trailing '(' group: \( [^()]* $ — remove it and repeat.
    let open = -1;
    for (let k = end - 1; k >= 0; k--) {
      const c = url.charCodeAt(k);
      if (c === 40) {
        open = k;
        break;
      }
      if (c === 41) break;
    }
    if (open === -1) return url;
    url = url.slice(0, open);
  }
}

// Characters allowed in the local part of a bare email address.
function isEmailLocalChar(c) {
  return isAlnumCode(c) || c === 46 || c === 95 || c === 43 || c === 45;
}

// Characters allowed in a domain label of a bare email address.
function isEmailDomainChar(c) {
  return isAlnumCode(c) || c === 95 || c === 45;
}

// Try to match a bare email address at `pos` in `text`.
// Returns the end position (exclusive) or -1.
function matchEmail(text, pos) {
  const end = matchEmailEnd(text, pos);
  if (end === -1) return -1;
  // The character after the domain must not be [A-Za-z0-9_-].
  if (end < text.length) {
    const c = text.charCodeAt(end);
    if (isAlnumCode(c) || c === 95 || c === 45) return -1;
  }
  return end;
}

// Match a bare email address without the trailing-character check.
// Returns the end position (exclusive) or -1.
function matchEmailEnd(text, pos) {
  const n = text.length;
  let i = pos;
  while (i < n && isEmailLocalChar(text.charCodeAt(i))) i++;
  if (i === pos) return -1;
  if (i >= n || text.charCodeAt(i) !== 64) return -1; // '@'
  i++;
  // First domain label: [A-Za-z0-9_-]+
  const domStart = i;
  while (i < n && isEmailDomainChar(text.charCodeAt(i))) i++;
  if (i === domStart) return -1;
  // Further labels: .[A-Za-z0-9_-]*[A-Za-z0-9] (must end alphanumeric).
  let labels = 0;
  let end = i;
  while (i < n && text.charCodeAt(i) === 46) {
    let j = i + 1;
    let lastAlnum = -1;
    while (j < n && isEmailDomainChar(text.charCodeAt(j))) {
      if (isAlnumCode(text.charCodeAt(j))) lastAlnum = j;
      j++;
    }
    if (lastAlnum === -1) break;
    labels++;
    i = lastAlnum + 1;
    end = i;
  }
  if (labels === 0) return -1;
  return end;
}

// Try to match a GFM extended autolink (www. / http(s):// / ftp:// /
// mailto: / xmpp:) at `pos`. `prevLast` is the last character code of the
// text immediately before this position (-1 when there is none, or when
// the previous token is not text). Returns { end, href, text } or null.
function matchGfmUrl(text, pos, prevLast) {
  const n = text.length;
  const c0 = text.charCodeAt(pos);
  // www. — the previous token must not be a text token ending in a
  // character outside [whitespace * _ ~ (].
  if (c0 === 119 && text.startsWith('www.', pos)) {
    if (
      prevLast !== -1 &&
      !(prevLast === 32 || prevLast === 9 || prevLast === 10 || prevLast === 42 || prevLast === 95 || prevLast === 126 || prevLast === 40)
    ) {
      return null;
    }
    const after = pos + 4;
    if (after >= n) return null;
    const c = text.charCodeAt(after);
    if (c === 46 || isSpaceCode(c) || c === 60) return null;
    let end = after;
    while (end < n && !isSpaceCode(text.charCodeAt(end)) && text.charCodeAt(end) !== 60) end++;
    const url = backpedalUrl(text.slice(pos, end));
    if (url.length === 0) return null;
    const href = cleanHref(url);
    if (href === null) return null;
    return { end: pos + url.length, href: 'http://' + href, text: url };
  }
  // http:// https:// ftp:// (any case, any preceding character).
  let schemeLen = 0;
  if (c0 === 104 || c0 === 72) {
    if (text.slice(pos, pos + 7).toLowerCase() === 'http://') schemeLen = 7;
    else if (text.slice(pos, pos + 8).toLowerCase() === 'https://') schemeLen = 8;
  } else if (c0 === 102 || c0 === 70) {
    if (text.slice(pos, pos + 6).toLowerCase() === 'ftp://') schemeLen = 6;
  }
  if (schemeLen > 0) {
    const after = pos + schemeLen;
    if (after >= n) return null;
    const c = text.charCodeAt(after);
    if (c === 46 || isSpaceCode(c) || c === 60) return null;
    let end = after;
    while (end < n && !isSpaceCode(text.charCodeAt(end)) && text.charCodeAt(end) !== 60) end++;
    const url = backpedalUrl(text.slice(pos, end));
    if (url.length === 0) return null;
    const href = cleanHref(url);
    if (href === null) return null;
    return { end: pos + url.length, href, text: url };
  }
  // mailto: / xmpp: (lowercase only), preceded by the start or a
  // non-alphanumeric character, followed by a valid email.
  if (c0 === 109 || c0 === 120) {
    let len = 0;
    if (text.startsWith('mailto:', pos)) len = 7;
    else if (text.startsWith('xmpp:', pos)) len = 5;
    if (len > 0) {
      if (pos > 0 && isAlnumCode(text.charCodeAt(pos - 1))) return null;
      const emailEnd = matchEmail(text, pos + len);
      if (emailEnd === -1) return null;
      let end = emailEnd;
      // xmpp: allows one resource segment after the email (/resource).
      if (len === 5 && end < n && text.charCodeAt(end) === 47) {
        let r = end + 1;
        while (
          r < n &&
          !isSpaceCode(text.charCodeAt(r)) &&
          text.charCodeAt(r) !== 60 &&
          text.charCodeAt(r) !== 47
        ) {
          r++;
        }
        if (r > end + 1) end = r;
      }
      const url = backpedalUrl(text.slice(pos, end));
      if (url.length === 0) return null;
      const href = cleanHref(url);
      if (href === null) return null;
      return { end: pos + url.length, href, text: url };
    }
  }
  return null;
}

// ---------- Links and images ----------

function isAsciiLetter(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isAsciiAlnum(c) {
  return isAlnumCode(c);
}

// Length of the backtick run starting at `i`.
function backtickRunLength(text, i) {
  let len = 0;
  while (i + len < text.length && text.charCodeAt(i + len) === 96) len++;
  return len;
}

// Index of a backtick run of exactly `run` length at or after `from`,
// or -1.
function findCodeClose(text, from, run) {
  const n = text.length;
  let i = from;
  while (i < n) {
    if (text.charCodeAt(i) === 96) {
      const len = backtickRunLength(text, i);
      if (len === run) return i;
      i += len;
    } else {
      i++;
    }
  }
  return -1;
}

// Flags for tokenizeInline: NO_GFM suppresses GFM extended autolinks and
// bare emails (used for a link's text, where they must not fire);
// NO_EM suppresses emphasis and strikethrough delimiters (used for the
// text of a failed inline link, where marked leaves them literal).
const NO_GFM = 1;
const NO_EM = 2;

// Find the end (exclusive) of the parenthesized group starting at `pos`
// (text[pos] === '('), tracking nesting and backslash escapes. When there
// is no matching ')', the group runs to the end of the text.
function findParenGroupEnd(text, pos) {
  const n = text.length;
  let depth = 0;
  let i = pos;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 92 && i + 1 < n) {
      i += 2;
      continue;
    }
    if (c === 40) depth++;
    else if (c === 41) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return n;
}

// Find the ']' closing a link text that starts at `start` (just after the
// '['). Bracket depth is tracked; backslash escapes and code spans are
// skipped (a code span runs from one backtick run to the next, of any
// length; an unclosed code span means there is no closing bracket).
// Returns the index of the closing ']' or -1.
function findLinkTextEnd(text, start) {
  const n = text.length;
  let depth = 1;
  let i = start;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 92 && i + 1 < n) {
      i += 2;
      continue;
    }
    if (c === 96) {
      const run = backtickRunLength(text, i);
      let j = i + run;
      let found = -1;
      while (j < n) {
        if (text.charCodeAt(j) === 96) {
          found = j;
          break;
        }
        j++;
      }
      if (found === -1) return -1;
      i = found + backtickRunLength(text, found);
      continue;
    }
    if (c === 91) {
      depth++;
      i++;
      continue;
    }
    if (c === 93) {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    if (c === 60) {
      // A complete autolink or inline HTML tag is skipped whole: a ']'
      // inside it does not close the link text.
      const auto = matchAutolink(text, i);
      if (auto !== null) {
        i = auto.end;
        continue;
      }
      const tagEnd = matchInlineHtml(text, i);
      if (tagEnd !== -1) {
        i = tagEnd;
        continue;
      }
    }
    i++;
  }
  return -1;
}

// Like findLinkTextEnd, but code spans pair runs of equal length, and
// the ']' is accepted only when it comes immediately after a code-span
// closer. Used as a fallback when findLinkTextEnd reports no bracket
// (its any-length code-span skipping mistakes a shorter backtick run
// inside a code span for the closer).
function findLinkTextEndAfterCodeSpan(text, start) {
  const n = text.length;
  let depth = 1;
  let i = start;
  let justClosedCode = false;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 92 && i + 1 < n) {
      i += 2;
      justClosedCode = false;
      continue;
    }
    if (c === 96) {
      const run = backtickRunLength(text, i);
      const close = findCodeClose(text, i + run, run);
      if (close === -1) return -1;
      i = close + run;
      justClosedCode = true;
      continue;
    }
    if (c === 91) {
      depth++;
      i++;
      justClosedCode = false;
      continue;
    }
    if (c === 93) {
      depth--;
      if (depth === 0) return justClosedCode ? i : -1;
      i++;
      justClosedCode = false;
      continue;
    }
    if (c === 60) {
      const auto = matchAutolink(text, i);
      if (auto !== null) {
        i = auto.end;
        justClosedCode = false;
        continue;
      }
      const tagEnd = matchInlineHtml(text, i);
      if (tagEnd !== -1) {
        i = tagEnd;
        justClosedCode = false;
        continue;
      }
    }
    i++;
    justClosedCode = false;
  }
  return -1;
}

// Expand leading tabs in `text` to spaces, measuring tab widths from
// absolute column `startCol`. Leading spaces are kept as-is. Used for
// paragraph continuation lines inside a container, where a tab after
// the container marker (e.g. `> \tbar`) must become spaces.
function expandLeadingTabs(text, startCol) {
  let col = startCol || 0;
  let i = 0;
  let out = '';
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 32) {
      out += ' ';
      col++;
      i++;
    } else if (c === 9) {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      i++;
    } else {
      break;
    }
  }
  return out + text.slice(i);
}

// Does `text` contain a code span whose opener has no same-length
// closer later in the text, but a later backtick run of a different
// length (so the "any length" link-text scan would close it there)?
// Runs are matched same-length: a run that pairs with a later run of
// the same length is a matched code span, not mismatched. A lone
// unclosed run (no later run at all) is not mismatched either.
function hasMismatchedCodeSpan(text) {
  const n = text.length;
  // Collect the backtick runs.
  const runs = [];
  let i = 0;
  while (i < n) {
    if (text.charCodeAt(i) !== 96) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && text.charCodeAt(j) === 96) j++;
    runs.push({ pos: i, len: j - i });
    i = j;
  }
  for (let r = 0; r < runs.length; r++) {
    const len = runs[r].len;
    let sameLater = -1;
    let diffLater = -1;
    for (let s = r + 1; s < runs.length; s++) {
      if (runs[s].len === len && sameLater === -1) sameLater = s;
      if (runs[s].len !== len && diffLater === -1) diffLater = s;
    }
    if (sameLater !== -1) {
      // This run opens a matched code span; skip past its closer.
      r = sameLater;
      continue;
    }
    // No same-length closer: mismatched iff a different-length run
    // follows (the any-length scan would close it there).
    if (diffLater !== -1) return true;
    return false;
  }
  return false;
}

// Does `text` contain any backtick run (a code span attempt)?
function hasBacktick(text) {
  return text.indexOf('`') !== -1;
}

// Skip whitespace (spaces, tabs, single newlines) in an inline link.
// A blank line is not allowed: returns -1 in that case.
function skipInlineWhitespace(text, pos) {
  const n = text.length;
  for (;;) {
    while (pos < n && (text.charCodeAt(pos) === 32 || text.charCodeAt(pos) === 9)) pos++;
    if (pos < n && text.charCodeAt(pos) === 10) {
      let j = pos + 1;
      while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
      if (j >= n || text.charCodeAt(j) === 10) return -1;
      pos = j;
      continue;
    }
    return pos;
  }
}

// Scan a bare link destination starting at `pos` (balanced parentheses at
// any depth, backslash escapes before ASCII punctuation). Returns the end
// position, or -1 when the destination is empty.
function scanBareDest(text, pos) {
  const n = text.length;
  const start = pos;
  let depth = 0;
  while (pos < n) {
    const c = text.charCodeAt(pos);
    if (c === 32 || c === 9 || c === 10) break;
    if (c === 92 && pos + 1 < n && isAsciiPunctCode(text.charCodeAt(pos + 1))) {
      pos += 2;
      continue;
    }
    if (c === 40) {
      depth++;
      pos++;
      continue;
    }
    if (c === 41) {
      if (depth === 0) break;
      depth--;
      pos++;
      continue;
    }
    pos++;
  }
  if (pos === start) return -1;
  return pos;
}

// Parse the "(dest title)" suffix of an inline link, starting at `pos`
// (where text[pos] === '('). Returns { end, href, title } or null.
function parseInlineLinkSuffix(text, pos, refs) {
  const n = text.length;
  let p = skipInlineWhitespace(text, pos + 1);
  if (p === -1) return null;
  let href = '';
  if (p < n && text.charCodeAt(p) === 60) {
    // A <...> destination: no newline, no '<' inside.
    let q = p + 1;
    let ok = false;
    while (q < n) {
      const c = text.charCodeAt(q);
      if (c === 62) {
        ok = true;
        break;
      }
      if (c === 10 || c === 60) return null;
      if (c === 92 && q + 1 < n) {
        href += text[q] + text[q + 1];
        q += 2;
        continue;
      }
      href += text[q];
      q++;
    }
    if (!ok) return null;
    p = q + 1;
  } else {
    const end = scanBareDest(text, p);
    if (end === -1) {
      // An empty destination is allowed when the closing paren follows.
      if (p < n && text.charCodeAt(p) === 41) {
        href = '';
      } else {
        return null;
      }
    } else {
      href = text.slice(p, end);
      p = end;
    }
  }
  // Optional title. A title must be separated from the destination by
  // whitespace (a quote or paren immediately after the destination is
  // not a title, so the link is invalid).
  let title = null;
  const afterDest = skipInlineWhitespace(text, p);
  if (afterDest === -1) return null;
  const hadSpace = afterDest > p;
  p = afterDest;
  if (p < n) {
    const c = text.charCodeAt(p);
    if (c === 34 || c === 39 || c === 40) {
      if (!hadSpace) return null;
      const close = c === 34 ? 34 : c === 39 ? 39 : 41;
      let t = '';
      let ok = false;
      let q = p + 1;
      while (q < n) {
        const d = text.charCodeAt(q);
        if (d === close) {
          ok = true;
          q++;
          break;
        }
        if (d === 92 && q + 1 < n) {
          t += text[q] + text[q + 1];
          q += 2;
          continue;
        }
        if (d === 10) {
          // A title may span lines but not blank lines.
          let j = q + 1;
          while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
          if (j >= n || text.charCodeAt(j) === 10) return null;
        }
        t += text[q];
        q++;
      }
      if (!ok) return null;
      title = t;
      p = q;
    }
  }
  const afterTitle = skipInlineWhitespace(text, p);
  if (afterTitle === -1) return null;
  p = afterTitle;
  if (p >= n || text.charCodeAt(p) !== 41) return null;
  const clean = cleanHref(unescapeBackslashes(href));
  if (clean === null) return null;
  return {
    end: p + 1,
    href: clean,
    title: title === null ? null : unescapeBackslashes(title),
  };
}

// Does the token list (recursively) contain a link token?
function containsLink(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === 'link') return true;
    if (tok.children && containsLink(tok.children)) return true;
  }
  return false;
}

// Try to parse a link (or, with isImage, an image) starting at `pos`.
// Returns { end, href, title, children } for a link, or
// { end, src, alt, title } for an image, or null.
function parseLinkAt(text, pos, refs, isImage, flags) {
  const n = text.length;
  const bracket = isImage ? pos + 1 : pos;
  let textEnd = findLinkTextEnd(text, bracket + 1);
  if (textEnd === -1) {
    // findLinkTextEnd skips code spans to the next backtick run of any
    // length, so a code span holding a shorter backtick run (`` a ` b ``)
    // looks unclosed and the ']' is missed. Fall back to same-length
    // code-span skipping, but accept the ']' only when it comes
    // immediately after a code-span closer: `[a `` b ` c `` d]` is not
    // a link (text follows the closer), while `[a `` b ` c ``]` is.
    textEnd = findLinkTextEndAfterCodeSpan(text, bracket + 1);
  }
  if (textEnd === -1) return null;
  const linkText = text.slice(bracket + 1, textEnd);
  let after = textEnd + 1;
  let href = null;
  let title = null;
  let inlineOk = false;
  if (after < n && text.charCodeAt(after) === 40) {
    // An inline link. When its destination or title is invalid, fall
    // through to the reference forms below: [foo](not a link) is a
    // shortcut reference link when a [foo] definition exists.
    const parsed = parseInlineLinkSuffix(text, after, refs);
    if (parsed !== null) {
      href = parsed.href;
      title = parsed.title;
      after = parsed.end;
      inlineOk = true;
    }
  }
  if (!inlineOk) {
    if (
      after + 1 < n &&
      text.charCodeAt(after) === 91 &&
      text.charCodeAt(after + 1) === 93
    ) {
      // A collapsed reference link: [text][]. This must be checked
      // before the full-reference branch below, which would otherwise
      // read the empty label and reject it.
      const label = normalizeLabel(linkText);
      if (label === '') return null;
      const ref = refs.get(label);
      if (ref === undefined) return null;
      href = ref.href;
      title = ref.title;
      after += 2;
    } else if (after < n && text.charCodeAt(after) === 91) {
      // A full reference link: [text][label].
      let q = after + 1;
      let labelEnd = -1;
      while (q < n) {
        const c = text.charCodeAt(q);
        if (c === 92 && q + 1 < n) {
          q += 2;
          continue;
        }
        if (c === 93) {
          labelEnd = q;
          break;
        }
        q++;
      }
      if (labelEnd === -1) return null;
      const label = normalizeLabel(text.slice(after + 1, labelEnd));
      if (label === '') return null;
      const ref = refs.get(label);
      if (ref === undefined) return null;
      href = ref.href;
      title = ref.title;
      after = labelEnd + 1;
    } else {
      // A shortcut reference link: [text].
      const label = normalizeLabel(linkText);
      if (label === '') return null;
      const ref = refs.get(label);
      if (ref === undefined) return null;
      href = ref.href;
      title = ref.title;
    }
  }
  // A link's text never contains a GFM extended autolink or a bare email
  // (they stay literal there); the caller's flags (e.g. NO_EM inside a
  // failed inline link) propagate into nested links.
  const children = tokenizeInline(linkText, refs, (flags || 0) | NO_GFM);
  const mismatchCode = hasMismatchedCodeSpan(linkText);
  const hasCode = hasBacktick(linkText);
  if (isImage) {
    // The alt is the plain-text content of the link text: text and code
    // contribute their raw text, a nested image contributes its own alt,
    // a link or emphasis contributes its children's text, and raw HTML
    // contributes nothing.
    const alt = inlineTextContent(children);
    return { end: after, src: href, alt, title, mismatchCode, hasCode };
  }
  // A link may not contain another link anywhere in its text.
  if (containsLink(children)) return null;
  return { end: after, href, title, children, mismatchCode, hasCode };
}

// The plain-text content of inline tokens, for an image's alt attribute:
// text and code contribute their raw text, a nested image contributes its
// own alt, a link or emphasis contributes its children's text, and raw
// HTML contributes nothing.
function inlineTextContent(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === 'text' || tok.t === 'code') out += tok.s;
    else if (tok.t === 'image') out += tok.alt;
    else if (tok.t === 'autolink') out += tok.text;
    else if (tok.children) out += inlineTextContent(tok.children);
  }
  return out;
}

// Render inline tokens to HTML and strip the tags (for image alt text).
const TAG_STRIP_RE = /<[^>]*>/g;
function stripTags(html) {
  return html.replace(TAG_STRIP_RE, '');
}

// Match an inline HTML tag at `pos` (text[pos] === '<').
// Returns the end position (exclusive) or -1.
function matchInlineHtml(text, pos) {
  const n = text.length;
  if (pos + 1 >= n) return -1;
  const c1 = text.charCodeAt(pos + 1);
  if (c1 === 33) {
    // <!-- ... --> or <![CDATA[ ... ]]> or <!Letter ... >
    if (text.startsWith('<!--', pos)) {
      // The empty comments <!--> and <!---> are complete by themselves;
      // only otherwise does the comment run to the next -->.
      if (text.charCodeAt(pos + 4) === 62) return pos + 5;
      if (text.charCodeAt(pos + 4) === 45 && text.charCodeAt(pos + 5) === 62) return pos + 6;
      const end = text.indexOf('-->', pos + 4);
      if (end === -1) return -1;
      return end + 3;
    }
    if (text.startsWith('<![CDATA[', pos)) {
      const end = text.indexOf(']]>', pos + 9);
      if (end === -1) return -1;
      return end + 3;
    }
    if (pos + 2 < n && isAsciiLetter(text.charCodeAt(pos + 2))) {
      let i = pos + 2;
      while (i < n && isAsciiLetter(text.charCodeAt(i))) i++;
      if (i >= n || !isSpaceCode(text.charCodeAt(i))) return -1;
      const end = text.indexOf('>', i);
      if (end === -1) return -1;
      return end + 1;
    }
    return -1;
  }
  if (c1 === 63) {
    const end = text.indexOf('?>', pos + 2);
    if (end === -1) return -1;
    return end + 2;
  }
  if (c1 === 47) {
    // A closing tag: </name [ \t]*>
    if (pos + 2 >= n || !isAsciiLetter(text.charCodeAt(pos + 2))) return -1;
    let i = pos + 2;
    while (i < n && (isAsciiAlnum(text.charCodeAt(i)) || text.charCodeAt(i) === 45)) i++;
    while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
    if (i >= n || text.charCodeAt(i) !== 62) return -1;
    return i + 1;
  }
  if (!isAsciiLetter(c1)) return -1;
  // An open tag: <name (attribute)* /?>
  let i = pos + 1;
  while (i < n && (isAsciiAlnum(text.charCodeAt(i)) || text.charCodeAt(i) === 45)) i++;
  for (;;) {
    let j = i;
    while (j < n && isSpaceCode(text.charCodeAt(j))) j++;
    if (j >= n) return -1;
    const d = text.charCodeAt(j);
    if (d === 62) return j + 1;
    if (d === 47) {
      if (j + 1 < n && text.charCodeAt(j + 1) === 62) return j + 2;
      return -1;
    }
    // An attribute must be separated from the tag name (or the previous
    // attribute) by whitespace: <m:abc> and <a href='bar'title=title>
    // are not tags.
    if (j === i) return -1;
    // An attribute name: [A-Za-z_:][A-Za-z0-9_.:-]*
    if (!(isAsciiLetter(d) || d === 95 || d === 58)) return -1;
    let k = j + 1;
    while (
      k < n &&
      (isAsciiAlnum(text.charCodeAt(k)) ||
        text.charCodeAt(k) === 95 ||
        text.charCodeAt(k) === 58 ||
        text.charCodeAt(k) === 46 ||
        text.charCodeAt(k) === 45)
    ) {
      k++;
    }
    let m = k;
    while (m < n && isSpaceCode(text.charCodeAt(m))) m++;
    if (m < n && text.charCodeAt(m) === 61) {
      m++;
      while (m < n && isSpaceCode(text.charCodeAt(m))) m++;
      if (m >= n) return -1;
      const q = text.charCodeAt(m);
      if (q === 34 || q === 39) {
        const end = text.indexOf(String.fromCharCode(q), m + 1);
        if (end === -1) return -1;
        i = end + 1;
      } else {
        let e = m;
        while (e < n) {
          const ch = text.charCodeAt(e);
          if (
            ch === 32 ||
            ch === 9 ||
            ch === 10 ||
            ch === 34 ||
            ch === 39 ||
            ch === 61 ||
            ch === 60 ||
            ch === 62 ||
            ch === 96
          ) {
            break;
          }
          e++;
        }
        if (e === m) return -1;
        i = e;
      }
    } else {
      i = k;
    }
  }
}

// Match an autolink <...> at `pos` (text[pos] === '<').
// Returns { end, href, text } or null.
function matchAutolink(text, pos) {
  const n = text.length;
  if (pos + 1 >= n) return null;
  const c1 = text.charCodeAt(pos + 1);
  if (isAsciiLetter(c1)) {
    // A scheme autolink: <scheme:...> with a 2-32 character scheme. When
    // this fails (no colon, a bad scheme, a space before '>'), fall through
    // to the email check below — an email's local part starts with a
    // letter too, so it reaches this branch first.
    let i = pos + 1;
    while (
      i < n &&
      (isAsciiAlnum(text.charCodeAt(i)) ||
        text.charCodeAt(i) === 43 ||
        text.charCodeAt(i) === 46 ||
        text.charCodeAt(i) === 45)
    ) {
      i++;
    }
    if (i < n && text.charCodeAt(i) === 58) {
      const schemeLen = i - (pos + 1);
      if (schemeLen >= 2 && schemeLen <= 32) {
        let j = i + 1;
        while (j < n && text.charCodeAt(j) !== 62) {
          const c = text.charCodeAt(j);
          if (c === 32 || c === 9 || c === 10 || c === 60) break;
          j++;
        }
        if (j < n && text.charCodeAt(j) === 62) {
          const url = text.slice(pos + 1, j);
          const href = cleanHref(url);
          if (href !== null) return { end: j + 1, href, text: url };
        }
      }
    }
  }
  // An email autolink: <local@domain>
  const emailEnd = matchEmail(text, pos + 1);
  if (emailEnd !== -1 && emailEnd < n && text.charCodeAt(emailEnd) === 62) {
    const email = text.slice(pos + 1, emailEnd);
    return { end: emailEnd + 1, href: 'mailto:' + email, text: email };
  }
  return null;
}

// Try to match a strikethrough run at `pos` (text[pos] === '~').
// Returns { end, children } or null.
function matchDel(text, pos, refs, flags) {
  const n = text.length;
  let run = 0;
  while (pos + run < n && text.charCodeAt(pos + run) === 126) run++;
  if (run >= 3) return null;
  // The opener is 1 or 2 tildes; the content must start with a
  // non-space, non-tilde character, end with one, and the closer (of the
  // same length) must not be followed by a tilde.
  const openLen = run >= 2 ? 2 : 1;
  const contentStart = pos + openLen;
  if (contentStart >= n) return null;
  const first = text.charCodeAt(contentStart);
  if (first === 32 || first === 9 || first === 10 || first === 126) return null;
  // Scan for a closer of the same length, allowing nested del runs: a
  // `~` run that opens an inner del is skipped (its own closer pops it
  // off the stack), so the outer opener pairs with the LAST valid closer
  // and the inner pairs nest inside it (`~~a ~~b~~ c~~` nests).
  const stack = [];
  let i = contentStart;
  while (i < n) {
    // A backslash escape is literal content, not a delimiter: skip
    // both characters (so `\~` before a closer does not merge into
    // the closer's run, and the escaped `~` counts as content).
    if (text.charCodeAt(i) === 92 && i + 1 < n) {
      i += 2;
      continue;
    }
    if (text.charCodeAt(i) === 126) {
      let clen = 0;
      while (i + clen < n && text.charCodeAt(i + clen) === 126) clen++;
      if (clen >= 3) {
        i += clen;
        continue;
      }
      const prev = i - 1 >= 0 ? text.charCodeAt(i - 1) : 32;
      // A tilde preceded by a backslash is a literal content
      // character (an escaped ~), so it may precede a closer.
      const prevEscaped = prev === 126 && i - 2 >= 0 && text.charCodeAt(i - 2) === 92;
      const prevOk = prev !== 32 && prev !== 9 && prev !== 10 && (prev !== 126 || prevEscaped);
      const next = i + clen < n ? text.charCodeAt(i + clen) : 32;
      const nextOk = next !== 32 && next !== 9 && next !== 10 && next !== 126;
      // Can this run close the innermost open inner del?
      if (stack.length > 0 && clen >= stack[stack.length - 1] && prevOk) {
        const need = stack[stack.length - 1];
        const afterInner = i + need;
        if (afterInner >= n || text.charCodeAt(afterInner) !== 126) {
          stack.pop();
          i += clen;
          continue;
        }
      }
      // Can this run close MY opener (stack empty)?
      if (stack.length === 0 && clen >= openLen && prevOk) {
        const after = i + openLen;
        if (after >= n || text.charCodeAt(after) !== 126) {
          // The del's content inherits the caller's flags: inside a
          // link's text (NO_GFM) a GFM autolink must not form there
          // (it would nest an <a> inside the <a>); at the top level
          // GFM autolinks inside a del do render.
          const children = tokenizeInline(text.slice(contentStart, i), refs, flags);
          return { end: after, children };
        }
      }
      // Otherwise it may open an inner del.
      if (nextOk) stack.push(clen);
      i += clen;
      continue;
    }
    i++;
  }
  return null;
}

// ---------- The inline tokenizer ----------

// Tokenize inline text into a flat token list, then resolve emphasis.
// Token shapes:
//   { t: 'text', s }            plain text (raw; escaped when rendered)
//   { t: 'code', s }            code span content (raw)
//   { t: 'br' }                 hard break
//   { t: 'html', s }            raw inline HTML
//   { t: 'link', href, title, children }
//   { t: 'image', src, alt, title }
//   { t: 'del', children }      strikethrough
//   { t: 'delim', ch, length, canOpen, canClose }  emphasis delimiter run
//   { t: 'autolink', href, text }
// Is `tag` a closing </a> tag? The tag name is matched
// case-insensitively.
function isCloseAnchorTag(tag) {
  if (tag.length < 4 || tag.charCodeAt(0) !== 60 || tag.charCodeAt(1) !== 47) return false;
  const c2 = tag.charCodeAt(2);
  if (c2 !== 65 && c2 !== 97) return false; // 'A' / 'a'
  const c3 = tag.charCodeAt(3);
  return c3 === 32 || c3 === 9 || c3 === 10 || c3 === 62 || c3 === 47;
}

// Is `tag` (the text of a matched inline HTML tag) an opening <a> tag
// (not a closing </a>)? The tag name is matched case-insensitively.
function isAnchorTag(tag) {
  if (tag.length < 2 || tag.charCodeAt(0) !== 60) return false;
  const c1 = tag.charCodeAt(1);
  if (c1 === 47) return false; // </a>
  const a = c1 === 65 || c1 === 97; // 'A' / 'a'
  if (!a) return false;
  if (tag.length === 2) return false;
  const c2 = tag.charCodeAt(2);
  return c2 === 32 || c2 === 9 || c2 === 10 || c2 === 62 || c2 === 47;
}

// Does the line containing the tag at [pos, tagEnd) hold another tag
// start ('<' followed by a letter, or '</' followed by a letter)?
function lineHasOtherTag(text, pos, tagEnd) {
  const n = text.length;
  let lineStart = 0;
  for (let i = pos - 1; i >= 0; i--) {
    if (text.charCodeAt(i) === 10) {
      lineStart = i + 1;
      break;
    }
  }
  let lineEnd = n;
  for (let i = tagEnd; i < n; i++) {
    if (text.charCodeAt(i) === 10) {
      lineEnd = i;
      break;
    }
  }
  for (let i = lineStart; i < lineEnd; i++) {
    if (i === pos) continue;
    if (text.charCodeAt(i) !== 60) continue;
    if (i + 1 >= lineEnd) continue;
    const d = text.charCodeAt(i + 1);
    if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122)) return true;
    if (d === 47 && i + 2 < lineEnd) {
      const e = text.charCodeAt(i + 2);
      if ((e >= 65 && e <= 90) || (e >= 97 && e <= 122)) return true;
    }
  }
  return false;
}

function tokenizeInline(text, refs, flags) {
  let noGfm = (flags & NO_GFM) !== 0;
  // Whether GFM extended autolinks are off here: the persistent flag
  // (set by a multi-line <a> tag, cleared by an inline </a>) carries
  // across paragraphs, and any <a> opening tag turns it off for the
  // rest of this paragraph.
  let inLink = refs.gfmOff === true;
  const noEm = (flags & NO_EM) !== 0;
  const tokens = [];
  const n = text.length;
  let pos = 0;
  let textStart = -1;
  let emailDeadUntil = -1;

  function flushText(end) {
    if (textStart !== -1 && end > textStart) {
      tokens.push({ t: 'text', s: text.slice(textStart, end) });
    }
    textStart = -1;
  }

  while (pos < n) {
    const c = text.charCodeAt(pos);

    // Backslash escape or hard break.
    if (c === 92) {
      if (pos + 1 < n) {
        const d = text.charCodeAt(pos + 1);
        if (d === 10) {
          // A backslash before a newline is a hard break, unless only
          // whitespace follows the newline.
          let j = pos + 2;
          while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
          let hasContent = false;
          for (let k = j; k < n; k++) {
            if (!isSpaceCode(text.charCodeAt(k))) {
              hasContent = true;
              break;
            }
          }
          if (hasContent) {
            flushText(pos);
            tokens.push({ t: 'br' });
            pos = j;
            continue;
          }
        }
        if (isAsciiPunctCode(d)) {
          flushText(pos);
          tokens.push({ t: 'text', s: text[pos + 1] });
          pos += 2;
          continue;
        }
      }
      if (textStart === -1) textStart = pos;
      pos++;
      continue;
    }

    // A code span.
    if (c === 96) {
      const run = backtickRunLength(text, pos);
      const close = findCodeClose(text, pos + run, run);
      if (close !== -1) {
        flushText(pos);
        let content = text.slice(pos + run, close);
        content = content.replace(/\n/g, ' ');
        if (
          content.length >= 2 &&
          content.charCodeAt(0) === 32 &&
          content.charCodeAt(content.length - 1) === 32 &&
          !/^ +$/.test(content)
        ) {
          content = content.slice(1, -1);
        }
        tokens.push({ t: 'code', s: content });
        pos = close + run;
        continue;
      }
      if (textStart === -1) textStart = pos;
      pos += run;
      continue;
    }

    // Inline HTML or an autolink.
    if (c === 60) {
      const htmlEnd = matchInlineHtml(text, pos);
      if (htmlEnd !== -1) {
        flushText(pos);
        const tag = text.slice(pos, htmlEnd);
        // An <a> opening tag turns GFM autolinks off for the rest of
        // this paragraph; a multi-line <a> tag, or a self-closing
        // <a /> sharing its line with another tag, leaves them off for
        // the rest of the document (a single-line <a> only suppresses
        // them within its own paragraph). An inline </a> turns them
        // back on.
        if (isAnchorTag(tag)) {
          inLink = true;
          // Any inline <a> opening tag leaves GFM autolinks off until
          // an inline </a> (a lone <a> on its own line is an HTML block
          // in marked, not inline, so it never reaches this branch).
          // A self-closing <a /> only does so when it has whitespace
          // before the /> and shares its line with another tag
          // (<a/> with no space does not).
          if (!tag.endsWith('/>')) {
            refs.gfmOff = true;
          } else if (
            tag.length >= 3 &&
            (tag.charCodeAt(tag.length - 3) === 32 || tag.charCodeAt(tag.length - 3) === 9) &&
            lineHasOtherTag(text, pos, htmlEnd)
          ) {
            refs.gfmOff = true;
          }
        } else if (isCloseAnchorTag(tag)) {
          inLink = false;
          refs.gfmOff = false;
        }
        tokens.push({ t: 'html', s: tag });
        pos = htmlEnd;
        continue;
      }
      const auto = matchAutolink(text, pos);
      if (auto !== null) {
        flushText(pos);
        tokens.push({ t: 'autolink', href: auto.href, text: auto.text });
        pos = auto.end;
        continue;
      }
      if (textStart === -1) textStart = pos;
      pos++;
      continue;
    }

    // A link or an image.
    if (c === 91 || (c === 33 && pos + 1 < n && text.charCodeAt(pos + 1) === 91)) {
      const isImage = c === 33;
      const link = parseLinkAt(text, pos, refs, isImage, flags);
      if (link !== null) {
        flushText(pos);
        if (isImage) {
          tokens.push({ t: 'image', src: link.src, alt: link.alt, title: link.title, mismatchCode: link.mismatchCode, hasCode: link.hasCode });
        } else {
          tokens.push({ t: 'link', href: link.href, title: link.title, children: link.children, mismatchCode: link.mismatchCode, hasCode: link.hasCode });
        }
        pos = link.end;
        continue;
      }
      // The link failed. When it was an inline-link attempt ([text](...))
      // whose destination or title is invalid, the whole attempt is
      // rendered with emphasis and strikethrough disabled (marked leaves
      // those delimiters literal there, while code spans, autolinks,
      // images and entities still apply). A failed reference link keeps
      // its emphasis, so only the '(' form is special. The recursion is
      // guarded by noEm so it cannot repeat.
      if (!noEm) {
        const bracket = isImage ? pos + 1 : pos;
        let textEnd = findLinkTextEnd(text, bracket + 1);
        if (textEnd === -1) {
          // No closing bracket was found (an unclosed code span in the
          // link text): fall back to the first unescaped ']' that is not
          // inside a code span (code spans pair runs of equal length),
          // so the attempt is still recognised without mistaking a ']'
          // inside a code span for the link text end.
          let j = bracket + 1;
          while (j < n) {
            const ch = text.charCodeAt(j);
            if (ch === 92 && j + 1 < n) {
              j += 2;
              continue;
            }
            if (ch === 96) {
              const run = backtickRunLength(text, j);
              const close = findCodeClose(text, j + run, run);
              if (close === -1) break;
              j = close + run;
              continue;
            }
            if (ch === 60) {
              // Skip a complete autolink or HTML tag whole, as in
              // findLinkTextEnd, so a ']' inside one is not mistaken
              // for the link text end.
              const auto = matchAutolink(text, j);
              if (auto !== null) {
                j = auto.end;
                continue;
              }
              const tagEnd = matchInlineHtml(text, j);
              if (tagEnd !== -1) {
                j = tagEnd;
                continue;
              }
            }
            if (ch === 93) {
              textEnd = j;
              break;
            }
            j++;
          }
        }
        if (textEnd !== -1 && textEnd + 1 < n && text.charCodeAt(textEnd + 1) === 40) {
          // Only a link that fails because its destination or title is
          // invalid suppresses emphasis. One that fails because its text
          // contains a nested link keeps its emphasis, so probe the link
          // text first and skip the suppression when a link is inside.
          const probe = tokenizeInline(
            text.slice(bracket + 1, textEnd),
            refs,
            flags,
          );
          const hasNestedLink = containsLink(probe);
          if (hasNestedLink) {
            if (textStart === -1) textStart = pos;
            pos++;
            continue;
          }
          const suffixEnd = findParenGroupEnd(text, textEnd + 1);
          flushText(pos);
          const inner = tokenizeInline(text.slice(pos, suffixEnd), refs, NO_EM);
          for (let k = 0; k < inner.length; k++) tokens.push(inner[k]);
          pos = suffixEnd;
          continue;
        }
      }
      if (textStart === -1) textStart = pos;
      pos++;
      continue;
    }

    // An emphasis delimiter run (disabled inside a failed inline link).
    if ((c === 42 || c === 95) && !noEm) {
      let run = 0;
      while (pos + run < n && text.charCodeAt(pos + run) === c) run++;
      const before = pos > 0 ? text[pos - 1] : '';
      const after = pos + run < n ? text[pos + run] : '';
      const beforeIsSpace = pos === 0 ? true : isSpaceChar(before);
      const afterIsSpace = pos + run >= n ? true : isSpaceChar(after);
      const beforeIsPunct = pos === 0 ? false : isPunctChar(before);
      const afterIsPunct = pos + run >= n ? false : isPunctChar(after);
      const leftFlanking =
        !afterIsSpace && (!afterIsPunct || (afterIsPunct && (beforeIsSpace || beforeIsPunct)));
      const rightFlanking =
        !beforeIsSpace && (!beforeIsPunct || (beforeIsPunct && (afterIsSpace || afterIsPunct)));
      let canOpen;
      let canClose;
      if (c === 42) {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      } else {
        canOpen = leftFlanking && (!rightFlanking || beforeIsPunct);
        canClose = rightFlanking && (!leftFlanking || afterIsPunct);
      }
      flushText(pos);
      tokens.push({
        t: 'delim',
        ch: c === 42 ? '*' : '_',
        length: run,
        canOpen,
        canClose,
      });
      pos += run;
      continue;
    }

    // Strikethrough (disabled inside a failed inline link).
    if (c === 126 && !noEm) {
      const del = matchDel(text, pos, refs, flags);
      if (del !== null) {
        flushText(pos);
        tokens.push({ t: 'del', children: del.children });
        pos = del.end;
        continue;
      }
      if (textStart === -1) textStart = pos;
      pos++;
      continue;
    }

    // A hard break: two or more spaces before a newline, unless only
    // whitespace follows the newline.
    if (c === 32) {
      let j = pos;
      while (j < n && text.charCodeAt(j) === 32) j++;
      if (j - pos >= 2 && j < n && text.charCodeAt(j) === 10) {
        let k = j + 1;
        while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
        let hasContent = false;
        for (let m = k; m < n; m++) {
          if (!isSpaceCode(text.charCodeAt(m))) {
            hasContent = true;
            break;
          }
        }
        if (hasContent) {
          flushText(pos);
          tokens.push({ t: 'br' });
          pos = k;
          continue;
        }
      }
      if (textStart === -1) textStart = pos;
      pos = j;
      continue;
    }

    // A newline is a soft break (kept as a literal newline in the output).
    if (c === 10) {
      if (textStart === -1) textStart = pos;
      pos++;
      continue;
    }

    // A GFM extended autolink (www. / http(s):// / ftp:// / mailto: / xmpp:).
    // Disabled inside a link's text, where these stay literal.
    // Do NOT flush the pending text first: flushing here would split a
    // text run in the middle of an entity reference (e.g. "&a" | "mp;"),
    // and the renderer would then escape the "&" of a valid "&amp;".
    // Instead pass the last character of the pending text (or of the
    // previous token) for the www. check, and flush only on a match.
    if (!noGfm && !inLink && (c === 119 || c === 104 || c === 72 || c === 102 || c === 70 || c === 109 || c === 120)) {
      let prevLast = -1;
      if (c === 119 && text.startsWith('www.', pos)) {
        if (textStart !== -1 && pos > textStart) {
          prevLast = text.charCodeAt(pos - 1);
        } else if (tokens.length > 0) {
          const pt = tokens[tokens.length - 1];
          if (pt.t === 'text' && pt.s.length > 0) prevLast = pt.s.charCodeAt(pt.s.length - 1);
        }
      }
      const gfm = matchGfmUrl(text, pos, prevLast);
      if (gfm !== null) {
        flushText(pos);
        tokens.push({ t: 'autolink', href: gfm.href, text: gfm.text });
        pos = gfm.end;
        continue;
      }
      // Not a GFM autolink: fall through to the email check below, so a
      // local part starting with f/h/m/w/x (e.g. foo@bar.baz) still links.
    }

    // A bare email address (disabled inside a link's text, like GFM).
    if (!noGfm && !inLink && isEmailLocalChar(c)) {
      if (pos < emailDeadUntil) {
        if (textStart === -1) textStart = pos;
        pos++;
        continue;
      }
      let emailEnd = matchEmailEnd(text, pos);
      if (emailEnd !== -1 && emailEnd < n) {
        const after = text.charCodeAt(emailEnd);
        if (after === 95) {
          // A trailing '_' kills the email, unless it is a closing
          // emphasis delimiter: an open '_' delimiter earlier in the
          // token stream means the '_' run closes it (so the email
          // inside __...__ links, while foo@bar.baz_ does not).
          let hasOpenUnderscore = false;
          for (let k = 0; k < tokens.length; k++) {
            const tk = tokens[k];
            if (tk.t === 'delim' && tk.ch === '_' && tk.canOpen) {
              hasOpenUnderscore = true;
              break;
            }
          }
          if (!hasOpenUnderscore) emailEnd = -1;
        } else if (after === 45 || isAlnumCode(after)) {
          emailEnd = -1;
        }
      }
      if (emailEnd !== -1) {
        flushText(pos);
        const email = text.slice(pos, emailEnd);
        tokens.push({ t: 'autolink', href: 'mailto:' + email, text: email });
        pos = emailEnd;
        continue;
      }
      // No email here: remember the '@' (or the end of the run) so the
      // same domain is not re-checked from every position in the run.
      let j = pos;
      while (j < n && isEmailLocalChar(text.charCodeAt(j))) j++;
      emailDeadUntil = j < n && text.charCodeAt(j) === 64 ? j : j;
      if (textStart === -1) textStart = pos;
      pos++;
      continue;
    }

    // Anything else is plain text.
    if (textStart === -1) textStart = pos;
    pos++;
  }
  flushText(n);
  // Mark the mismatched-code-span suppression region before emphasis
  // is resolved (top-level tokenization only; link text is tokenized
  // recursively with flags set).
  if (!flags) markMismatchSuppression(tokens);
  processEmphasis(tokens);
  return tokens;
}

// Resolve emphasis delimiters in a token list (CommonMark appendix A).
// Works on the flat list; link and del children were already resolved by
// their own tokenizeInline calls.
function processEmphasis(tokens) {
  for (;;) {
    // Collect the delimiter tokens (by identity).
    const delims = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].t === 'delim') delims.push(tokens[i]);
    }
    let matched = false;
    for (let ci = 0; ci < delims.length && !matched; ci++) {
      const closer = delims[ci];
      if (!closer.canClose) continue;
      for (let oi = ci - 1; oi >= 0; oi--) {
        const opener = delims[oi];
        if (opener.ch !== closer.ch || !opener.canOpen) continue;
        // A restricted opener (blocked by an inner match) may only pair
        // with a closer at least as long as itself, so it is not stolen
        // as em by a shorter closer (a *** closer still pairs with a
        // ** opener, using two of its three runs).
        if (opener.restricted && closer.length < opener.length) continue;
        // The rule of three: when either delimiter can both open and
        // close, the sum of the lengths must not be a multiple of 3
        // unless both lengths are multiples of 3.
        const bothCan =
          (opener.canOpen && opener.canClose) || (closer.canOpen && closer.canClose);
        if (
          bothCan &&
          (opener.length + closer.length) % 3 === 0 &&
          opener.length % 3 !== 0 &&
          closer.length % 3 !== 0
        ) {
          continue;
        }
        const use = opener.length >= 2 && closer.length >= 2 ? 2 : 1;
        // A pair whose opener and closer both lie between a link/image
        // holding a mismatched code span and the next code span never
        // forms (marked leaves it literal); a pair spanning the region
        // (opener before, closer after the code span) still pairs.
        if (opener.inMismatchRegion && closer.inMismatchRegion) continue;
        const type = use === 2 ? 'strong' : 'em';
        const oiIdx = tokens.indexOf(opener);
        const ciIdx = tokens.indexOf(closer);
        const children = tokens.slice(oiIdx + 1, ciIdx);
        opener.length -= use;
        closer.length -= use;
        // Whether this match's closer is immediately followed by a word
        // character while its opener is preceded by whitespace.
        const after = tokens[ciIdx + 1];
        const before = tokens[oiIdx - 1];
        const wordAfter =
          after !== undefined &&
          after.t === 'text' &&
          after.s.length > 0 &&
          !isSpaceCode(after.s.charCodeAt(0)) &&
          !isPunctChar(after.s[0]) &&
          before !== undefined &&
          before.t === 'text' &&
          before.s.length > 0 &&
          isSpaceCode(before.s.charCodeAt(before.s.length - 1));
        // When an inner run's opener is preceded by whitespace and its
        // closer is immediately followed by a word character, an
        // enclosing opener of the same character can no longer pair with
        // a closer of a different length (marked leaves the outer
        // delimiters literal, e.g. `*a **b**c*` keeps the outer `*...*`
        // literal while `*a **b** c*` pairs, and `*foo**bar**baz*`
        // pairs because the inner opener is not preceded by
        // whitespace). An enclosing opener shorter than this match is
        // blocked outright; one at least as long is restricted: it may
        // only pair with a closer of that same length (so `**...**` is
        // not stolen as em by an inner `*` closer, but it can still
        // close as strong: `**public as *so*other* option html**`).
        if (wordAfter) {
          for (let k = 0; k < oiIdx; k++) {
            const d = tokens[k];
            if (d.t !== 'delim' || !d.canOpen || d.ch !== closer.ch) continue;
            if (d.length < use) d.canOpen = false;
            else d.restricted = true;
          }
        }
        const node = { t: type, children };
        if (wordAfter) node.wordAfter = true;
        const replacement = [];
        if (opener.length > 0) replacement.push(opener);
        replacement.push(node);
        if (closer.length > 0) {
          // A closer with a leftover run normally leaves it outside the
          // node, but when the node is a strong (use 2) and the content
          // holds an inner em/strong whose closer is followed by a word
          // character, the leftover belongs inside (`**a *b*c***` ->
          // `<strong>a <em>b</em>c*</strong>`). For an em outer (use 1)
          // the leftover stays outside (`*a *b*c**` ->
          // `<em>a <em>b</em>c</em>*`).
          const innerWord =
            use === 2 &&
            children.some(
              (c) => (c.t === 'em' || c.t === 'strong') && c.wordAfter,
            );
          if (innerWord) children.push(closer);
          else replacement.push(closer);
        }
        tokens.splice(oiIdx, ciIdx - oiIdx + 1, ...replacement);
        matched = true;
        break;
      }
    }
    if (!matched) return;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// A link or image whose text holds a code span with mismatched
// backtick runs (`` ``b` ``) suppresses emphasis in the text after it
// up to the next code span (a standalone code span, or a link/image
// whose text holds a backtick): marked leaves those delimiters literal
// there, and the first code span after the region "releases" it, so
// emphasis past it pairs normally. The delimiters in the region are
// made unable to open or close.
function markMismatchSuppression(tokens) {
  let l1 = -1;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if ((tok.t === 'link' || tok.t === 'image') && tok.mismatchCode) {
      l1 = i;
      break;
    }
  }
  if (l1 === -1) return;
  // The region runs to the first code span after the first emphasis
  // delimiter past L1: a code span before any delimiter does not end
  // it (a `deno` code span before `_issue table_` does not release
  // the suppression; the `` `` a ` b `` `` span after it does).
  let firstDelim = -1;
  for (let i = l1 + 1; i < tokens.length; i++) {
    if (tokens[i].t === 'delim') {
      firstDelim = i;
      break;
    }
  }
  if (firstDelim === -1) return;
  let l2 = -1;
  for (let i = firstDelim + 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === 'code') {
      l2 = i;
      break;
    }
    if ((tok.t === 'link' || tok.t === 'image') && tok.hasCode) {
      l2 = i;
      break;
    }
  }
  if (l2 === -1) return;
  for (let i = l1 + 1; i < l2; i++) {
    if (tokens[i].t === 'delim') tokens[i].inMismatchRegion = true;
  }
}

// Parse the inline content of a block (paragraph, heading, table cell) and
// render it to HTML.
function inlineToHtml(text, refs) {
  const tokens = tokenizeInline(text, refs);
  processEmphasis(tokens);
  return renderInlineTokens(tokens);
}

// Render one inline token list to HTML.
function renderInlineTokens(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok.t) {
      case 'text':
        out += escapeText(tok.s);
        break;
      case 'code':
        out += '<code>' + escapeCode(tok.s) + '</code>';
        break;
      case 'br':
        out += '<br>';
        break;
      case 'html':
        out += tok.s;
        break;
      case 'autolink':
        out += '<a href="' + escapeAttr(tok.href) + '">' + escapeText(tok.text) + '</a>';
        break;
      case 'link':
        out += '<a href="' + escapeAttr(tok.href) + '"';
        if (tok.title !== null && tok.title !== undefined) {
          out += ' title="' + escapeAttr(tok.title) + '"';
        }
        out += '>' + renderInlineTokens(tok.children) + '</a>';
        break;
      case 'image':
        out += '<img src="' + escapeAttr(tok.src) + '" alt="' + escapeAttr(tok.alt) + '"';
        if (tok.title !== null && tok.title !== undefined) {
          out += ' title="' + escapeAttr(tok.title) + '"';
        }
        out += '>';
        break;
      case 'del':
        out += '<del>' + renderInlineTokens(tok.children) + '</del>';
        break;
      case 'em':
        out += '<em>' + renderInlineTokens(tok.children) + '</em>';
        break;
      case 'strong':
        out += '<strong>' + renderInlineTokens(tok.children) + '</strong>';
        break;
      case 'delim':
        // A delimiter run that never paired up renders literally.
        out += escapeText(tok.ch.repeat(tok.length));
        break;
    }
  }
  return out;
}

// Render a list of block nodes to HTML.
function renderBlocks(children, refs) {
  let out = '';
  for (let i = 0; i < children.length; i++) out += renderBlock(children[i], refs);
  return out;
}

function alignAttr(a) {
  return a ? ' align="' + a + '"' : '';
}

function renderBlock(node, refs) {
  switch (node.type) {
    case 'paragraph':
      return '<p>' + inlineToHtml(node.text, refs) + '</p>\n';
    case 'heading':
      return '<h' + node.level + '>' + inlineToHtml(node.text, refs) + '</h' + node.level + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'code': {
      let code = node.text;
      if (code !== '' && code.charCodeAt(code.length - 1) !== 10) code += '\n';
      return (
        '<pre><code' +
        (node.lang !== '' ? ' class="language-' + escapeAttr(node.lang) + '"' : '') +
        '>' +
        escapeCode(code) +
        '</code></pre>\n'
      );
    }
    case 'html':
      // The block's text already carries its trailing newline when marked
      // keeps one.
      return node.text;
    case 'blockquote':
      return '<blockquote>\n' + renderBlocks(node.children, refs) + '</blockquote>\n';
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      let out = '<' + tag;
      if (node.ordered && node.start !== 1) out += ' start="' + node.start + '"';
      out += '>\n';
      for (let i = 0; i < node.children.length; i++) {
        out += renderItem(node.children[i], node.loose, refs);
      }
      return out + '</' + tag + '>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < node.header.length; i++) {
        out += '<th' + alignAttr(node.aligns[i]) + '>' + inlineToHtml(node.header[i], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length > 0) {
        out += '<tbody>';
        for (let r = 0; r < node.rows.length; r++) {
          const row = node.rows[r];
          out += '<tr>\n';
          for (let i = 0; i < row.length; i++) {
            out += '<td' + alignAttr(node.aligns[i]) + '>' + inlineToHtml(row[i], refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
  }
  return '';
}

// A GFM task-list marker at the start of a paragraph's text: [ ] /
// [x] / [X] followed by a space. Returns { checked, rest } or null.
function matchTaskMarker(text) {
  if (text.length < 4) return null;
  if (text.charCodeAt(0) !== 91) return null; // '['
  const c = text.charCodeAt(1);
  if (c !== 32 && c !== 120 && c !== 88) return null; // ' ', 'x', 'X'
  if (text.charCodeAt(2) !== 93) return null; // ']'
  if (text.charCodeAt(3) !== 32 && text.charCodeAt(3) !== 9) return null;
  return { checked: c !== 32, rest: text.slice(4) };
}

// Render one list item. In a tight list, paragraph children render as
// bare inline content (no <p> wrapper); in a loose list they render as
// normal paragraphs. A task-list marker on the item's first paragraph
// renders as a checkbox input.
function renderItem(item, loose, refs) {
  let inner = '';
  for (let i = 0; i < item.children.length; i++) {
    const child = item.children[i];
    if (i === 0 && child.type === 'paragraph') {
      const task = matchTaskMarker(child.text);
      if (task !== null) {
        const box = task.checked
          ? '<input checked="" disabled="" type="checkbox">'
          : '<input disabled="" type="checkbox">';
        if (!loose) {
          inner += box + ' ' + inlineToHtml(task.rest, refs);
        } else {
          inner += '<p>' + box + ' ' + inlineToHtml(task.rest, refs) + '</p>\n';
        }
        continue;
      }
    }
    if (!loose && child.type === 'paragraph') {
      inner += inlineToHtml(child.text, refs);
    } else {
      inner += renderBlock(child, refs);
    }
  }
  return '<li>' + inner + '</li>\n';
}
