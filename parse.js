// A quick Markdown renderer whose HTML matches marked 18.1.3 (default
// settings: GFM on, hard breaks off) byte for byte, on every input.
// Built from the CommonMark 0.31.2 and GFM 0.29 rules: a line scanner
// builds a block tree, a delimiter-stack scanner turns each text run into
// inline HTML, and a small renderer joins the two. No dependencies, no
// state kept between calls, and the hot paths scan by char code instead
// of running regexes.
//
// Entry point: parse(markdown) -> string, defined at the end of the file.

// ---------------------------------------------------------------------------
// Character classes. Most checks take a char code (a number); the two
// helpers that take a one-character string are only used where a delimiter
// run is being classified, so a regex there costs nothing.
// ---------------------------------------------------------------------------

const UNI_PUNCT = /[\p{P}\p{S}]/u;
const UNI_SPACE = /\s/;

// ASCII whitespace code points: space, tab, LF, VT, FF, CR.
function wsCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
}

function digitCode(c) {
  return c >= 48 && c <= 57;
}

function alphaCode(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function alnumCode(c) {
  return alphaCode(c) || digitCode(c);
}

// ASCII punctuation: !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
function asciiPunctCode(c) {
  return (
    (c >= 33 && c <= 47) ||
    (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) ||
    (c >= 123 && c <= 126)
  );
}

// Unicode punctuation or symbol, for one code point given as a string of
// one or two UTF-16 units.
function uniPunctStr(s) {
  return UNI_PUNCT.test(s);
}

function uniSpaceStr(s) {
  return UNI_SPACE.test(s);
}

// The single code point ending at index i of str (or '' when i is 0),
// and the one starting at index i (or '' at the end). Surrogate pairs
// are kept together.
function pointBefore(str, i) {
  if (i <= 0) return '';
  const c = str.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const d = str.charCodeAt(i - 2);
    if (d >= 0xd800 && d <= 0xdbff) return str.slice(i - 2, i);
  }
  return str[i - 1];
}

function pointAfter(str, i) {
  if (i >= str.length) return '';
  const c = str.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
    const d = str.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return str.slice(i, i + 2);
  }
  return str[i];
}

// ---------------------------------------------------------------------------
// Entities and escaping.
//
// Text is emitted by decoding numeric character references, then escaping
// & < > " ' — except an & that starts a valid-looking entity reference
// (&name; or &#digits; or &#xhex;) is left alone. Named entities pass
// through untouched, numeric references decode (invalid ones become
// U+FFFD), and a decoded & is re-escaped.
// ---------------------------------------------------------------------------

// Decode the numeric reference starting at s[i] ('&' + '#' ... ';').
// Returns [decodedChar, indexJustPastSemicolon] or null when s[i] does
// not start a well-formed numeric reference.
function numericRefAt(s, i) {
  // s[i] is '&', s[i+1] must be '#'.
  let j = i + 2;
  let hex = false;
  if (j < s.length && (s[j] === 'x' || s[j] === 'X')) {
    hex = true;
    j++;
  }
  const start = j;
  let value = 0;
  let over = false;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    let d = -1;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (hex && c >= 97 && c <= 102) d = c - 87;
    else if (hex && c >= 65 && c <= 70) d = c - 55;
    else break;
    value = value * (hex ? 16 : 10) + d;
    if (value > 0x10ffff) over = true;
    j++;
  }
  const digits = j - start;
  if (digits < 1 || digits > (hex ? 6 : 7)) return null;
  if (j >= s.length || s[j] !== ';') return null;
  if (over || value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return ['\uFFFD', j + 1];
  }
  return [String.fromCodePoint(value), j + 1];
}

// Does s starting at i look like a valid entity reference (&name;,
// &#digits;, &#xhex;)? Used to decide whether a literal & stays
// unescaped. A numeric reference that is well-formed but decodes to an
// invalid code point still counts as an entity here (it will be decoded
// by numericRefAt in the text path).
function entityLooksValid(s, i) {
  let j = i + 1;
  if (j < s.length && s[j] === '#') {
    j++;
    let hex = false;
    if (j < s.length && (s[j] === 'x' || s[j] === 'X')) {
      hex = true;
      j++;
    }
    let digits = 0;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      const ok = hex
        ? (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)
        : c >= 48 && c <= 57;
      if (!ok) break;
      j++;
      digits++;
    }
    return digits >= 1 && digits <= (hex ? 6 : 7) && j < s.length && s[j] === ';';
  }
  let letters = 0;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (alnumCode(c)) {
      j++;
      letters++;
    } else break;
  }
  return letters >= 1 && j < s.length && s[j] === ';';
}

// Escape a text run: decode numeric refs, escape & < > " ' (with the
// entity lookahead for &). Appends to `out` (an array of strings).
function pushEscaped(out, s) {
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      // '&'
      if (i + 1 < n && s[i + 1] === '#') {
        const dec = numericRefAt(s, i);
        if (dec !== null) {
          if (start < i) out.push(s.slice(start, i));
          const ch = dec[0];
          if (ch === '&') out.push('&amp;');
          else if (ch === '<') out.push('&lt;');
          else if (ch === '>') out.push('&gt;');
          else if (ch === '"') out.push('&quot;');
          else if (ch === "'") out.push('&#39;');
          else out.push(ch);
          i = dec[1];
          start = i;
          continue;
        }
      }
      if (entityLooksValid(s, i)) {
        i++;
        continue;
      }
      if (start < i) out.push(s.slice(start, i));
      out.push('&amp;');
      i++;
      start = i;
    } else if (c === 60) {
      if (start < i) out.push(s.slice(start, i));
      out.push('&lt;');
      i++;
      start = i;
    } else if (c === 62) {
      if (start < i) out.push(s.slice(start, i));
      out.push('&gt;');
      i++;
      start = i;
    } else if (c === 34) {
      if (start < i) out.push(s.slice(start, i));
      out.push('&quot;');
      i++;
      start = i;
    } else if (c === 39) {
      if (start < i) out.push(s.slice(start, i));
      out.push('&#39;');
      i++;
      start = i;
    } else {
      i++;
    }
  }
  if (start < n) out.push(s.slice(start));
}

// Escape with every & encoded (used for code spans, code blocks, and
// link-title text after its own processing).
function pushEscapedStrict(out, s) {
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      if (start < i) out.push(s.slice(start, i));
      out.push('&amp;');
      i++;
      start = i;
    } else if (c === 60) {
      if (start < i) out.push(s.slice(start, i));
      out.push('&lt;');
      i++;
      start = i;
    } else if (c === 62) {
      if (start < i) out.push(s.slice(start, i));
      out.push('&gt;');
      i++;
      start = i;
    } else if (c === 34) {
      if (start < i) out.push(s.slice(start, i));
      out.push('&quot;');
      i++;
      start = i;
    } else if (c === 39) {
      if (start < i) out.push(s.slice(start, i));
      out.push('&#39;');
      i++;
      start = i;
    } else {
      i++;
    }
  }
  if (start < n) out.push(s.slice(start));
}

// Remove backslash escapes of ASCII punctuation (used in link
// destinations and titles). A backslash before anything else stays.
function unescapeSlashes(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && asciiPunctCode(s.charCodeAt(i + 1))) {
      out += s.slice(start, i) + s[i + 1];
      i++;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// A link destination: unescape backslashes, then encodeURI with %25 -> %.
// Returns null when encodeURI throws (lone surrogates).
function hrefEncode(raw) {
  const clean = unescapeSlashes(raw);
  try {
    return encodeURI(clean).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// An autolink destination: encodeURI straight, no backslash unescaping
// (a `\*` in an autolink href becomes `%5C*`, not `*`).
function hrefEncodeRaw(raw) {
  try {
    return encodeURI(raw).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Normalize a link label: trim, collapse internal whitespace to one
// space, case-fold like marked (lower, upper, lower). Backslash escapes
// are NOT removed: a label `foo\!` does not match a definition `foo!`.
function labelFold(label) {
  return label
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Line indentation helpers (tabs advance to the next multiple of 4 columns).
// ---------------------------------------------------------------------------

// Number of columns of leading whitespace of `line` (tabs expand to 4),
// with the line starting at absolute column `col0`.
function indentCols(line, col0) {
  let col = col0;
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      col += 4 - (col % 4);
      i++;
    } else break;
  }
  return col - col0;
}

// Is the line blank (only spaces/tabs)?
function blankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Remove `cols` columns of leading whitespace from `line`. When a tab
// straddles the boundary, the remainder becomes spaces. Returns null when
// the line has fewer than `cols` columns of leading whitespace. Tab widths
// are measured from absolute column `col0`.
function cutCols(line, cols, col0) {
  let col = col0;
  let i = 0;
  while (i < line.length && col - col0 < cols) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      const next = col + (4 - (col % 4));
      if (next - col0 > cols) {
        return ' '.repeat(next - (col0 + cols)) + line.slice(i + 1);
      }
      col = next;
      i++;
    } else {
      return null;
    }
  }
  if (col - col0 < cols) return null;
  return line.slice(i);
}

// Remove up to `cols` columns of leading whitespace from `line`. Unlike
// cutCols, a line with less leading whitespace than `cols` has all of it
// removed instead of returning null (fenced-code content lines are
// stripped by at most the fence's indent). A tab that starts before the
// strip boundary is removed entirely (its remainder is discarded, not
// kept as spaces). A leading tab that remains is expanded to spaces at
// its absolute column only when the line sits inside a container
// (col0 > 0); at the top level a literal tab stays literal.
function cutColsUpTo(line, cols, col0) {
  let col = col0;
  let i = 0;
  while (i < line.length && col - col0 < cols) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      const next = col + (4 - (col % 4));
      if (next - col0 > cols) {
        // Tab straddles the boundary: drop it entirely.
        return line.slice(i + 1);
      }
      col = next;
      i++;
    } else {
      break;
    }
  }
  let rest = line.slice(i);
  if (rest.charCodeAt(0) === 9 && col0 > 0) {
    const w = 4 - (col % 4);
    rest = ' '.repeat(w) + rest.slice(1);
  }
  return rest;
}

// The leading whitespace (spaces/tabs) of a line, as a string.
function leadWs(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  return line.slice(0, i);
}

// ---------------------------------------------------------------------------
// Block starters. Each matcher looks at the text after the containers
// already matched (leading whitespace included) and reports whether a
// block of its kind starts here.
// ---------------------------------------------------------------------------

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|' +
  'colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|' +
  'footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|' +
  'legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|' +
  'param|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK_TAG_SET = new Set(BLOCK_TAGS.split('|'));

// Match a blockquote marker at the start of `line` (0-3 spaces, then
// `>`, then one column of following whitespace). Returns { rest, cols }
// (cols = columns consumed from the line start) or null. A following tab
// gives up one column of its expansion; the remainder becomes spaces.
function quoteAt(line, col0) {
  const sc = scanIndent(line, col0);
  let col = sc.col;
  let i = sc.i;
  if (i >= line.length || line.charCodeAt(i) !== 62) return null;
  i++;
  col++;
  // The whitespace after `>` expands relative to the marker (marked's
  // blockquote expands it starting at the marker's own length: leading
  // spaces plus `>`), then one space is consumed as the marker's
  // separator. Expanding it here — instead of leaving a tab for a
  // later absolute-column expansion — keeps nested quotes (inside a
  // list item, where the absolute column and the marker column differ)
  // exact. The returned column keeps the following text at its
  // absolute column.
  const markerLen = sc.col - col0 + 1;
  let j = i;
  let rel = markerLen;
  let expanded = '';
  let abs = col;
  while (j < line.length) {
    const ch = line.charCodeAt(j);
    if (ch === 32) {
      expanded += ' ';
      rel++;
      abs++;
      j++;
    } else if (ch === 9) {
      const w = 4 - (rel % 4);
      expanded += ' '.repeat(w);
      rel += w;
      abs += 4 - (abs % 4);
      j++;
    } else break;
  }
  if (expanded.length === 0) {
    return { rest: line.slice(i), cols: col - col0 };
  }
  const restSpaces = expanded.length - 1;
  const colNew = abs - restSpaces;
  return { rest: ' '.repeat(restSpaces) + line.slice(j), cols: colNew - col0 };
}

// Is `rest` a setext underline (0-3 spaces, then =+ or -+, then spaces)?
// Returns 1 for `=`, 2 for `-`, 0 otherwise.
function setextAt(rest, col0) {
  let i = scanIndent(rest, col0).i;
  if (i >= rest.length) return 0;
  const mark = rest.charCodeAt(i);
  if (mark !== 61 && mark !== 45) return 0;
  let j = i;
  while (j < rest.length && rest.charCodeAt(j) === mark) j++;
  while (j < rest.length) {
    const c = rest.charCodeAt(j);
    if (c !== 32 && c !== 9) return 0;
    j++;
  }
  return mark === 61 ? 1 : 2;
}

// Is `rest` a thematic break (0-3 spaces, then 3+ of -, _, or *,
// separated by spaces/tabs only)?
function ruleAt(rest, col0) {
  let i = scanIndent(rest, col0).i;
  if (i >= rest.length) return false;
  const mark = rest.charCodeAt(i);
  if (mark !== 45 && mark !== 95 && mark !== 42) return false;
  let count = 0;
  while (i < rest.length) {
    const c = rest.charCodeAt(i);
    if (c === mark) {
      count++;
      i++;
    } else if (c === 32 || c === 9) {
      i++;
    } else return false;
  }
  return count >= 3;
}

// Split a table row into cells (unescaped pipes), trimmed. A leading
// pipe makes the first segment empty (dropped) and a trailing pipe the
// last one (dropped).
function splitRow(row) {
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < row.length) {
    const c = row.charCodeAt(i);
    if (c === 92 && i + 1 < row.length) {
      // An escaped pipe is a literal pipe in the cell (it must not
      // split the row); any other escape keeps its backslash for the
      // inline parser.
      if (row.charCodeAt(i + 1) === 124) {
        cur += '|';
      } else {
        cur += row[i] + row[i + 1];
      }
      i += 2;
    } else if (c === 124) {
      cells.push(cur);
      cur = '';
      i++;
    } else {
      cur += row[i];
      i++;
    }
  }
  cells.push(cur);
  // Drop the empty first cell when the row starts with a pipe, and the
  // empty last cell when it ends with one (pipes already unescaped above
  // are not separators, so a trailing "\|" stays in the last cell).
  let start = 0;
  let end = cells.length;
  const trimmedRow = row.trim();
  if (trimmedRow.startsWith('|')) start = 1;
  if (trimmedRow.endsWith('|') && !trimmedRow.endsWith('\\|')) end--;
  const out = [];
  for (let k = start; k < end; k++) out.push(cells[k].trim());
  return out;
}

// Alignments of a table delimiter row, or null when `rest` is not one.
// A delimiter row is 0-3 spaces, then cells of dashes with optional
// colons, separated by pipes; it must contain a | or a :. Each cell is
// `:---`, `---:`, `:---:` or `---` (one or more dashes).
function rowAligns(rest, col0) {
  let i = scanIndent(rest, col0).i;
  const body = rest.slice(i).trim();
  if (body.length === 0) return null;
  let hasPipe = false;
  let hasColon = false;
  for (let k = 0; k < body.length; k++) {
    const c = body.charCodeAt(k);
    if (c === 124) hasPipe = true;
    else if (c === 58) hasColon = true;
  }
  if (!hasPipe && !hasColon) return null;
  const cells = splitRow(body);
  const aligns = [];
  for (const cell of cells) {
    let left = false;
    let right = false;
    let k = 0;
    if (cell.charCodeAt(0) === 58) {
      left = true;
      k = 1;
    }
    let dashes = 0;
    while (k < cell.length && cell.charCodeAt(k) === 45) {
      k++;
      dashes++;
    }
    if (dashes < 1) return null;
    if (k < cell.length && cell.charCodeAt(k) === 58) {
      right = true;
      k++;
    }
    if (k !== cell.length) return null;
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

// Is `rest` a table delimiter row?
function tableDelimAt(rest, col0) {
  return rowAligns(rest, col0) !== null;
}

// ATX heading: 0-3 spaces, 1-6 #, then a space/tab/EOL. Returns
// { level, text } with the closing sequence of #'s stripped, or null.
function atxAt(rest, col0) {
  let i = scanIndent(rest, col0).i;
  let hashes = 0;
  while (i + hashes < rest.length && rest.charCodeAt(i + hashes) === 35) hashes++;
  if (hashes < 1 || hashes > 6) return null;
  let j = i + hashes;
  if (j < rest.length) {
    const c = rest.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  let text = rest.slice(j);
  // Strip a closing sequence: trailing #'s preceded by space/tab.
  let end = text.length;
  while (end > 0) {
    const c = text.charCodeAt(end - 1);
    if (c === 32 || c === 9) end--;
    else break;
  }
  let h = end;
  while (h > 0 && text.charCodeAt(h - 1) === 35) h--;
  if (h < end && (h === 0 || text.charCodeAt(h - 1) === 32 || text.charCodeAt(h - 1) === 9)) {
    end = h;
    while (end > 0) {
      const c = text.charCodeAt(end - 1);
      if (c === 32 || c === 9) end--;
      else break;
    }
  }
  return { level: hashes, text: text.slice(0, end) };
}

// Fenced code opening: 0-3 spaces, then 3+ backticks or tildes. The info
// string of a backtick fence must not contain a backtick. Returns
// { ch, len, info } or null.
function fenceAt(rest, col0) {
  let i = scanIndent(rest, col0).i;
  if (i >= rest.length) return null;
  const ch = rest.charCodeAt(i);
  if (ch !== 96 && ch !== 126) return null;
  let len = 0;
  while (i + len < rest.length && rest.charCodeAt(i + len) === ch) len++;
  if (len < 3) return null;
  const info = rest.slice(i + len).trim();
  if (ch === 96 && info.indexOf('`') !== -1) return null;
  return { ch: String.fromCharCode(ch), len, info };
}

// A list marker at the start of `rest` (0-3 spaces, then a bullet or an
// ordered marker). Returns marker info, or null. `contentCols` is the
// column (from the line start) where the item's content begins;
// `after` is the string index there, and `pad` is a string of spaces to
// prepend when a tab straddled the content boundary.
function listAt(rest, col0) {
  const sc = scanIndent(rest, col0);
  let i = sc.i;
  let col = sc.col;
  if (i >= rest.length) return null;
  const c0 = rest.charCodeAt(i);
  let ordered = false;
  let start = null;
  let delim = null;
  let bullet = null;
  let markEnd = i;
  if (c0 === 45 || c0 === 43 || c0 === 42) {
    bullet = String.fromCharCode(c0);
    markEnd = i + 1;
  } else if (digitCode(c0)) {
    let j = i;
    let num = 0;
    while (j < rest.length && digitCode(rest.charCodeAt(j)) && j - i < 9) {
      num = num * 10 + (rest.charCodeAt(j) - 48);
      j++;
    }
    if (j >= rest.length || (rest.charCodeAt(j) !== 46 && rest.charCodeAt(j) !== 41)) return null;
    if (j - i > 9) return null;
    ordered = true;
    start = num;
    delim = String.fromCharCode(rest.charCodeAt(j));
    markEnd = j + 1;
  } else {
    return null;
  }
  const markEndCol = col + (markEnd - i);
  const markCols = markEndCol - col0;
  // Whitespace after the marker.
  let j = markEnd;
  let wcol = markEndCol;
  while (j < rest.length) {
    const c = rest.charCodeAt(j);
    if (c === 32) {
      wcol++;
      j++;
    } else if (c === 9) {
      wcol += 4 - (wcol % 4);
      j++;
    } else break;
  }
  const wsCols = wcol - markEndCol;
  if (j >= rest.length) {
    // Empty item: content starts one column past the marker.
    return { ordered, start, delim, bullet, empty: true, contentCols: markCols + 1, after: j, pad: '' };
  }
  if (wsCols === 0) return null;
  if (wsCols >= 5) {
    // Content starts one column past the marker; the rest of the
    // whitespace run is content (a straddling tab leaves spaces).
    let k = markEnd;
    let cc = markEndCol;
    let pad = '';
    if (rest.charCodeAt(k) === 9) {
      const w = 4 - (cc % 4);
      pad = ' '.repeat(w - 1);
      k++;
    } else {
      k++;
    }
    return { ordered, start, delim, bullet, empty: false, contentCols: markCols + 1, after: k, pad };
  }
  return { ordered, start, delim, bullet, empty: false, contentCols: markCols + wsCols, after: j, pad: '' };
}

// Can this list marker interrupt a paragraph (non-lazy case)? The first
// item must be non-empty, and an ordered list must start with the
// literal 1.
function listBreaksPara(m, inItem) {
  // An ordered list interrupts a paragraph only when it starts at 1 —
  // unless the paragraph sits inside a list item, where a nested list
  // may start at any number.
  return !m.empty && (!m.ordered || m.start === 1 || inItem);
}

// Does `rest` start an HTML block? Returns the type (1-7) or 0.
function htmlKindAt(rest, col0) {
  let i = scanIndent(rest, col0).i;
  if (i >= rest.length || rest.charCodeAt(i) !== 60) return 0;
  const tail = rest.slice(i);
  const low = tail.toLowerCase();
  // Type 1: <script, <pre, <style, <textarea (followed by space, tab,
  // newline, > or end of line).
  for (const tag of ['script', 'pre', 'style', 'textarea']) {
    if (low.startsWith('<' + tag)) {
      const after = low[1 + tag.length];
      if (after === undefined || after === ' ' || after === '\t' || after === '>' || after === '\n') return 1;
    }
  }
  if (low.startsWith('<!--')) return 2;
  if (low.startsWith('<?')) return 3;
  if (low.startsWith('<!')) {
    const c = tail.charCodeAt(2);
    if (c !== undefined && alphaCode(c)) return 4;
  }
  if (low.startsWith('<![cdata[')) return 5;
  // Type 6: <tag or </tag where tag is a block tag name, followed by
  // space, tab, newline, > or end of line. A closing tag takes no
  // attributes (only whitespace then `>`).
  let m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(tail);
  if (m !== null && BLOCK_TAG_SET.has(m[2].toLowerCase())) {
    const rest = tail.slice(m[0].length);
    if (m[1] === '/') {
      if (/^[ \t]*>/.test(rest) || rest === '' || rest === '\n') return 6;
    } else {
      const after = rest[0];
      if (after === undefined || after === ' ' || after === '\t' || after === '>' || after === '\n') return 6;
    }
  }
  // Type 7: a complete open or close tag, and nothing else on the line.
  m = /^(?:<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>)/.exec(tail);
  if (m !== null) {
    const after = tail.slice(m[0].length);
    if (/^[\s]*$/.test(after)) return 7;
  }
  return 0;
}

// Is `line` a whitespace-only line of 0-3 spaces followed by exactly
// one tab? Marked treats such a line as an empty table body row; any
// other blank line ends a table.
function tableTabRow(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32 && i < 3) i++;
  return i < line.length && line.charCodeAt(i) === 9 && i + 1 === line.length;
}

// ---------------------------------------------------------------------------
// Link reference definitions. A paragraph's leading lines may be
// definitions: [label]: destination "optional title". They are stripped
// from the paragraph and registered in `refs` (first definition of a
// label wins). The destination and the title may each sit on the
// following line; a title may span lines.
// ---------------------------------------------------------------------------

// Skip up to 3 columns of indent (spaces/tabs by column) at s[i].
// Returns the new index, or -1 when the indent runs past 3 columns.
function skipIndent3(s, i) {
  let col = 0;
  let j = i;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 32) {
      col++;
      j++;
    } else if (c === 9) {
      col += 4 - (col % 4);
      j++;
    } else break;
    if (col > 3) return -1;
  }
  return j;
}

// Parse a title starting at lines[li][k] (opener is ", ' or (). The title
// may run across lines. Returns { title, nextLine, nextCol } (nextCol is
// the index just past the closer on lines[nextLine]) or null.
function titleAt(lines, li, k) {
  const first = lines[li];
  if (k >= first.length) return null;
  const open = first.charCodeAt(k);
  let close;
  if (open === 34) close = 34;
  else if (open === 39) close = 39;
  else if (open === 40) close = 41;
  else return null;
  let depth = 0;
  let content = '';
  let line = li;
  let j = k + 1;
  while (line < lines.length) {
    const s = lines[line];
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 92 && j + 1 < s.length) {
        content += s[j] + s[j + 1];
        j += 2;
        continue;
      }
      if (open === 40 && c === 40) {
        depth++;
        content += s[j];
        j++;
        continue;
      }
      if (c === close) {
        if (open === 40 && depth > 0) {
          depth--;
          content += s[j];
          j++;
          continue;
        }
        return { title: content, nextLine: line, nextCol: j + 1 };
      }
      content += s[j];
      j++;
    }
    // End of line without a closer: the title continues on the next line.
    line++;
    if (line < lines.length) content += '\n';
    j = 0;
  }
  return null;
}

// Try to parse one link reference definition starting at lines[i].
// Returns { label, href, title, next } (next = index of the first line
// after the definition) or null.
function defAt(lines, i) {
  const line0 = lines[i];
  let j = skipIndent3(line0, 0);
  if (j === -1 || j >= line0.length || line0.charCodeAt(j) !== 91) return null;
  // The label: no unescaped brackets inside (a label may not contain
  // `[` or `]`); it may span lines (a newline inside folds to a space
  // when the label is folded).
  let labLine = i;
  let k = j + 1;
  let label = '';
  let closeLine = -1;
  let closeCol = -1;
  outer: while (labLine < lines.length) {
    const s = lines[labLine];
    while (k < s.length) {
      const c = s.charCodeAt(k);
      if (c === 92 && k + 1 < s.length) {
        label += s[k] + s[k + 1];
        k += 2;
        continue;
      }
      if (c === 91) return null;
      if (c === 93) {
        closeLine = labLine;
        closeCol = k;
        break outer;
      }
      label += s[k];
      k++;
    }
    // End of line without a close: the label continues on the next line.
    labLine++;
    if (labLine < lines.length) label += '\n';
    k = 0;
  }
  if (closeLine === -1) return null;
  if (label.length === 0 || label.length > 999) return null;
  if (labelFold(label) === '') return null;
  // The colon must immediately follow the closing bracket.
  const closeText = lines[closeLine];
  if (closeCol + 1 >= closeText.length || closeText.charCodeAt(closeCol + 1) !== 58) return null;
  // After the colon: spaces/tabs, then the destination (same line, or
  // the next line when this one ends here).
  let li = closeLine;
  let p = closeCol + 2;
  const skipWs = () => {
    while (p < lines[li].length) {
      const c = lines[li].charCodeAt(p);
      if (c === 32 || c === 9) p++;
      else break;
    }
  };
  skipWs();
  if (p >= lines[li].length) {
    li++;
    if (li >= lines.length) return null;
    // The destination may sit on the next line, indented any amount.
    p = 0;
    while (p < lines[li].length) {
      const c = lines[li].charCodeAt(p);
      if (c === 32 || c === 9) p++;
      else break;
    }
    if (p >= lines[li].length) return null;
  }
  const destLine = lines[li];
  let href;
  if (p < destLine.length && destLine.charCodeAt(p) === 60) {
    // Angle destination: no newline, no unescaped < or > inside.
    let q = p + 1;
    let ok = false;
    while (q < destLine.length) {
      const c = destLine.charCodeAt(q);
      if (c === 92 && q + 1 < destLine.length) {
        q += 2;
        continue;
      }
      if (c === 60) return null;
      if (c === 62) {
        ok = true;
        break;
      }
      q++;
    }
    if (!ok) return null;
    href = destLine.slice(p + 1, q);
    p = q + 1;
  } else {
    // Bare destination: no spaces or control characters, parentheses
    // balanced (an unmatched ) ends it, an unmatched ( fails it).
    let q = p;
    let pdepth = 0;
    while (q < destLine.length) {
      const c = destLine.charCodeAt(q);
      if (c === 32 || c === 9 || c < 32) break;
      if (c === 92 && q + 1 < destLine.length) {
        q += 2;
        continue;
      }
      if (c === 40) pdepth++;
      else if (c === 41) {
        if (pdepth === 0) break;
        pdepth--;
      }
      q++;
    }
    if (q === p) return null;
    if (pdepth > 0) return null;
    href = destLine.slice(p, q);
    p = q;
  }
  // Optional title: same line, or the next line. A same-line title must
  // be separated from the destination by whitespace.
  let title = null;
  let endLine = li;
  let endCol = p;
  const restBlank = (ln, from) => {
    for (let t = from; t < lines[ln].length; t++) {
      const c = lines[ln].charCodeAt(t);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  };
  // Skip whitespace after the destination on its line.
  const destEnd = endCol;
  while (endCol < lines[endLine].length) {
    const c = lines[endLine].charCodeAt(endCol);
    if (c === 32 || c === 9) endCol++;
    else break;
  }
  if (endCol < lines[endLine].length) {
    if (endCol === destEnd) return null;
    const t = titleAt(lines, endLine, endCol);
    if (t === null) return null;
    if (!restBlank(t.nextLine, t.nextCol)) return null;
    title = t.title;
    endLine = t.nextLine;
  } else {
    // Look for a title on the next line. If the title does not parse
    // cleanly there, the definition still stands without a title.
    const nl = endLine + 1;
    if (nl < lines.length) {
      let q = 0;
      while (q < lines[nl].length) {
        const c = lines[nl].charCodeAt(q);
        if (c === 32 || c === 9) q++;
        else break;
      }
      if (q < lines[nl].length) {
        const c = lines[nl].charCodeAt(q);
        if (c === 34 || c === 39 || c === 40) {
          const t = titleAt(lines, nl, q);
          if (t !== null && restBlank(t.nextLine, t.nextCol)) {
            title = t.title;
            endLine = t.nextLine;
          }
        }
      }
    }
  }
  return { label: labelFold(label), href, title, next: endLine + 1 };
}

// Does a paragraph line end in a hard break (two or more trailing
// spaces, or a trailing backslash that is not itself escaped)? A tab
// before the newline does not count.
function hardBreakEnd(line) {
  if (line.length === 0) return false;
  if (line.charCodeAt(line.length - 1) === 92) {
    let n = 0;
    for (let q = line.length - 1; q >= 0 && line.charCodeAt(q) === 92; q--) n++;
    return n % 2 === 1;
  }
  let n = 0;
  for (let q = line.length - 1; q >= 0 && line.charCodeAt(q) === 32; q--) n++;
  return n >= 2;
}

// Join a paragraph's lines with '\n', stripping the leading whitespace
// of a line that follows a hard break. A soft break keeps the next
// line's indent.
function joinParaLines(lines) {
  let out = '';
  for (let k = 0; k < lines.length; k++) {
    let line = lines[k];
    if (k > 0 && hardBreakEnd(lines[k - 1])) {
      line = line.replace(/^[ \t]+/, '');
    }
    if (k > 0) out += '\n';
    out += line;
  }
  return out;
}

// Strip leading link reference definitions from a paragraph's text
// (lines joined by '\n'), registering them in `refs`. Returns the
// remaining text. Idempotent: the first definition of a label wins.
function readDefs(text, refs) {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const d = defAt(lines, i);
    if (d === null) break;
    if (!refs.has(d.label)) refs.set(d.label, { href: d.href, title: d.title });
    i = d.next;
  }
  return lines.slice(i).join('\n');
}

// Index and column just past up to 3 columns of leading whitespace in
// `rest`, where the text starts at absolute column `col0`. A tab that
// would carry the indent past 3 columns stops the scan (the tab itself
// is left for the caller to reject).
function scanIndent(rest, col0) {
  let col = col0;
  let i = 0;
  while (i < rest.length && col - col0 < 3) {
    const c = rest.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      const next = col + (4 - (col % 4));
      if (next - col0 > 3) break;
      col = next;
      i++;
    } else break;
  }
  return { i, col };
}

// ---------------------------------------------------------------------------
// Block tree builder. Walks the input lines once, maintaining a stack of
// open blocks (root, then containers, then at most one open leaf), and
// returns the root node. Link reference definitions are collected as
// paragraphs are finalized, so they are visible document-wide.
// ---------------------------------------------------------------------------

// Does `s` start a block that can interrupt a paragraph?
function interruptsPara(s, col, inItem) {
  if (atxAt(s, col) !== null) return true;
  if (fenceAt(s, col) !== null) return true;
  if (ruleAt(s, col)) return true;
  if (quoteAt(s, col) !== null) return true;
  const k = htmlKindAt(s, col);
  if (k >= 1 && k <= 6) return true;
  const m = listAt(s, col);
  if (m !== null && listBreaksPara(m, inItem)) return true;
  return false;
}

// Does `s` start any new block (used to end a table)?
function startsBlock(s, col) {
  if (atxAt(s, col) !== null) return true;
  if (fenceAt(s, col) !== null) return true;
  if (ruleAt(s, col)) return true;
  if (quoteAt(s, col) !== null) return true;
  if (htmlKindAt(s, col) !== 0) return true;
  if (listAt(s, col) !== null) return true;
  if (indentCols(s, col) >= 4) return true;
  return false;
}

function buildBlocks(lines, refs) {
  const root = { t: 'doc', kids: [] };
  const stack = [root];

  const tip = () => stack[stack.length - 1];

  // Finalize a leaf node being closed. A definition-only paragraph is
  // removed from its parent.
  function finalize(node) {
    if (node.t === 'para') {
      const rest = readDefs(joinParaLines(node.lines), refs);
      if (rest === '') {
        const parent = tip();
        if (parent.kids[parent.kids.length - 1] === node) parent.kids.pop();
        return;
      }
      node.text = rest;
      // GFM task list: the first paragraph of a list item starting
      // with `[ ]` / `[x]` / `[X]` + space + text renders a checkbox.
      const parent = tip();
      if (parent.t === 'item' && parent.kids[0] === node) {
        const m = /^\[([ xX])\] +/.exec(node.text);
        if (m && node.text.length > m[0].length) {
          node.task = m[1] === ' ' ? false : true;
          node.text = node.text.slice(m[0].length);
        }
      }
      delete node.lines;
    } else if (node.t === 'code') {
      let end = node.lines.length;
      if (node.fenced) {
        // A fenced block drops exactly one trailing blank line (the
        // line just before the closing fence); the rest are content.
        if (end > 0 && node.lines[end - 1] === '') end--;
      } else {
        while (end > 0 && node.lines[end - 1] === '') end--;
      }
      const body = node.lines.slice(0, end).join('\n');
      // One empty line still contributes its newline: `[''].join`
      // is `''`, so the test must be on the line count, not the body.
      node.text = end === 0 ? '' : body + '\n';
      delete node.lines;
    } else if (node.t === 'html') {
      const body = node.lines.join('\n');
      // Kinds 1-5 keep a trailing newline unless a blank line ended
      // them; kinds 6-7 keep one only at end of input.
      const keep = node.kind <= 5 ? !node.noTrail : !!node.eofTrail;
      node.text = body === '' || !keep ? body : body + '\n';
      delete node.lines;
    } else if (node.t === 'table') {
      const w = node.head.length;
      for (const row of node.rows) {
        while (row.length < w) row.push('');
        if (row.length > w) row.length = w;
      }
    }
  }

  // Pop frames until the stack has `depth` entries, finalizing leaves.
  function closeTo(depth) {
    while (stack.length > depth) finalize(stack.pop());
  }

  // A blank line was seen inside every open container: remember it on
  // each open list (it may make the list loose).
  function noteBlank() {
    // A blank line inside a nested block container (a quote, or a code
    // or HTML block) only separates blocks inside that container: it
    // does not loosen the lists holding the container. Only a blank
    // line at item/list level marks the lists.
    const t = tip();
    if (t.t !== 'item' && t.t !== 'list' && t.t !== 'doc') return;
    for (let k = 1; k < stack.length; k++) {
      if (stack[k].t === 'list') stack[k].pendBlank = true;
    }
  }

  // A new block is about to start inside the open containers. A list
  // becomes loose when a blank line separated two of its blocks: that is
  // when it already has content, or when a second item is starting.
  function loosen(isNewItem) {
    // Only the deepest list with a pending blank can go loose: a blank
    // line nested inside one item must not loosen the outer lists.
    let deepest = -1;
    for (let k = 1; k < stack.length; k++) {
      if (stack[k].t === 'list' && stack[k].pendBlank) deepest = k;
    }
    for (let k = 1; k < stack.length; k++) {
      const fr = stack[k];
      if (fr.t !== 'list' || !fr.pendBlank) continue;
      if (k === deepest && (fr.hasContent || (isNewItem && fr.kids.length > 0))) fr.tight = false;
      fr.pendBlank = false;
    }
  }

  // The open containers just gained a block: record content on them.
  function noteContent() {
    for (let k = 1; k < stack.length; k++) {
      if (stack[k].t === 'list') stack[k].hasContent = true;
    }
  }

  // The closing string an HTML block of this kind ends at (null for
  // kinds 6 and 7, which end at a blank line).
  function htmlEnd(kind, s, col) {
    if (kind === 2) return '-->';
    if (kind === 3) return '?>';
    if (kind === 4) return '>';
    if (kind === 5) return ']]>';
    if (kind === 1) {
      const low = s.toLowerCase();
      for (const tag of ['script', 'pre', 'style', 'textarea']) {
        if (low.indexOf('<' + tag) !== -1) return '</' + tag + '>';
      }
      return '</script>';
    }
    return null;
  }

  // Start new blocks at text `s` (column `col`), with the current tip a
  // container. Loops when a list item is created so the item's
  // first-line content is parsed as blocks inside it.
  function startBlocks(s, col) {
    let cur = s;
    let ccol = col;
    for (;;) {
      if (blankLine(cur)) return;
      // Thematic break beats a list item on the same line (`- - -` is
      // an hr, not a nested list).
      if (ruleAt(cur, ccol)) {
        if (tip().t === 'list') closeTo(stack.length - 1);
        loosen(false);
        tip().kids.push({ t: 'hr' });
        noteContent();
        return;
      }
      // A list at the tip stays open only for a same-kind item; any
      // other block closes it first.
      const m0 = listAt(cur, ccol);
      if (m0 !== null) {
        const top = tip();
        const same =
          top.t === 'list' &&
          top.ordered === m0.ordered &&
          (m0.ordered ? top.delim === m0.delim : top.bullet === m0.bullet);
        if (!same) {
          // A new list kind starts: close the old list FIRST so a
          // blank line between the two lists cannot loosen the old
          // one (it separates lists, not items within a list).
          if (top.t === 'list') closeTo(stack.length - 1);
          const list = {
            t: 'list',
            ordered: m0.ordered,
            start: m0.ordered ? m0.start : null,
            delim: m0.delim,
            bullet: m0.bullet,
            tight: true,
            pendBlank: false,
            hasContent: false,
            kids: [],
          };
          tip().kids.push(list);
          stack.push(list);
        }
        loosen(true);
        const list = tip();
        const item = { t: 'item', contentCol: m0.contentCols, kids: [] };
        list.kids.push(item);
        stack.push(item);
        noteContent();
        cur = m0.pad + cur.slice(m0.after);
        ccol = ccol + m0.contentCols;
        if (blankLine(cur)) return;
        continue;
      }
      if (tip().t === 'list') closeTo(stack.length - 1);
      loosen(false);
      // Blockquote: open a quote container and parse its rest inside.
      const q = quoteAt(cur, ccol);
      if (q !== null) {
        const quote = { t: 'quote', kids: [] };
        tip().kids.push(quote);
        stack.push(quote);
        noteContent();
        cur = q.rest;
        ccol = ccol + q.cols;
        if (blankLine(cur)) return;
        continue;
      }
      // ATX heading.
      const atx = atxAt(cur, ccol);
      if (atx !== null) {
        tip().kids.push({ t: 'head', level: atx.level, text: atx.text.trim() });
        noteContent();
        return;
      }
      // Fenced code. Marked strips the opening fence's indent from
      // content lines only for backtick fences (its compensation
      // regex matches whitespace before ```); a tilde fence keeps
      // the content's full indent.
      const f = fenceAt(cur, ccol);
      if (f !== null) {
        const node = { t: 'code', fenced: true, ch: f.ch, len: f.len, lang: f.info, ind: f.ch === '~' ? 0 : indentCols(cur, ccol), lines: [] };
        tip().kids.push(node);
        stack.push(node);
        noteContent();
        return;
      }
      // HTML block.
      const kind = htmlKindAt(cur, ccol);
      if (kind !== 0) {
        const node = { t: 'html', kind, end: htmlEnd(kind, cur, ccol), lines: [cur] };
        tip().kids.push(node);
        stack.push(node);
        noteContent();
        // Kinds 1-5 end at a marker that may already sit on this first
        // line (e.g. `<style>…</style>`, `<!-- … -->`); close at once.
        if (node.end !== null && cur.toLowerCase().indexOf(node.end) !== -1) {
          closeTo(stack.length - 1);
        }
        return;
      }
      // Indented code.
      if (indentCols(cur, ccol) >= 4) {
        const node = { t: 'code', fenced: false, lines: [cutCols(cur, 4, ccol)] };
        tip().kids.push(node);
        stack.push(node);
        noteContent();
        return;
      }
      // Paragraph.
      const node = { t: 'para', lines: [cur] };
      tip().kids.push(node);
      stack.push(node);
      noteContent();
      return;
    }
  }

// Transform a lazy continuation line before it joins a paragraph.
// `n` is the number of lines already in the paragraph.
// Expand leading whitespace (spaces/tabs) in a paragraph line to
// spaces, tracking the container-relative column `col`. A tab advances
// to the next multiple of 4. Only inside a container (col > 0): at
// top level a leading tab is kept literally (oracle: `foo\n\tbar`
// keeps `\t`; `> foo\n> \tbar` becomes 2 spaces).
function expandLeadWs(s, col) {
  if (col <= 0) return s;
  let k = 0;
  let c = col;
  let out = '';
  while (k < s.length) {
    const ch = s.charCodeAt(k);
    if (ch === 32) {
      out += ' ';
      c++;
      k++;
    } else if (ch === 9) {
      const w = 4 - (c % 4);
      out += ' '.repeat(w);
      c += w;
      k++;
    } else break;
  }
  if (k === 0) return s;
  return out + s.slice(k);
}

function lazyLine(s, col, n, relCol) {
  s = expandLeadWs(s, relCol);
  let k = 0;
  while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
  const rest = s.slice(k);
  const isSetext = /^(=+|-+)[ \t]*$/.test(rest);
  const ind = indentCols(s, col);
  if (n >= 2 && isSetext && ind < 4 && s.charCodeAt(0) !== 9) {
    // A setext-looking lazy line in a multi-line paragraph is stored
    // with exactly 4 spaces, so it cannot read as a setext underline.
    return '    ' + rest;
  }
  if (ind >= 4) {
    // A lazy line indented 4+ columns loses the code indent (marked
    // reads such a line as indented code and merges the stripped text
    // into the paragraph); this holds for every continuation line,
    // not just the first.
    const c = cutCols(s, 4, col);
    return c === null ? s : c;
  }
  return s;
}

  // One input line.
  function runLine(raw, isLast) {
    // Phase A: match the open containers.
    let s = raw;
    let col = 0;
    let itemBase = 0;
    let failedAt = -1;
    let i = 1;
    while (i < stack.length) {
      const fr = stack[i];
      if (fr.t === 'quote') {
        const m = quoteAt(s, col);
        if (m !== null) {
          s = m.rest;
          col += m.cols;
          i++;
          continue;
        }
        // A line without the `>` marker — blank or not — ends the
        // quote (a blank line is not a lazy continuation).
        failedAt = i;
        break;
      }
      if (fr.t === 'list') {
        i++;
        continue;
      }
      if (fr.t === 'item') {
        if (blankLine(s)) {
          // A blank line does not end the item, but it does end
          // deeper containers (a quote without `>`, a code block):
          // keep matching them instead of breaking here, so a blank
          // line nested in a quote still marks the enclosing lists.
          itemBase = col;
          i++;
          continue;
        }
        // contentCol is the indent from the end of the enclosing
        // containers to the item's content (relative, so it holds when
        // the containers sit at different columns on different lines).
        const need = fr.contentCol;
        if (need <= 0) {
          itemBase = col;
          i++;
          continue;
        }
        if (indentCols(s, col) >= need) {
          s = cutCols(s, need, col);
          col += need;
          itemBase = col;
          i++;
          continue;
        }
        failedAt = i;
        break;
      }
      break;
    }

    // A line that matched a container but whose rest is only whitespace
    // (e.g. `>  `) contributes that whitespace to an open paragraph.
    if (blankLine(s) && s.length > 0 && col > 0 && tip().t === 'para') {
      tip().lines.push(s);
      return;
    }

    // A blank line ends the open leaf (fenced/indented code and HTML
    // kinds 1-5 keep it as content); a table-tab row is an empty row.
    // It also closes any container the line failed to match.
    if (blankLine(s)) {
      if (failedAt !== -1) closeTo(failedAt);
      const t = tip();
      // A blank line closes an empty list item (it has no content to
      // continue); a following indented line is a new paragraph.
      if (t.t === 'item' && t.kids.length === 0) {
        closeTo(stack.length - 1);
        noteBlank();
        return;
      }
      if (t.t === 'table' && tableTabRow(s)) {
        t.rows.push(splitRow(s));
        return;
      }
      if (t.t === 'code') {
        // A blank line inside code keeps its content past the fence
        // indent (fenced) or past 4 columns (indented); a short blank
        // line contributes nothing.
        if (t.fenced) {
          t.lines.push(cutColsUpTo(s, t.ind, col));
        } else {
          const c = cutCols(s, 4, col);
          t.lines.push(c === null ? '' : c);
        }
        return;
      }
      if (t.t === 'html' && t.kind <= 5) {
        // A blank line inside kinds 1-5 is content — except the final
        // empty line, which is only the input's trailing newline.
        if (!isLast) t.lines.push(s);
        return;
      }
      if (t.t === 'para' || t.t === 'table') closeTo(stack.length - 1);
      if (t.t === 'html') {
        // A blank line ends a kind 6/7 HTML block and takes its
        // trailing newline — except the final empty line, which is the
        // input's trailing newline (the block is at EOF then).
        if (isLast) t.eofTrail = true;
        else t.noTrail = true;
        closeTo(stack.length - 1);
      } else if (!isLast && s === '') {
        // A truly empty line right after a kind 1-5 HTML block (already
        // closed at its end tag) strips that block's trailing newline.
        // A whitespace-only line does not.
        const kids = t.kids;
        if (kids && kids.length > 0) {
          const last = kids[kids.length - 1];
          if (last.t === 'html' && last.text && last.text.endsWith('\n')) {
            last.text = last.text.slice(0, -1);
          }
        }
      }
      noteBlank();
      return;
    }

    // Some container did not match.
    if (failedAt !== -1) {
      const t = tip();
      // A list marker after a failed item starts a new item in the
      // enclosing list (the "ordered must start at 1" and "non-empty"
      // paragraph-interrupt rules do not apply inside a list). This
      // comes first: a marker line is a new item, never code content.
      if (stack[failedAt].t === 'item' && listAt(s, col) !== null) {
        closeTo(failedAt);
        startBlocks(s, col);
        return;
      }
      // A fenced code block inside a list item is not container-matched
      // on indent — but only once it has content: a line that misses
      // the item indent is code content if the block already holds a
      // line (it cannot be a closing fence, which must match the
      // container to close it). The FIRST line after the fence must
      // match the container, or the block closes empty. A line that
      // misses a `>` ends the quote (and the code block inside it), so
      // only item failures continue.
      if (t.t === 'code' && t.fenced && stack[failedAt].t === 'item' && t.lines.length > 0) {
        t.lines.push(cutColsUpTo(s, t.ind, col));
        return;
      }
      if (t.t === 'para' && !interruptsPara(s, col, stack.some((fr) => fr.t === 'item'))) {
        // Lazy continuation: the line joins the paragraph as text.
        t.lines.push(lazyLine(s, col, t.lines.length, col - itemBase));
        return;
      }
      closeTo(failedAt);
      startBlocks(s, col);
      return;
    }

    // All containers matched. Continue the open leaf, if any.
    const t = tip();
    if (t.t === 'code' && t.fenced) {
      const f = fenceAt(s, col);
      if (f !== null && f.ch === t.ch && f.len >= t.len && f.info === '') {
        closeTo(stack.length - 1);
        return;
      }
      t.lines.push(cutColsUpTo(s, t.ind, col));
      return;
    }
    if (t.t === 'code') {
      // Indented code: a line with less than 4 columns of indent ends it.
      if (indentCols(s, col) < 4) {
        closeTo(stack.length - 1);
        startBlocks(s, col);
        return;
      }
      t.lines.push(cutCols(s, 4, col));
      return;
    }
    if (t.t === 'html') {
      if (t.end !== null && s.toLowerCase().indexOf(t.end) !== -1) {
        t.lines.push(s);
        closeTo(stack.length - 1);
        return;
      }
      t.lines.push(s);
      return;
    }
    if (t.t === 'table') {
      if (startsBlock(s, col)) {
        closeTo(stack.length - 1);
        startBlocks(s, col);
        return;
      }
      t.rows.push(splitRow(s));
      return;
    }
    if (t.t === 'para') {
      // A table delimiter row turns the paragraph's last line into the
      // table header (earlier lines stay a paragraph).
      const aligns = rowAligns(s, col);
      if (aligns !== null) {
        const rest = readDefs(joinParaLines(t.lines), refs);
        const plines = rest === '' ? [] : rest.split('\n');
        if (plines.length >= 1) {
          const headCells = splitRow(plines[plines.length - 1]);
          if (headCells.length === aligns.length) {
            stack.pop();
            const parent = tip();
            parent.kids.pop();
            const earlier = plines.slice(0, -1).join('\n');
            if (earlier !== '') parent.kids.push({ t: 'para', text: earlier });
            const table = { t: 'table', head: headCells, aligns, rows: [] };
            parent.kids.push(table);
            stack.push(table);
            noteContent();
            return;
          }
        }
      }
      // A setext underline turns the paragraph into a heading.
      const sx = setextAt(s, col);
      if (sx !== 0) {
        const rest = readDefs(joinParaLines(t.lines), refs);
        if (rest === '') {
          closeTo(stack.length - 1);
          startBlocks(s, col);
          return;
        }
        stack.pop();
        const parent = tip();
        parent.kids.pop();
        parent.kids.push({ t: 'head', level: sx, text: rest.trim() });
        noteContent();
        return;
      }
      // Any other interrupting block closes the paragraph.
      if (interruptsPara(s, col, stack.some((fr) => fr.t === 'item'))) {
        closeTo(stack.length - 1);
        startBlocks(s, col);
        return;
      }
      t.lines.push(expandLeadWs(s, col - itemBase));
      return;
    }

    // No open leaf: start blocks here.
    startBlocks(s, col);
  }

  for (let li = 0; li < lines.length; li++) runLine(lines[li], li === lines.length - 1);
  // Kind 6/7 HTML blocks still open at end of input keep a trailing
  // newline only when the input itself ends in one (a trailing `\n`
  // splits off a final empty line).
  const endsWithNl = lines.length > 0 && lines[lines.length - 1] === '';
  if (endsWithNl) {
    for (const frame of stack) {
      if (frame.t === 'html' && frame.kind >= 6) frame.eofTrail = true;
    }
  }
  closeTo(1);
  return root;
}

// ---------------------------------------------------------------------------
// Inline layer: escaping, code spans, link scanning
// ---------------------------------------------------------------------------

// Length of the backtick run starting at s[i] (0 when s[i] is not a backtick).
function tickRun(s, i) {
  let n = 0;
  while (i + n < s.length && s[i + n] === '`') n++;
  return n;
}

// Find the closing run for a code span opened at s[i] with run length n.
// Returns the index just past the closing run, or -1. The closer must have
// exactly the same run length (CommonMark code-span rule).
function tickClose(s, i, n) {
  let j = i + n;
  while (j < s.length) {
    if (s[j] === '`') {
      const m = tickRun(s, j);
      if (m === n) return j + m;
      j += m;
    } else j++;
  }
  return -1;
}

// True when the link text holds a code span `` ... ` ... `` (2+ backtick
// delimiters whose content holds a backtick run) that is NOT the last
// thing in the text. Marked rejects such a link; only a span ending the
// text (right before `]`) lets the link resolve.
function hasDanglingTickSpan(text) {
  let i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      const n = tickRun(text, i);
      if (n >= 2) {
        const close = tickClose(text, i, n);
        if (close !== -1) {
          const inner = text.slice(i + n, close - n);
          if (inner.indexOf('`') !== -1 && close < text.length) return true;
          i = close;
          continue;
        }
      }
      i += n;
    } else i++;
  }
  return false;
}

// Find the `]` matching the `[` at s[i]. Nested brackets count; a backtick
// run is skipped by jumping to the next backtick run of any length, and an
// unmatched backtick run swallows the rest (so no `]` is found). Returns the
// index of the matching `]`, or -1.
// Lenient inline-tag span (marked's html tokenizer shape): a `<` + letter
// + anything but `<`/`>` up to the next `>`. Used only by bracketClose so
// a `]` inside a tag/autolink span is not a bracket closer.
const LENIENT_TAG_RE = /^<\/?[a-zA-Z][^<>]*?\/?>/;

function bracketClose(s, i) {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '`') {
      const n = tickRun(s, j);
      // Skip the code span: prefer the matching closing run of the same
      // length (a shorter run inside, e.g. a lone ` inside ``...``, is
      // content). If no same-length run exists, fall back to the next
      // run of any length so a `]` past it can still close the bracket.
      // An unmatched run (no backtick at all after it) swallows the rest.
      let k = j + n;
      let first = -1;
      let closed = -1;
      while (k < s.length) {
        if (s[k] === '`') {
          const m = tickRun(s, k);
          if (first === -1) first = k;
          if (m === n) {
            closed = k + m;
            break;
          }
          k += m;
        } else {
          k++;
        }
      }
      if (closed !== -1) {
        j = closed;
      } else if (first !== -1) {
        j = first + tickRun(s, first);
      } else {
        return -1;
      }
    } else if (c === '<') {
      // A `]` inside an autolink or tag span is not a bracket closer.
      const auto = autolinkAt(s, j);
      if (auto) {
        j = auto.end;
        continue;
      }
      const m = LENIENT_TAG_RE.exec(s.slice(j, j + 4096));
      if (m) {
        j += m[0].length;
        continue;
      }
      j++;
    } else if (c === '[') {
      depth++;
      j++;
    } else if (c === ']') {
      depth--;
      if (depth === 0) return j;
      j++;
    } else if (c === '\\') {
      j += 2;
    } else j++;
  }
  return -1;
}

// Find the `)` matching the `(` at s[i], counting nested parens. Backslash
// escapes are skipped. Returns the index of the matching `)`, or -1.
function parenClose(s, i) {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return j;
    } else if (c === '\\') {
      j++;
    }
    j++;
  }
  return -1;
}

// Skip spaces and tabs (not newlines) from s[i]. Returns the new index.
function skipInlineWs(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}

// Skip spaces, tabs and newlines from s[i]. Returns the new index.
function skipWsNl(s, i) {
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n') i++;
    else break;
  }
  return i;
}

// Parse the suffix of a bracket link whose `]` is at s[close]. `text` is the
// raw link text (between `[` and `]`). Returns {href, title, end} where end
// is the index just past the consumed suffix, or null when no link exists.
// Rules (marked 18.1.3): `(` must follow `]` at once; a failed inline form
// falls back to the shortcut reference; a present-but-undefined `[label]`
// does NOT fall back; `[]` is the collapsed reference.
function linkTail(s, close, text, refs) {
  const after = close + 1;
  if (after < s.length && s[after] === '(') {
    const inline = inlineSuffix(s, after);
    if (inline) return inline;
    // fall through to the shortcut reference
  } else if (after < s.length && s[after] === '[') {
    const labelClose = bracketClose(s, after);
    if (labelClose === -1) {
      // malformed label: fall through to the shortcut reference
    } else {
      const raw = s.slice(after + 1, labelClose);
      const folded = labelFold(raw);
      if (folded === '') {
        if (raw === '') {
          const ref = refs.get(labelFold(text));
          if (ref) return { href: ref.href, title: ref.title, end: labelClose + 1 };
        }
        // whitespace-only label: invalid suffix, fall to shortcut
      } else {
        const ref = refs.get(folded);
        if (ref) return { href: ref.href, title: ref.title, end: labelClose + 1 };
        return null;
      }
    }
  }
  const ref = refs.get(labelFold(text));
  if (ref) return { href: ref.href, title: ref.title, end: close + 1 };
  return null;
}

// Parse an inline `(dest title)` form starting at the `(` at s[open].
// Returns {href, title, end} (end just past the closing paren), or null.
function inlineSuffix(s, open) {
  let j = skipWsNl(s, open + 1);
  let href = '';
  if (j < s.length && s[j] === '<') {
    // Angle-bracket destination: may hold spaces, but no line ending
    // and no unescaped `<`; a backslash escapes the next character.
    let k = j + 1;
    while (k < s.length) {
      const c = s[k];
      if (c === '\\') {
        k += 2;
        continue;
      }
      if (c === '>' || c === '\n' || c === '<') break;
      k++;
    }
    if (k >= s.length || s[k] !== '>') return null;
    href = s.slice(j + 1, k);
    j = k + 1;
  } else {
    // Bare destination: no spaces, parens must balance; a backslash
    // escapes the next character (it is not a paren).
    const start = j;
    let depth = 0;
    while (j < s.length) {
      const c = s[j];
      const code = s.charCodeAt(j);
      if (c === '\\' && j + 1 < s.length) {
        j += 2;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (code < 0x20 || code === 0x7f) return null;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    href = s.slice(start, j);
    if (depth !== 0) return null;
  }
  j = skipWsNl(s, j);
  let title = null;
  if (j < s.length && (s[j] === '"' || s[j] === "'" || s[j] === '(')) {
    const q = s[j];
    const closer = q === '(' ? ')' : q;
    let k = j + 1;
    let ok = false;
    while (k < s.length) {
      if (s[k] === '\\') { k += 2; continue; }
      if (q === '(' && s[k] === '(') return null;
      if (s[k] === closer) { ok = true; break; }
      k++;
    }
    if (!ok) return null;
    title = s.slice(j + 1, k);
    j = k + 1;
    j = skipWsNl(s, j);
  }
  if (j >= s.length || s[j] !== ')') return null;
  return { href, title, end: j + 1 };
}

// Email pattern shared by `<...>` and GFM autolinks: the domain needs a dot.
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

// Scheme for `<...>` autolinks: 2-32 chars, letter first.
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/;

// Try to read a bracket link (or image, when isImage) whose `[` is at s[i].
// Returns {node, end} or null. The link text is tokenized with GFM autolinks
// off; a link whose text holds another bracket link is rejected.
function linkAt(s, i, refs, isImage, flags) {
  const close = bracketClose(s, i);
  if (close === -1) return null;
  const text = s.slice(i + 1, close);
  const tail = linkTail(s, close, text, refs);
  if (!tail) return null;
  // A code span `` ... ` ... `` (2+ backtick delimiters holding a
  // backtick run) breaks marked's link parsing unless it ends the text:
  // with more text after it before `]`, the link is rejected.
  if (hasDanglingTickSpan(text)) return null;
  const kids = scanInline(text, refs, flags | NO_GFM);
  if (!isImage && containsLink(kids)) return null;
  if (isImage) {
    return {
      node: { t: 'img', src: tail.href, title: tail.title, alt: tokensText(kids) },
      end: tail.end,
    };
  }
  return { node: { t: 'link', href: tail.href, title: tail.title, kids }, end: tail.end };
}

// Does this token tree hold a bracket link (not an autolink, not inside an
// image's alt text)? Used to reject nested links.
function containsLink(tokens) {
  for (const tok of tokens) {
    if (tok.t === 'link') return true;
    if (tok.t === 'img') continue;
    if (tok.kids && containsLink(tok.kids)) return true;
  }
  return false;
}

// Try to read a `<...>` autolink at s[i]. Returns {node, end} or null.
function autolinkAt(s, i) {
  let j = i + 1;
  while (j < s.length && s[j] !== '>') {
    const c = s[j];
    if (c === ' ' || c === '\n' || c === '<') return null;
    j++;
  }
  if (j >= s.length) return null;
  const body = s.slice(i + 1, j);
  if (SCHEME_RE.test(body)) {
    return { node: { t: 'autolink', href: body, text: body }, end: j + 1 };
  }
  if (EMAIL_RE.test(body)) {
    return { node: { t: 'autolink', href: 'mailto:' + body, text: body }, end: j + 1 };
  }
  return null;
}

// Characters that may appear in a GFM www autolink.
function gfmUrlChar(c) {
  const code = c.charCodeAt(0);
  if (code >= 0x61 && code <= 0x7a) return true;
  if (code >= 0x41 && code <= 0x5a) return true;
  if (code >= 0x30 && code <= 0x39) return true;
  return '-._~:/?#[]@!$&\'()*+,;=%'.indexOf(c) !== -1;
}

// Trailing punctuation stripped from a GFM autolink.
function gfmTrailPunct(c) {
  return '?!.,:;*_~\''.indexOf(c) !== -1;
}

// Try to read a GFM autolink (www. or bare email) at s[i].
// Returns {node, end} or null.
// Length of a URI scheme at s[i] (letter + 1-31 alnum/`+`/`.`/`-`,
// then `:`), or 0. Used for GFM scheme autolinks (`mailto:`, `xmpp:`).
function schemeLen(s, i) {
  const c0 = s.charCodeAt(i);
  if (!alphaCode(c0)) return 0;
  let j = i + 1;
  while (j < s.length && j < i + 32) {
    const c = s.charCodeAt(j);
    if (alphaCode(c) || digitCode(c) || c === 43 || c === 46 || c === 45) j++;
    else break;
  }
  if (j - i < 2 || j - i > 32) return 0;
  if (j >= s.length || s.charCodeAt(j) !== 58) return 0;
  return j - i + 1;
}

// Trim a scanned GFM autolink URL, repeating until stable: an unmatched
// opener truncates before it, trailing unmatched closers drop one by
// one, an entity-like tail (`&name;`) is removed, then trailing
// punctuation — each step can expose another.
function trimGfmUrl(url) {
  for (let round = 0; round < 3; round++) {
    const before = url;
    // Paren balance, depth-based: a ')' only counts when it closes a
    // preceding '(' (an unmatched ')' before any '(' does not balance
    // a later opener). Unmatched openers truncate before the last '(';
    // trailing unmatched ')'s are dropped one by one.
    let open = 0;
    let shut = 0;
    let depth = 0;
    for (let k = 0; k < url.length; k++) {
      if (url[k] === '(') {
        open++;
        depth++;
      } else if (url[k] === ')') {
        if (depth > 0) {
          shut++;
          depth--;
        }
      }
    }
    if (open > shut) {
      url = url.slice(0, url.lastIndexOf('('));
    } else {
      while (url.length > 0 && url.endsWith(')')) {
        let d = 0;
        for (let k = 0; k < url.length - 1; k++) {
          if (url[k] === '(') d++;
          else if (url[k] === ')') {
            if (d > 0) d--;
          }
        }
        if (d === 0) url = url.slice(0, -1);
        else break;
      }
    }
    if (url.length > 0 && url[url.length - 1] === ';') {
      const amp = url.lastIndexOf('&');
      if (amp !== -1 && /^&[a-zA-Z0-9#]+;$/.test(url.slice(amp))) {
        url = url.slice(0, amp);
      }
    }
    while (url.length > 0 && gfmTrailPunct(url[url.length - 1])) {
      url = url.slice(0, -1);
    }
    if (url === before) break;
  }
  return url;
}

// Extend a scanned GFM URL past a trailing backslash at end of line:
// a `\` followed by a newline (or end of input) is a literal backslash
// belonging to the URL (oracle: `www.flux.com\` -> `http://www.flux.com%5C`).
// It is included BEFORE trimming so it shields the char before it from
// the trailing-punctuation strip (`https://img.shields.io.\` keeps the
// `.`). Only when real URL content was already scanned (j > minJ): a lone
// `\` right after the scheme/prefix is not a URL (`tests:\` is literal
// text + hard break, not a scheme autolink).
function extendTrailBackslash(s, j, minJ) {
  if (j <= minJ) return j;
  while (j < s.length && s[j] === '\\' && (j + 1 >= s.length || s[j + 1] === '\n')) j++;
  return j;
}

function gfmLinkAt(s, i) {
  if (s.startsWith('www.', i)) {
    let j = i + 4;
    while (j < s.length && gfmUrlChar(s[j])) j++;
    j = extendTrailBackslash(s, j, i + 4);
    let url = s.slice(i, j);
    if (url.length <= 4) return null;
    url = trimGfmUrl(url);

    if (url.length <= 4) return null;
    return { node: { t: 'autolink', href: 'http://' + url, text: url }, end: i + url.length };
  }
  if (s.startsWith('http://', i) || s.startsWith('https://', i)) {
    let j = i;
    while (j < s.length && gfmUrlChar(s[j])) j++;
    j = extendTrailBackslash(s, j, i + (s.startsWith('https://', i) ? 8 : 7));
    let url = s.slice(i, j);
    url = trimGfmUrl(url);

    if (url.length <= 8) return null;
    return { node: { t: 'autolink', href: url, text: url }, end: i + url.length };
  }
  // Any other scheme (`mailto:`, `xmpp:`, …): the scheme + a run of URL
  // characters, trimmed like above. `mailto:` takes an email only (cut
  // at the first `/`); `xmpp:` takes an email + one `/resource`
  // (cut at the second `/`). When the part after the scheme is
  // email-like (holds `@`), a trailing `-`/`_` voids the link — so
  // that check runs before trailing punctuation can strip the `_`.
  const sl = schemeLen(s, i);
  if (sl > 0) {
    let j = i + sl;
    while (j < s.length && gfmUrlChar(s[j])) j++;
    j = extendTrailBackslash(s, j, i + sl);
    let url = s.slice(i, j);
    const scheme = s.slice(i, i + sl - 1).toLowerCase();
    if (scheme === 'mailto') {
      const cut = url.indexOf('/', sl);
      if (cut !== -1) url = url.slice(0, cut);
    } else if (scheme === 'xmpp') {
      const first = url.indexOf('/', sl);
      if (first !== -1) {
        const second = url.indexOf('/', first + 1);
        if (second !== -1) url = url.slice(0, second);
      }
    }
    const head = url.slice(sl).split('/')[0];
    if (head.indexOf('@') !== -1 && (url.endsWith('-') || url.endsWith('_'))) return null;
    url = trimGfmUrl(url);
    if (url.length <= sl) return null;
    if (!/[a-zA-Z0-9]/.test(url.slice(sl))) return null;
    return { node: { t: 'autolink', href: url, text: url }, end: i + url.length };
  }
  // Bare email: scan the local part, then `@`, then the domain. A
  // domain cannot end in `.` or `-`, so trim those; but if the email
  // is then followed by `-` or `_` it is part of a longer word, not
  // an autolink (a following `.` is just trailing punctuation).
  let j = i;
  while (j < s.length && /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~\-]/.test(s[j])) j++;
  if (j < s.length && s[j] === '@') {
    let k = j + 1;
    while (k < s.length && /[a-zA-Z0-9.\-]/.test(s[k])) k++;
    let mail = s.slice(i, k);
    while (mail.length > 0 && (mail.endsWith('.') || mail.endsWith('-'))) {
      mail = mail.slice(0, -1);
      k--;
    }
    if (EMAIL_RE.test(mail)) {
      const after = s[k];
      if (after !== '-' && after !== '_') {
        return { node: { t: 'autolink', href: 'mailto:' + mail, text: mail }, end: k };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inline tokenizer: turns a text run into a flat token list.
// ---------------------------------------------------------------------------

// Flags for scanInline.
const NO_GFM = 1;

// Classify the code point at a boundary: 0 whitespace, 1 punctuation,
// 2 anything else. A string edge counts as whitespace.
function charKindAt(s, i, isBefore) {
  const pt = isBefore ? pointBefore(s, i) : pointAfter(s, i);
  if (pt === '') return 0;
  const code = pt.charCodeAt(0);
  if (code < 128) {
    if (wsCode(code)) return 0;
    if (asciiPunctCode(code)) return 1;
    return 2;
  }
  if (uniSpaceStr(pt)) return 0;
  if (uniPunctStr(pt)) return 1;
  return 2;
}

// Can a delimiter run of `ch` (`*`, `_` or `~`) starting at s[i] with
// length n open / close emphasis? Follows the CommonMark flanking rules.
function delimCan(s, i, n, ch) {
  const beforeKind = charKindAt(s, i, true);
  const afterKind = charKindAt(s, i + n, false);
  const leftFlank = afterKind !== 0 && (afterKind !== 1 || beforeKind === 0 || beforeKind === 1);
  const rightFlank = beforeKind !== 0 && (beforeKind !== 1 || afterKind === 0 || afterKind === 1);
  if (ch === '_') {
    return {
      canOpen: leftFlank && (!rightFlank || beforeKind === 1),
      canClose: rightFlank && (!leftFlank || afterKind === 1),
    };
  }
  return { canOpen: leftFlank, canClose: rightFlank };
}

// Match an inline HTML tag at s[i] (s[i] is '<'). Returns the raw tag
// text, or null. Covers comments, processing instructions, CDATA,
// declarations, and open/close tags with attributes.
const HTML_TAG_RE = /^(?:<\/[a-zA-Z][a-zA-Z0-9-]*[ \t\n\r\f]*>|<[a-zA-Z][a-zA-Z0-9-]*(?:[ \t\n\r\f]+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:[ \t\n\r\f]*=[ \t\n\r\f]*(?:"[^"]*"|'[^']*'|[^\s"'=<>\`]+))?)*[ \t\n\r\f]*\/?>)/;

function htmlTagAt(s, i) {
  if (s.startsWith('<!--', i)) {
    // Empty comment `<!-->` and single-dash `<!--->` are complete on
    // their own; otherwise the comment runs to the first `-->`.
    if (s.startsWith('<!-->', i)) return '<!-->';
    if (s.startsWith('<!--->', i)) return '<!--->';
    const end = s.indexOf('-->', i + 4);
    if (end === -1) return null;
    return s.slice(i, end + 3);
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    if (end === -1) return null;
    return s.slice(i, end + 2);
  }
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    if (end === -1) return null;
    return s.slice(i, end + 3);
  }
  if (s.startsWith('<!', i) && i + 2 < s.length && alphaCode(s.charCodeAt(i + 2))) {
    const end = s.indexOf('>', i + 2);
    if (end === -1) return null;
    return s.slice(i, end + 1);
  }
  const m = HTML_TAG_RE.exec(s.slice(i, i + 4096));
  return m ? m[0] : null;
}

// Could a bare email autolink start at s[i]? True when s[i] is an email
// local-part char, the previous char is not, and an `@` sits nearby.
const EMAIL_LOCAL_RE = /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~\-]/;

function isEmailStart(s, i) {
  if (!EMAIL_LOCAL_RE.test(s[i])) return false;
  if (i > 0 && EMAIL_LOCAL_RE.test(s[i - 1])) return false;
  const at = s.indexOf('@', i);
  if (at === -1 || at - i > 64) return false;
  return true;
}

// Plain-text rendering of a token list (image alt text). A hard break
// contributes nothing; a soft break is already a `\n` inside a text token.
function tokensText(tokens) {
  let out = '';
  for (const tok of tokens) {
    if (tok.t === 'text' || tok.t === 'code' || tok.t === 'html' || tok.t === 'esc') out += tok.s;
    else if (tok.t === 'autolink') out += tok.text;
    else if (tok.t === 'img') out += tok.alt;
    else if (tok.kids) out += tokensText(tok.kids);
  }
  return out;
}

// Tokenize s into a flat list: text, code, br, html, autolink, link, img,
// and em / strong / del nodes (built recursively). `masked` hides code
// spans, links and HTML so emphasis scanning never sees their delimiters.
function scanInline(s, refs, flags) {
  const out = [];
  const masked = maskInline(s, refs);
  let buf = '';
  let i = 0;
  const n = s.length;
  const flush = () => {
    if (buf !== '') {
      out.push({ t: 'text', s: buf });
      buf = '';
    }
  };
  while (i < n) {
    const c = s[i];
    if (c === '\n') {
      let trail = 0;
      let k = buf.length - 1;
      while (k >= 0 && buf[k] === ' ') {
        trail++;
        k--;
      }
      if (trail >= 2) {
        buf = buf.slice(0, buf.length - trail);
        flush();
        out.push({ t: 'br' });
      } else {
        buf += '\n';
      }
      i++;
    } else if (c === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') {
        flush();
        out.push({ t: 'br' });
        i += 2;
      } else if (nx !== undefined && asciiPunctCode(nx.charCodeAt(0))) {
        // An escaped punctuation mark is its own token so the renderer
        // escapes it strictly (an escaped `&` is not an entity).
        flush();
        out.push({ t: 'esc', s: nx });
        i += 2;
      } else {
        buf += '\\';
        i++;
      }
    } else if (c === '`') {
      const run = tickRun(s, i);
      const close = tickClose(s, i, run);
      if (close === -1) {
        buf += s.slice(i, i + run);
        i += run;
      } else {
        let inner = s.slice(i + run, close - run);
        inner = inner.replace(/\n/g, ' ');
        if (
          inner.length >= 2 &&
          inner[0] === ' ' &&
          inner[inner.length - 1] === ' ' &&
          /[^ ]/.test(inner)
        ) {
          inner = inner.slice(1, -1);
        }
        flush();
        out.push({ t: 'code', s: inner });
        i = close;
      }
    } else if (c === '!' && s[i + 1] === '[') {
      const got = linkAt(s, i + 1, refs, true, flags);
      if (got) {
        flush();
        out.push(got.node);
        i = got.end;
      } else {
        buf += '!';
        i++;
      }
    } else if (c === '[') {
      const got = linkAt(s, i, refs, false, flags);
      if (got) {
        flush();
        out.push(got.node);
        i = got.end;
      } else {
        buf += '[';
        i++;
      }
    } else if (c === '<') {
      const auto = autolinkAt(s, i);
      if (auto) {
        flush();
        out.push(auto.node);
        i = auto.end;
      } else {
        const tag = htmlTagAt(s, i);
        if (tag !== null) {
          flush();
          noteHtmlTag(tag);
          out.push({ t: 'html', s: tag });
          i += tag.length;
        } else {
          buf += '<';
          i++;
        }
      }
    } else if (c === '*' || c === '_') {
      let run = 1;
      while (i + run < n && s[i + run] === c) run++;
      const got = tryEmphasis(s, masked, i, c, run, refs, flags);
      if (got) {
        flush();
        out.push(got.node);
        i = got.end;
      } else if (delimCan(s, i, run, c).canOpen) {
        // Only one delimiter is literal; the rest of the run is
        // retried as an opener (e.g. `**foo*` -> `*` + `<em>foo</em>`).
        buf += c;
        i++;
      } else {
        // The run cannot open (e.g. intra-word `_`): the whole run is
        // literal, do not retry inside it.
        buf += s.slice(i, i + run);
        i += run;
      }
    } else if (c === '~') {
      let run = 1;
      while (i + run < n && s[i + run] === '~') run++;
      const got = run <= 2 ? tryDel(s, masked, i, run, refs, flags) : null;
      if (got) {
        flush();
        out.push(got.node);
        i = got.end;
      } else {
        buf += c;
        i++;
      }
    } else if (!(flags & NO_GFM) && !inLinkLeak && c === 'w' && s.startsWith('www.', i)) {
      const got = gfmLinkAt(s, i);
      if (got) {
        flush();
        out.push(got.node);
        i = got.end;
      } else {
        buf += 'w';
        i++;
      }
    } else if (!(flags & NO_GFM) && !inLinkLeak && c === 'h' && (s.startsWith('http://', i) || s.startsWith('https://', i))) {
      const got = gfmLinkAt(s, i);
      if (got) {
        flush();
        out.push(got.node);
        i = got.end;
      } else {
        buf += 'h';
        i++;
      }
    } else if (!(flags & NO_GFM) && !inLinkLeak && alphaCode(s.charCodeAt(i)) && schemeLen(s, i) > 0) {
      const got = gfmLinkAt(s, i);
      if (got) {
        flush();
        out.push(got.node);
        i = got.end;
      } else {
        buf += c;
        i++;
      }
    } else if (!(flags & NO_GFM) && !inLinkLeak && isEmailStart(s, i)) {
      const got = gfmLinkAt(s, i);
      if (got) {
        flush();
        out.push(got.node);
        i = got.end;
      } else {
        buf += c;
        i++;
      }
    } else {
      buf += c;
      i++;
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Emphasis: recursive balance-scan over a masked copy of the text.
// ---------------------------------------------------------------------------

// Same-length copy of s where code spans, links, images, autolinks and
// HTML tags are hidden behind 'a's, and backslash escapes behind '+'s, so
// emphasis scanning never counts delimiters inside them. Indices line up
// with s exactly.
// True when every backtick run in `text` closes with a run of the same
// length (a code span, possibly holding shorter backtick runs). Marked's
// emphasis mask only recognises a link whose label is made of such spans
// and plain characters; a label with a mismatched run (e.g. `` `` ``
// opened, only ` to close) is not matched as a link by the mask at all,
// so its backticks stay visible and a later lone run can open a code
// span that swallows the emphasis delimiters after the link.
function labelTicksBalanced(text) {
  let i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      const run = tickRun(text, i);
      const close = tickClose(text, i, run);
      if (close === -1) return false;
      i = close;
    } else i++;
  }
  return true;
}

function maskInline(s, refs) {
  const chars = s.split('');
  let i = 0;
  const n = s.length;
  // Hide a span (code, link, tag) the way marked's emphasis mask
  // does: `[` + a's + `]` — the brackets are punctuation, so a `_`
  // run next to the span is not intra-word and may open or close.
  // Hiding with plain `a`'s instead would make `` `a`__init__`b` ``
  // unreadable as a strong (the closer looks followed by a letter).
  const hide = (a, b) => {
    if (b - a >= 2) {
      chars[a] = '[';
      chars[b - 1] = ']';
      for (let k = a + 1; k < b - 1; k++) chars[k] = 'a';
    } else {
      for (let k = a; k < b; k++) chars[k] = 'a';
    }
  };
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n && asciiPunctCode(s.charCodeAt(i + 1))) {
      chars[i] = '+';
      chars[i + 1] = '+';
      i += 2;
    } else if (c === '`') {
      const run = tickRun(s, i);
      const close = tickClose(s, i, run);
      if (close === -1) {
        i += run;
      } else {
        hide(i, close);
        i = close;
      }
    } else if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const start = c === '!' ? i + 1 : i;
      const close = bracketClose(s, start);
      let done = false;
      if (close !== -1) {
        const tail = linkTail(s, close, s.slice(start + 1, close), refs);
        if (tail && labelTicksBalanced(s.slice(start + 1, close))) {
          // A link whose text holds another link is not a link at all;
          // do not hide it (its delimiters stay visible to emphasis).
          const kids = scanInline(s.slice(start + 1, close), refs, NO_GFM);
          if (c === '!' || !containsLink(kids)) {
            hide(i, tail.end);
            i = tail.end;
            done = true;
          }
        }
      }
      if (!done) i++;
    } else if (c === '<') {
      const auto = autolinkAt(s, i);
      if (auto) {
        hide(i, auto.end);
        i = auto.end;
      } else {
        const tag = htmlTagAt(s, i);
        if (tag !== null) {
          hide(i, i + tag.length);
          i += tag.length;
        } else i++;
      }
    } else {
      i++;
    }
  }
  return chars.join('');
}

// Try to match an emphasis run of `ch` (`*` or `_`) starting at s[i] with
// run length `run`. `masked` is the masked copy of s. Returns
// {node, end} (end just past the closer's used delimiters) or null.
// The scan keeps a balance: opener-like runs add, closer-like runs
// subtract; the closer that drives the balance to zero wins. A closer is
// skipped (its length carried in f) when the rule of three fires.
function tryEmphasis(s, masked, i, ch, run, refs, flags) {
  const open = delimCan(s, i, run, ch);
  if (!open.canOpen) return null;
  let m = run;
  let f = 0;
  let j = i + run;
  const n = masked.length;
  while (j < n) {
    if (masked[j] !== ch) {
      j++;
      continue;
    }
    let b = 1;
    while (j + b < n && masked[j + b] === ch) b++;
    const info = delimCan(masked, j, b, ch);
    if (info.canOpen && !info.canClose) {
      m += b;
      j += b;
      continue;
    }
    if (!info.canClose) {
      j += b;
      continue;
    }
    if ((info.canOpen && info.canClose) || open.canClose) {
      if (run % 3 !== 0 && (run + b) % 3 === 0) {
        f += b;
        j += b;
        continue;
      }
    }
    m -= b;
    if (m > 0) {
      j += b;
      continue;
    }
    const bUsed = Math.min(b, b + m + f);
    const use = Math.min(run, bUsed) % 2 === 1 ? 1 : 2;
    const inner = s.slice(i + use, j + bUsed - use);
    const kids = scanInline(inner, refs, flags);
    return { node: { t: use === 1 ? 'em' : 'strong', kids }, end: j + bUsed };
  }
  return null;
}

// Try to match a strikethrough run of `~` starting at s[i] with run
// length `run` (1 or 2). The closer must have exactly the same length.
// Returns {node, end} or null.
function tryDel(s, masked, i, run, refs, flags) {
  const open = delimCan(s, i, run, '~');
  if (!open.canOpen) return null;
  let p = run;
  let j = i + run;
  const n = masked.length;
  while (j < n) {
    if (masked[j] !== '~') {
      j++;
      continue;
    }
    let b = 1;
    while (j + b < n && masked[j + b] === '~') b++;
    if (b !== run) {
      j += b;
      continue;
    }
    const info = delimCan(masked, j, b, '~');
    if (info.canOpen && !info.canClose) {
      p += b;
      j += b;
      continue;
    }
    if (!info.canClose) {
      j += b;
      continue;
    }
    p -= b;
    if (p > 0) {
      j += b;
      continue;
    }
    const inner = s.slice(i + run, j + b - run);
    const kids = scanInline(inner, refs, flags);
    return { node: { t: 'del', kids }, end: j + b };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering: block tree + inline tokens -> marked-compatible HTML.
// ---------------------------------------------------------------------------

// Render an inline token list into `out` (an array of string pieces).
function renderInlineTokens(tokens, refs, out) {
  for (const tok of tokens) {
    if (tok.t === 'text') {
      pushEscaped(out, tok.s);
    } else if (tok.t === 'esc') {
      pushEscapedStrict(out, tok.s);
    } else if (tok.t === 'code') {
      out.push('<code>');
      pushEscapedStrict(out, tok.s);
      out.push('</code>');
    } else if (tok.t === 'br') {
      out.push('<br>');
    } else if (tok.t === 'html') {
      out.push(tok.s);
    } else if (tok.t === 'autolink') {
      const href = hrefEncodeRaw(tok.href);
      if (href === null) {
        pushEscapedStrict(out, tok.text);
      } else {
        out.push('<a href="');
        pushEscapedStrict(out, href);
        out.push('">');
        pushEscapedStrict(out, tok.text);
        out.push('</a>');
      }
    } else if (tok.t === 'link') {
      const href = hrefEncode(tok.href);
      if (href === null) {
        renderInlineTokens(tok.kids, refs, out);
      } else {
        out.push('<a href="');
        pushEscaped(out, href);
        out.push('"');
        if (tok.title !== null && tok.title !== undefined) {
          out.push(' title="');
          pushEscaped(out, unescapeSlashes(tok.title));
          out.push('"');
        }
        out.push('>');
        renderInlineTokens(tok.kids, refs, out);
        out.push('</a>');
      }
    } else if (tok.t === 'img') {
      const src = hrefEncode(tok.src);
      if (src === null) {
        pushEscaped(out, tok.alt);
      } else {
        out.push('<img src="');
        pushEscaped(out, src);
        out.push('" alt="');
        pushEscaped(out, tok.alt);
        out.push('"');
        if (tok.title !== null && tok.title !== undefined) {
          out.push(' title="');
          pushEscaped(out, unescapeSlashes(tok.title));
          out.push('"');
        }
        out.push('>');
      }
    } else if (tok.t === 'em') {
      out.push('<em>');
      renderInlineTokens(tok.kids, refs, out);
      out.push('</em>');
    } else if (tok.t === 'strong') {
      out.push('<strong>');
      renderInlineTokens(tok.kids, refs, out);
      out.push('</strong>');
    } else if (tok.t === 'del') {
      out.push('<del>');
      renderInlineTokens(tok.kids, refs, out);
      out.push('</del>');
    }
  }
}

// Render one inline text run (paragraph / heading / table cell) to a string.
function inlineHtml(text, refs) {
  const out = [];
  renderInlineTokens(scanInline(text, refs, 0), refs, out);
  return out.join('');
}

// Render a list item's children. Tight lists render paragraphs inline
// (no <p> tags); loose lists render every child as a block.
// The checkbox HTML for a task-list paragraph (`node.task` true =
// checked, false = unchecked), followed by the space before the text.
function taskInput(task) {
  return task
    ? '<input checked="" disabled="" type="checkbox"> '
    : '<input disabled="" type="checkbox"> ';
}

function itemHtml(item, tight, refs, out) {
  for (const kid of item.kids) {
    if (tight && kid.t === 'para') {
      if (kid.task !== undefined) out.push(taskInput(kid.task));
      out.push(inlineHtml(kid.text, refs));
    } else {
      blockHtml(kid, refs, out);
    }
  }
}

// Render one block node into `out`.
function blockHtml(node, refs, out) {
  if (node.t === 'para') {
    out.push('<p>');
    if (node.task !== undefined) out.push(taskInput(node.task));
    out.push(inlineHtml(node.text, refs));
    out.push('</p>\n');
  } else if (node.t === 'head') {
    out.push('<h' + node.level + '>');
    out.push(inlineHtml(node.text, refs));
    out.push('</h' + node.level + '>\n');
  } else if (node.t === 'code') {
    out.push('<pre><code');
    if (node.lang) {
      const word = unescapeSlashes(node.lang).match(/^\S*/)[0];
      if (word !== '') {
        out.push(' class="language-');
        pushEscaped(out, word);
        out.push('"');
      }
    }
    out.push('>');
    pushEscapedStrict(out, node.text);
    out.push('</code></pre>\n');
  } else if (node.t === 'html') {
    out.push(node.text);
  } else if (node.t === 'hr') {
    out.push('<hr>\n');
  } else if (node.t === 'quote') {
    out.push('<blockquote>\n');
    blocksHtml(node.kids, refs, out);
    out.push('</blockquote>\n');
  } else if (node.t === 'list') {
    if (node.ordered) {
      out.push('<ol');
      if (node.start !== 1) out.push(' start="' + node.start + '"');
      out.push('>\n');
    } else {
      out.push('<ul>\n');
    }
    for (const item of node.kids) {
      out.push('<li>');
      itemHtml(item, node.tight, refs, out);
      out.push('</li>\n');
    }
    out.push(node.ordered ? '</ol>\n' : '</ul>\n');
  } else if (node.t === 'table') {
    out.push('<table>\n<thead>\n<tr>\n');
    for (let c = 0; c < node.head.length; c++) {
      const a = node.aligns[c];
      out.push('<th' + (a ? ' align="' + a + '"' : '') + '>');
      out.push(inlineHtml(node.head[c], refs));
      out.push('</th>\n');
    }
    out.push('</tr>\n</thead>\n');
    if (node.rows.length > 0) {
      out.push('<tbody>');
      for (const row of node.rows) {
        out.push('<tr>\n');
        for (let c = 0; c < row.length; c++) {
          const a = node.aligns[c];
          out.push('<td' + (a ? ' align="' + a + '"' : '') + '>');
          out.push(inlineHtml(row[c], refs));
          out.push('</td>\n');
        }
        out.push('</tr>\n');
      }
      out.push('</tbody></table>\n');
    } else {
      out.push('</table>\n');
    }
  }
}

// Render a list of block nodes into `out`.
function blocksHtml(kids, refs, out) {
  for (const kid of kids) blockHtml(kid, refs, out);
}

// Entry point: render Markdown source to marked 18.1.3-compatible HTML.
// Marked leaks its `inLink` lexer state across paragraphs: an inline
// `<a>` opening tag (even self-closing `<a />`) sets it, and only an
// inline `</a>` clears it. While set, GFM bare autolinks (www/http/
// scheme/email) are suppressed; explicit links, angle autolinks and
// images are not. Reset per document in parse().
let inLinkLeak = false;

// Update the leaked `inLink` state for an inline HTML tag string.
function noteHtmlTag(tag) {
  if (tag[1] === '/') {
    if (/^<\/a[\s>]/i.test(tag)) inLinkLeak = false;
  } else if (/^<a[\s/>]/i.test(tag)) {
    inLinkLeak = true;
  }
}

export function parse(src) {
  inLinkLeak = false;
  const text = src.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const refs = new Map();
  const root = buildBlocks(lines, refs);
  const out = [];
  blocksHtml(root.kids, refs, out);
  return out.join('');
}
