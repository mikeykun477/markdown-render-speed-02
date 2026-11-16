// A fast, dependency-free Markdown renderer whose output matches marked 18.1.3
// (GFM defaults) byte for byte. Written from the CommonMark 0.31.2 specification
// and the GFM 0.29 extensions, with the block pass and the inline pass kept
// separate so that link reference definitions can be collected before any inline
// text is rendered. Each call to parse() is independent: no state is shared
// between cases and nothing is cached across them.
//
// Layout of the file:
//   1. small string helpers (escaping, entity decoding, URL cleaning, tabs)
//   2. block parsing: lines -> a tree of block nodes, collecting link refs
//   3. inline parsing: a block's text -> inline nodes, with the CommonMark
//      delimiter-stack algorithm for emphasis, strong emphasis and
//      strikethrough, plus links, images, autolinks, code spans and raw HTML
//   4. rendering: block tree -> the exact HTML string marked produces
//
// The parser works on an array of source lines. A line carries its text plus
// the column at which its content starts in the original document (the "base
// column"). Container prefixes (blockquote markers, list markers) are stripped
// by expanding the tabs of the stripped region into spaces, so a tab that
// follows a container marker expands from its original column -- that is what
// makes fenced code inside a list or a blockquote come out right.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape text for HTML output, encoding every special character. Used for
// code spans, code blocks and attribute values that must not keep entities.
function escapeAll(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const r = ESCAPES[s[i]];
    if (r !== undefined) {
      out += s.slice(start, i) + r;
      start = i + 1;
    }
  }
  return out + s.slice(start);
}

// The character-reference tail that may follow an ampersand for the ampersand
// to be left alone: a numeric reference or a word followed by a semicolon.
const ENTITY_TAIL = /^(?:#\d{1,7}|#[Xx][A-Fa-f0-9]{1,6}|\w+);/;

// Escape text for HTML output, but leave a valid entity reference untouched.
// This is how marked renders ordinary text, link titles and hrefs: "&copy;"
// stays "&copy;", while a bare "&" becomes "&amp;".
function escapeKeepEntities(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      if (ENTITY_TAIL.test(s.slice(i + 1))) continue;
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else {
      const r = ESCAPES[c];
      if (r !== undefined && c !== '&') {
        out += s.slice(start, i) + r;
        start = i + 1;
      }
    }
  }
  return out + s.slice(start);
}

// Decode a numeric character reference body ("35", "x22", "X1F600") to the
// character it stands for. Mirrors the reference behaviour: 0, a value above
// the Unicode range, or a surrogate becomes U+FFFD; 38 decodes to an
// ampersand that is then escaped again.
function decodeNumeric(body) {
  let cp;
  if (body[0] === 'x' || body[0] === 'X') cp = parseInt(body.slice(1), 16);
  else cp = parseInt(body, 10);
  if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
  if (cp === 38) return '&amp;';
  return String.fromCodePoint(cp);
}

// Clean a link destination the way the reference does: run it through
// encodeURI, then turn "%25" back into "%" so a literal percent sign is not
// double-encoded. Returns null when encodeURI throws (a lone surrogate).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

function isSpace(c) { return c === ' ' || c === '\t'; }
function isBlank(s) { return /^[ \t]*$/.test(s); }

// Width in columns of the leading whitespace of `line`, with tabs expanded
// from `baseCol` (the column where the line starts in the original document).
function indentWidth(line, baseCol) {
  let col = baseCol;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { cols: col - baseCol, at: i };
}

// Remove `n` columns of leading indentation from a line, expanding a tab
// that straddles the boundary into the spaces that remain after it. The
// returned string keeps every character past the stripped indent verbatim,
// so tabs inside the content are preserved.
function stripIndent(line, baseCol, n) {
  let col = baseCol;
  let i = 0;
  let out = '';
  while (n > 0 && i < line.length) {
    const c = line[i];
    if (c === ' ') { col++; i++; n--; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (w <= n) { col += w; i++; n -= w; }
      else { out += ' '.repeat(w - n); col += w; i++; n = 0; }
    } else break;
  }
  return out + line.slice(i);
}

// Expand the tabs of a line's leading whitespace into spaces, starting the
// column count at `baseCol`. Used when a container prefix has been stripped:
// the content that follows the prefix keeps its column, so a tab in the
// leading whitespace expands from its original position.
function expandLeadingTabs(line, baseCol) {
  const { cols, at } = indentWidth(line, baseCol);
  if (cols === 0) return line;
  let col = baseCol;
  let out = '';
  let i = 0;
  while (i < at) {
    const c = line[i];
    if (c === ' ') { out += ' '; col++; i++; }
    else { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
  }
  return out + line.slice(at);
}

function collapseWs(s) { return s.replace(/[ \t\r\n]+/g, ' '); }

// Is `c` an ASCII punctuation character (one a backslash can escape)?
function isAsciiPunct(c) {
  const code = c.charCodeAt(0);
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}

// Normalise a link label for lookup: trim, collapse inner whitespace, fold case.
// Unicode case folding maps ẞ/ß to "ss", so fold those explicitly.
function normalizeLabel(s) {
  return collapseWs(s.trim()).toLowerCase().replace(/ß/g, 'ss');
}

// ASCII punctuation, per the CommonMark definition.
function isPunct(c) {
  return c !== undefined && /[!-\/:-@\[-`{-~]/.test(c);
}
const PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

// Unicode letter / number test, used by the emphasis flanking rules.
const ALNUM_RE = /[\p{L}\p{N}]/u;
function isAlnum(c) { return c !== undefined && ALNUM_RE.test(c); }
function isUnicodePunct(c) { return c !== undefined && /[\p{P}\p{S}]/u.test(c); }

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

// A line of source: the text plus the column at which its content starts in
// the original document. Container stripping updates both, so tab expansion
// inside the line always starts from the right column.
function mkLine(s, b) { return { s, b }; }

// Block node kinds:
//   para   { t, text }            raw paragraph text, lines joined by "\n"
//   head   { t, level, text }     ATX or setext heading, inline text
//   code   { t, lang, text }      fenced (lang may be "") or indented code
//   hr     { t }
//   html   { t, text }            raw HTML block, passed through
//   quote  { t, children }
//   list   { t, ordered, start, tight, items:[{task, checked, children}] }
//   table  { t, align, head, rows }  align: "left"|"right"|"center"|null

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK_TAG_RE = new RegExp(`^ {0,3}</?(?:${BLOCK_TAGS})(?:[ \\t]+|\\n|/?>|$)`, 'i');
const HTML_OPEN_RE = /^ {0,3}<(?:script|pre|style|textarea)(?:[ \t>]|$)/i;
const HTML_COMMENT_RE = /^ {0,3}<!--/;
const HTML_PI_RE = /^ {0,3}<\?/;
const HTML_DECL_RE = /^ {0,3}<![A-Za-z]/;
const HTML_CDATA_RE = /^ {0,3}<!\[CDATA\[/;

function lineIndent(l) { return indentWidth(l.s, l.b); }
function lineContent(l) {
  const { at } = indentWidth(l.s, l.b);
  return l.s.slice(at);
}

// Does this line, on its own, start an HTML block? Returns the block type
// (1-7) or 0. Types 1-6 can interrupt a paragraph; type 7 cannot.
function htmlBlockType(l) {
  const s = l.s;
  if (HTML_OPEN_RE.test(s)) return 1;
  if (HTML_COMMENT_RE.test(s)) return 2;
  if (HTML_PI_RE.test(s)) return 3;
  if (HTML_DECL_RE.test(s)) return 4;
  if (HTML_CDATA_RE.test(s)) return 5;
  if (BLOCK_TAG_RE.test(s)) return 6;
  // type 7: a complete open tag, or a complete close tag, on its own line
  if (/^ {0,3}<[a-zA-Z][a-zA-Z0-9-]*(?:[ \t]+[a-zA-Z:_][\w.:-]*(?:[ \t]*=[ \t]*(?:"[^"\n]*"|'[^'\n]*'|[^ \t"'=<>`]+))?)*[ \t]*\/?>[ \t]*$/.test(s)) return 7;
  if (/^ {0,3}<\/[a-zA-Z][a-zA-Z0-9-]*[ \t]*>[ \t]*$/.test(s)) return 7;
  return 0;
}

function isHr(l) {
  const s = l.s;
  let i = 0;
  while (i < s.length && s[i] === ' ') i++;
  if (i > 3) return false;
  const c = s[i];
  if (c !== '-' && c !== '_' && c !== '*') return false;
  let n = 0;
  for (; i < s.length; i++) {
    if (s[i] === c) n++;
    else if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return n >= 3;
}

function atxHeading(l) {
  const s = l.s;
  let i = 0;
  while (i < s.length && s[i] === ' ') i++;
  if (i > 3 || s[i] !== '#') return null;
  let level = 0;
  while (s[i] === '#') { level++; i++; }
  if (level > 6) return null;
  if (i < s.length && s[i] !== ' ' && s[i] !== '\t') return null;
  let text = s.slice(i).replace(/[ \t]+$/, '');
  // A closing sequence of hashes is stripped, if preceded by a space.
  text = text.replace(/[ \t]+#+$/, '').replace(/[ \t]+$/, '');
  return { level, text: text.replace(/^[ \t]+/, '') };
}

function setextUnderline(l) {
  const s = l.s;
  let i = 0;
  while (i < s.length && s[i] === ' ') i++;
  if (i > 3) return 0;
  const c = s[i];
  if (c !== '=' && c !== '-') return 0;
  let j = i;
  while (j < s.length && s[j] === c) j++;
  let k = j;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
  if (k !== s.length) return 0;
  return c === '=' ? 1 : 2;
}

// Fenced code start: returns { marker, len, info } or null.
function fenceStart(l) {
  const s = l.s;
  let i = 0;
  while (i < s.length && s[i] === ' ') i++;
  if (i > 3) return null;
  const c = s[i];
  if (c !== '`' && c !== '~') return null;
  let len = 0;
  while (s[i + len] === c) len++;
  if (len < 3) return null;
  const info = s.slice(i + len);
  if (c === '`' && info.indexOf('`') >= 0) return null;
  return { marker: c, len, info: info.replace(/[ \t]+$/, '') };
}

// Blockquote marker: returns the column just past the marker and one space,
// or -1 when the line does not start a blockquote.
function bqPrefix(l) {
  const s = l.s;
  let i = 0;
  while (i < s.length && s[i] === ' ') i++;
  if (i > 3 || s[i] !== '>') return -1;
  return i + 1;
}

// Strip a blockquote marker from a line, expanding the tabs of the leading
// whitespace from their original columns. Returns the content line, or null
// when the line is not a blockquote line.
function stripBq(l) {
  const s = l.s;
  let i = 0;
  while (i < s.length && s[i] === ' ') i++;
  if (i > 3 || s[i] !== '>') return null;
  let col = l.b + i + 1;
  i++;
  // One optional space (or a tab standing in for it) follows the marker.
  if (i < s.length) {
    if (s[i] === ' ') { i++; col++; }
    else if (s[i] === '\t') {
      const w = 4 - (col % 4);
      const rest = w - 1;
      const content = (rest > 0 ? ' '.repeat(rest) : '') + expandLeadingTabsFrom(s.slice(i + 1), col + w);
      return mkLine(content, col + w);
    }
  }
  return mkLine(expandLeadingTabsFrom(s.slice(i), col), col);
}

// Expand the tabs of a string's leading whitespace from `baseCol`.
function expandLeadingTabsFrom(s, baseCol) {
  let col = baseCol;
  let i = 0;
  let out = '';
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { out += ' '; col++; i++; }
    else if (c === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else break;
  }
  return out + s.slice(i);
}

// Expand the leading whitespace of `s` (spaces/tabs) starting from column
// 0, returning the expanded string. (marked's J(v) with the default start
// column — used for list continuation lines.)
function expandLeadingFrom0(s) {
  let i = 0;
  let col = 0;
  let out = '';
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
    if (s[i] === ' ') { out += ' '; col++; i++; }
    else { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
  }
  return out + s.slice(i);
}

// List marker: marked's list tokenizer. The whitespace after the marker
// expands from the marker's end column (b); the content indent R is the
// expanded whitespace count, but if R > 4 it becomes 1 (so the extra spaces
// stay in the content and can form an indented code block). Returns the
// marker plus the item's first-line content (already expanded and
// R-stripped) and the total content indent (b + R), or null.
function listMarker(l) {
  const s = l.s;
  let i = 0;
  while (i < s.length && s[i] === ' ') i++;
  if (i > 3) return null;
  let ordered = false;
  let start = 0;
  let m = i;
  let delim = '';
  if (s[m] === '-' || s[m] === '+' || s[m] === '*') {
    delim = s[m];
    m++;
  } else if (s[m] >= '0' && s[m] <= '9') {
    let d = 0;
    while (s[m] >= '0' && s[m] <= '9') { d = d * 10 + (s[m].charCodeAt(0) - 48); m++; if (m - i > 9) return null; }
    if (s[m] !== '.' && s[m] !== ')') return null;
    ordered = true;
    start = d;
    delim = s[m];
    m++;
  } else return null;
  // The marker must be followed by whitespace (or be the whole line).
  if (m < s.length && s[m] !== ' ' && s[m] !== '\t') return null;
  const markerLen = m - i;
  const b = i + markerLen; // column where the content whitespace starts
  // Expand the whitespace after the marker from column b.
  let j = m;
  let col = b;
  let spaces = 0;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) {
    if (s[j] === ' ') { spaces++; col++; j++; }
    else { const w = 4 - (col % 4); spaces += w; col += w; j++; }
  }
  const rest = s.slice(j);
  const isEmpty = rest.trim() === '';
  let contentIndent;
  let firstContent;
  if (isEmpty) {
    // A marker alone on a line: the item is empty, content indent is b+1.
    contentIndent = b + 1;
    firstContent = '';
  } else if (spaces === 0) {
    return null;
  } else {
    const R = spaces > 4 ? 1 : spaces;
    firstContent = ' '.repeat(spaces - R) + rest;
    contentIndent = b + R;
  }
  return { ordered, start, markerLen, contentIndent, contentAt: j, markerCol: i, delim, firstContent, isEmpty, markerEndCol: b };
}

// Split a table row on unescaped pipes, trimming cells and dropping the
// outer empty cells that come from a leading or trailing pipe.
function splitCells(row) {
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < row.length) {
    const c = row[i];
    if (c === '\\' && i + 1 < row.length && row[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (c === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += c;
    i++;
  }
  cells.push(cur);
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

// Parse a table delimiter row: returns the alignment array or null.
function tableDelimiter(l) {
  const s = lineContent(l);
  if (s.indexOf('|') < 0) return null;
  const cells = splitCells(s);
  if (cells.length === 0) return null;
  const align = [];
  for (const cell of cells) {
    const m = /^:?-+:?$/.test(cell);
    if (!m) return null;
    if (cell[0] === ':' && cell[cell.length - 1] === ':') align.push('center');
    else if (cell[cell.length - 1] === ':') align.push('right');
    else if (cell[0] === ':') align.push('left');
    else align.push(null);
  }
  return align;
}

// Can this line interrupt a paragraph? (ATX, fence, hr, blockquote, list,
// HTML block types 1-6, table delimiter is handled by the caller.)
function interruptsPara(l) {
  if (isBlank(l.s)) return false;
  if (atxHeading(l) || fenceStart(l) || isHr(l)) return true;
  if (bqPrefix(l) >= 0) return true;
  if (listMarker(l)) return true;
  const ht = htmlBlockType(l);
  if (ht >= 1 && ht <= 6) return true;
  return false;
}

// Parse one link reference definition at `pos` in `text`. Returns
// { label, dest, title, end } (end = index just past the definition, at the
// start of the next line) or null.
function tryLinkRefDef(text, pos) {
  const n = text.length;
  let i = pos;
  // Up to three spaces of indent.
  let sp = 0;
  while (i < n && text[i] === ' ' && sp < 3) { i++; sp++; }
  if (i >= n || text[i] !== '[') return null;
  // The label: up to the first ']', no '[' inside, no blank line, at most
  // 999 characters. (marked does not support nested brackets in labels.)
  let j = i + 1;
  let label = '';
  while (j < n) {
    const c = text[j];
    if (c === '\n') {
      if (text[j + 1] === '\n') return null;
      label += c; j++;
      continue;
    }
    if (c === '\\' && j + 1 < n) { label += text.slice(j, j + 2); j += 2; continue; }
    if (c === '[' || c === ']') break;
    label += c; j++;
  }
  if (j >= n || text[j] !== ']') return null;
  const normLabel = normalizeLabel(label);
  if (normLabel.length === 0 || normLabel.length > 999) return null;
  j++;
  if (j >= n || text[j] !== ':') return null;
  j++;
  // Optional spaces, tabs and a single newline before the destination.
  // A blank line ends the definition.
  while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
  if (j < n && text[j] === '\n') {
    if (j + 1 < n && text[j + 1] === '\n') return null;
    j++;
    while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
  }
  if (j >= n) return null;
  // The destination. A backslash escapes only ASCII punctuation; before
  // any other character it stays literal.
  let dest = '';
  if (text[j] === '<') {
    j++;
    while (j < n && text[j] !== '>' && text[j] !== '\n') {
      if (text[j] === '\\' && j + 1 < n && isAsciiPunct(text[j + 1])) { dest += text[j + 1]; j += 2; continue; }
      dest += text[j];
      j++;
    }
    if (j >= n || text[j] !== '>') return null;
    j++;
  } else {
    let parens = 0;
    while (j < n) {
      const c = text[j];
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
      if (c === '\\' && j + 1 < n && isAsciiPunct(text[j + 1])) { dest += text[j + 1]; j += 2; continue; }
      if (c === '(') parens++;
      else if (c === ')') {
        if (parens === 0) break;
        parens--;
      }
      dest += c;
      j++;
    }
    if (dest.length === 0 || parens !== 0) return null;
  }
  // After the destination, skip spaces/tabs on the same line. A title
  // must be separated from the destination by whitespace.
  let k = j;
  while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
  const hadSpace = k > j;
  // The title may also start on the next line.
  let titleStart = -1;
  if (k < n && text[k] === '\n') {
    let m = k + 1;
    while (m < n && (text[m] === ' ' || text[m] === '\t')) m++;
    if (m < n && (text[m] === '"' || text[m] === "'" || text[m] === '(')) titleStart = m;
  } else if (hadSpace && k < n && (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
    titleStart = k;
  }
  if (titleStart >= 0) {
    const open = text[titleStart];
    const close = open === '(' ? ')' : open;
    let t = '';
    let m = titleStart + 1;
    let ok = false;
    while (m < n) {
      const c = text[m];
      // A title may span lines but may not contain a blank line.
      if (c === '\n' && m + 1 < n && text[m + 1] === '\n') break;
      if (c === '\\' && m + 1 < n && isAsciiPunct(text[m + 1])) { t += text[m + 1]; m += 2; continue; }
      if (c === '\\' && m + 1 < n) { t += text[m]; m++; continue; }
      if (c === close) { ok = true; m++; break; }
      if (c === '\n' && open === '(') break;
      t += c;
      m++;
    }
    if (ok) {
      // Only spaces or tabs may follow the title on its line.
      let e = m;
      while (e < n && (text[e] === ' ' || text[e] === '\t')) e++;
      if (e >= n || text[e] === '\n') {
        if (e < n && text[e] === '\n') e++;
        return { label: normLabel, dest, title: t, end: e };
      }
    }
    // The title is invalid: fall back to a definition without a title,
    // ending at the destination's line end.
  }
  // No title: the destination must be followed only by spaces/tabs and
  // then a newline (or the end of the text).
  let e = j;
  while (e < n && (text[e] === ' ' || text[e] === '\t')) e++;
  if (e < n && text[e] !== '\n') return null;
  if (e < n && text[e] === '\n') e++;
  return { label: normLabel, dest, title: null, end: e };
}

// Scan the whole source for link reference definitions and add them to
// `refs` (first definition for a label wins). This runs before block
// parsing so a link can use a definition that appears later in the
// document. Only definitions at the start of a block are collected (the
// first line, a line after a blank line, or a line after another
// definition); definitions inside fenced code blocks are skipped. The
// definitions are still removed from the output by stripLinkDefs during
// paragraph parsing.
function collectAllRefDefs(src, refs) {
  const n = src.length;
  let pos = 0;
  let prevBlank = true; // the start of the document counts as a blank line
  let fence = null; // the fence marker when inside a fenced code block
  while (pos < n) {
    const lineEnd = src.indexOf('\n', pos);
    const line = lineEnd < 0 ? src.slice(pos) : src.slice(pos, lineEnd);
    const nextPos = lineEnd < 0 ? n : lineEnd + 1;
    if (fence) {
      const trimmed = line.trim();
      if (trimmed.length >= fence.length && /^[`~]+$/.test(trimmed) && trimmed[0] === fence[0]) {
        fence = null;
      }
      prevBlank = false;
      pos = nextPos;
      continue;
    }
    const fenceM = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceM && (fenceM[1][0] === '`' ? !line.slice(fenceM[0].length).includes('`') : true)) {
      fence = fenceM[1];
      prevBlank = false;
      pos = nextPos;
      continue;
    }
    if (prevBlank) {
      let i = pos;
      let sp = 0;
      while (i < n && src[i] === ' ' && sp < 3) { i++; sp++; }
      if (i < n && src[i] === '[') {
        const def = tryLinkRefDef(src, pos);
        if (def) {
          if (!refs.has(def.label)) refs.set(def.label, { href: def.dest, title: def.title });
          pos = def.end;
          prevBlank = true; // a definition is followed by a block start
          continue;
        }
      }
    }
    prevBlank = line.trim() === '';
    pos = nextPos;
  }
}

// Strip leading link reference definitions from a paragraph's text, adding
// them to `refs` (first definition for a label wins). Returns the text that
// remains, or "" when the paragraph held only definitions.
function stripLinkDefs(text, refs) {
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    // Skip blank lines between definitions? No: a blank line ends the run.
    const def = tryLinkRefDef(text, pos);
    if (!def) break;
    if (!refs.has(def.label)) refs.set(def.label, { href: def.dest, title: def.title });
    pos = def.end;
  }
  return text.slice(pos);
}

// Is the last non-blank line of `lines` one that leaves a paragraph open
// (a plain text line, or a container marker whose inner paragraph can be
// continued lazily)? Headings, fences, thematic breaks and HTML blocks close
// a paragraph, so a line after them is not a lazy continuation.
// Do these lines end inside an open fenced code block? A lazy line does
// not continue a fenced code block (it ends the fence and its container),
// so a container's lazy-continuation check must know the fence state.
function endsInFence(lines) {
  let fence = null;
  for (const l of lines) {
    if (fence) {
      const close = fenceStart(l);
      if (close && close.marker === fence.marker && close.len >= fence.len && close.info.trim() === '') {
        fence = null;
      }
      continue;
    }
    const f = fenceStart(l);
    if (f) fence = f;
  }
  return fence !== null;
}

function lastLineLeavesPara(lines) {
  if (endsInFence(lines)) return false;
  for (let k = lines.length - 1; k >= 0; k--) {
    const l = lines[k];
    if (isBlank(l.s)) return false;
    if (atxHeading(l) || fenceStart(l) || isHr(l)) return false;
    if (indentWidth(l.s, l.b).cols >= 4) return false; // indented code
    if (htmlBlockType(l) >= 1 && htmlBlockType(l) <= 6) return false;
    return true;
  }
  return false;
}

// Collect the lines of a blockquote starting at index `i`. Stops at the
// first line that is not a blockquote line and not a lazy continuation.
function collectBlockquote(lines, i) {
  const out = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j];
    const stripped = stripBq(l);
    if (stripped !== null) {
      out.push(stripped);
      j++;
      continue;
    }
    if (isBlank(l.s)) break;
    // Lazy continuation: a paragraph line inside the quote. A lazy `=`
    // setext underline is indented by 4 so it stays paragraph text, not a
    // heading (marked's blockquoteSetextReplace). A `-` underline is also
    // a thematic break, so it ends the quote instead.
    if (setextUnderline(l) === 1 && lastLineLeavesPara(out)) {
      out.push(mkLine('    ' + l.s.replace(/^ {0,3}/, ''), l.b));
      j++;
      continue;
    }
    if (lastLineLeavesPara(out) && !interruptsPara(l)) {
      out.push(l);
      j++;
      continue;
    }
    break;
  }
  return { lines: out, next: j };
}

// Collect the lines of a list item, following marked's list tokenizer.
// The first line's content comes from listMarker (already tab-expanded and
// R-stripped). A continuation line's leading whitespace expands from
// column 0; if its indent is >= R it is a continuation (R columns stripped),
// otherwise it is a lazy continuation (or ends the item). A lazy setext
// underline is indented by 4 so it stays paragraph text, not a heading.
function collectListItem(lines, i, marker, listIndent) {
  const out = [];
  const first = lines[i];
  out.push(mkLine(marker.firstContent, first.b + marker.contentIndent));
  const R = marker.contentIndent;
  let j = i + 1;
  let hadBlank = false;
  let y = marker.isEmpty; // was the last processed line blank?
  while (j < lines.length) {
    const l = lines[j];
    if (isBlank(l.s)) {
      out.push(mkLine('', l.b));
      hadBlank = true;
      y = true;
      j++;
      continue;
    }
    const expanded = expandLeadingFrom0(l.s);
    const idx = expanded.search(/\S/);
    const lind = idx < 0 ? expanded.length : idx;
    if (endsInFence(out)) {
      // Inside a fenced code block: every line is fence content, even one
      // with less indent than the item (a lazy fence line, e.g. doc-02).
      out.push(lind >= R ? mkLine(expanded.slice(R), l.b + R) : mkLine(l.s, l.b));
      y = false;
      j++;
      continue;
    }
    if (lind < R) {
      // Not indented enough: a new item, a new block, or a lazy line.
      const mm = listMarker(l);
      if (mm && lind === listIndent) break; // a new item of this list
      if (interruptsPara(l)) {
        // A lazy `=` setext underline is indented by 4 so it stays
        // paragraph text; a `-` underline is a thematic break and ends
        // the item instead.
        if (setextUnderline(l) === 1 && lastLineLeavesPara(out)) {
          out.push(mkLine('    ' + l.s.replace(/^ {0,3}/, ''), l.b));
          y = false;
          j++;
          continue;
        }
        break;
      }
      // Lazy continuation of the item's paragraph.
      if (y) break; // the item's first line was blank, or a blank line ended it
      if (setextUnderline(l) === 1 && lastLineLeavesPara(out)) {
        out.push(mkLine('    ' + l.s.replace(/^ {0,3}/, ''), l.b));
        y = false;
        j++;
        continue;
      }
      if (lastLineLeavesPara(out)) {
        out.push(l);
        y = false;
        j++;
        continue;
      }
      break;
    }
    // Indented enough: a continuation line; strip R columns.
    out.push(mkLine(expanded.slice(R), l.b + R));
    y = false;
    j++;
  }
  // Trailing blank lines belong to the list, not the item.
  let trailingBlanks = 0;
  while (out.length > 0 && isBlank(out[out.length - 1].s)) { out.pop(); trailingBlanks++; }
  return { lines: out, next: j, hadBlank: hadBlank || trailingBlanks > 0, trailingBlanks };
}

// The same bullet character, or the same ordered delimiter, continues a list.
function sameListMarker(aMarker, bMarker) {
  return aMarker.ordered === bMarker.ordered && aMarker.delim === bMarker.delim;
}

// Parse blocks from `lines` (array of {s, b}), collecting link reference
// definitions into `refs`. `endsWithNL` says the source this level came
// from ended with a newline (only true at the top level). Returns
// {blocks, loose}: `loose` is true when a blank line separates two
// top-level blocks here (used for list tightness).
function parseBlocks(lines, refs, endsWithNL) {
  const blocks = [];
  let loose = false;
  let sawBlank = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i];
    if (isBlank(l.s)) { sawBlank = true; i++; continue; }
    if (sawBlank && blocks.length > 0) loose = true;
    sawBlank = false;
    const ind = indentWidth(l.s, l.b);

    // Indented code block (indent of four or more, not a list/quote line).
    if (ind.cols >= 4) {
      const codeLines = [];
      while (i < n) {
        const cl = lines[i];
        if (isBlank(cl.s)) {
          // A blank line belongs to the code block only if the next
          // non-blank line is still indented code.
          let k = i + 1;
          while (k < n && isBlank(lines[k].s)) k++;
          if (k < n && indentWidth(lines[k].s, lines[k].b).cols >= 4) {
            // A blank line inside a code block keeps its indent minus 4.
            for (let b = i; b < k; b++) codeLines.push(stripIndent(lines[b].s, lines[b].b, 4));
            i = k;
            continue;
          }
          break;
        }
        if (indentWidth(cl.s, cl.b).cols < 4) break;
        codeLines.push(stripIndent(cl.s, cl.b, 4));
        i++;
      }
      let text = codeLines.join('\n');
      if (text.length > 0 && !text.endsWith('\n')) text += '\n';
      blocks.push({ t: 'code', lang: '', text });
      continue;
    }

    // Fenced code block.
    const fence = fenceStart(l);
    if (fence) {
      const info = fence.info;
      const content = [];
      i++;
      while (i < n) {
        const cl = lines[i];
        const close = fenceStart(cl);
        if (close && close.marker === fence.marker && close.len >= fence.len && close.info.trim() === '') {
          i++;
          break;
        }
        // Remove up to the fence's indent from the content line.
        const ci = indentWidth(cl.s, cl.b);
        const strip = Math.min(ci.cols, ind.cols);
        content.push(strip > 0 ? stripIndent(cl.s, cl.b, strip) : cl.s);
        i++;
      }
      let text = content.join('\n');
      if (text.length > 0 && !text.endsWith('\n')) text += '\n';
      // The language is the first word of the info string, with backslash
      // escapes processed (marked processes them in the fences tokenizer).
      const langRaw = info.trim().replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
      const lang = langRaw.split(/[ \t]+/)[0] || '';
      blocks.push({ t: 'code', lang, text, fenced: true });
      continue;
    }

    // ATX heading.
    const atx = atxHeading(l);
    if (atx) {
      blocks.push({ t: 'head', level: atx.level, text: atx.text });
      i++;
      continue;
    }

    // Thematic break.
    if (isHr(l)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }

    // HTML block.
    const ht = htmlBlockType(l);
    if (ht >= 1) {
      const htmlLines = [l.s];
      i++;
      if (ht === 1) {
        // script/pre/style/textarea: runs to the matching close tag. The
        // close tag may already be on the first line.
        const tag = l.s.match(/<(script|pre|style|textarea)/i)[1].toLowerCase();
        const closeRe = new RegExp(`</${tag}[ \\t>]*`, 'i');
        if (!closeRe.test(l.s)) {
          while (i < n && !closeRe.test(lines[i].s)) { htmlLines.push(lines[i].s); i++; }
          if (i < n) { htmlLines.push(lines[i].s); i++; }
        }
      } else if (ht === 2) {
        while (i < n && htmlLines.join('\n').indexOf('-->') < 0) { htmlLines.push(lines[i].s); i++; }
      } else if (ht === 3) {
        while (i < n && htmlLines.join('\n').indexOf('?>') < 0) { htmlLines.push(lines[i].s); i++; }
      } else if (ht === 4) {
        while (i < n && htmlLines.join('\n').indexOf('>') < 0) { htmlLines.push(lines[i].s); i++; }
      } else if (ht === 5) {
        while (i < n && htmlLines.join('\n').indexOf(']]>') < 0) { htmlLines.push(lines[i].s); i++; }
      } else if (ht === 6 || ht === 7) {
        // Runs to a blank line (type 6 block tags, and type 7 complete
        // open/close tags at end-of-line).
        while (i < n && !isBlank(lines[i].s)) { htmlLines.push(lines[i].s); i++; }
      }
      // marked's `ge`: the text keeps a trailing newline exactly when the
      // raw match ends with one — i.e. when the block's last line is
      // followed by a non-blank line, or the block runs to the end of the
      // input and the source ends with one. A following blank line means
      // the raw ends with two newlines, which `ge` strips.
      let htmlText = htmlLines.join('\n');
      if (i < n) {
        if (!isBlank(lines[i].s)) htmlText += '\n';
      } else if (endsWithNL) {
        htmlText += '\n';
      }
      blocks.push({ t: 'html', text: htmlText });
      continue;
    }

    // Blockquote.
    if (bqPrefix(l) >= 0) {
      const { lines: inner, next } = collectBlockquote(lines, i);
      blocks.push({ t: 'quote', children: parseBlocks(inner, refs).blocks });
      i = next;
      continue;
    }

    // List.
    const marker = listMarker(l);
    if (marker) {
      const listIndent = ind.cols;
      const items = [];
      let loose = false;
      while (i < n) {
        const il = lines[i];
        if (isHr(il)) break; // a thematic break ends the list
        const im = listMarker(il);
        if (!im || !sameListMarker(marker, im)) break;
        const { lines: itemLines, next, trailingBlanks } = collectListItem(lines, i, im, listIndent);
        const inner = parseBlocks(itemLines, refs);
        const children = inner.blocks;
        // Task list item: the first paragraph starts with [ ] or [x].
        let task = false;
        let checked = false;
        if (children.length > 0 && children[0].t === 'para') {
          const m = children[0].text.match(/^\[([ xX])\][ \t]+/);
          if (m) {
            task = true;
            checked = m[1] !== ' ';
            children[0].text = children[0].text.slice(m[0].length);
          }
        }
        items.push({ task, checked, children, looseInner: inner.loose, trailingBlanks });
        i = next;
      }
      // A list is loose when any item holds two blocks separated by a blank
      // line, or when two items are separated by a blank line (trailing
      // blanks of a non-last item).
      for (let k = 0; k < items.length; k++) {
        if (items[k].looseInner) { loose = true; break; }
        if (k < items.length - 1 && items[k].trailingBlanks > 0) { loose = true; break; }
      }
      for (const it of items) { delete it.looseInner; delete it.trailingBlanks; }
      blocks.push({ t: 'list', ordered: marker.ordered, start: marker.start, tight: !loose, items });
      continue;
    }

    // Paragraph, setext heading or table. The header line is this line; the
    // next line decides whether it is a setext heading or a table.
    const paraLines = [l.s];
    let j = i + 1;
    let isSetext = 0;
    let tableAlign = null;
    if (j < n) {
      isSetext = setextUnderline(lines[j]);
      if (!isSetext) tableAlign = tableDelimiter(lines[j]);
    }
    if (isSetext) {
      // Link definitions at the start are stripped before the heading
      // forms; if nothing is left, the underline starts a new block.
      const stripped = stripLinkDefs(l.s, refs);
      if (stripped.trim() === '') {
        i = j;
        continue;
      }
      blocks.push({ t: 'head', level: isSetext, text: stripped.trim() });
      i = j + 1;
      continue;
    }
    if (tableAlign) {
      const headCells = splitCells(lineContent(l));
      if (headCells.length === tableAlign.length) {
        const rows = [];
        j++;
        while (j < n) {
          const rl = lines[j];
          if (isBlank(rl.s)) break;
          if (interruptsPara(rl)) break;
          const cells = splitCells(lineContent(rl));
          while (cells.length < headCells.length) cells.push('');
          rows.push(cells.slice(0, headCells.length));
          j++;
        }
        blocks.push({ t: 'table', align: tableAlign, head: headCells, rows });
        i = j;
        continue;
      }
    }
    // Ordinary paragraph: gather lines until a blank line or a block that
    // interrupts a paragraph. A setext underline or a table delimiter on a
    // later line turns the paragraph into a heading or a table instead.
    while (j < n) {
      const pl = lines[j];
      if (isBlank(pl.s)) {
        // A trailing space-only line is part of the paragraph when it is
        // the last line and the source does not end with a newline after
        // it (spec ex. 241: a blockquote's trailing ">  " line).
        if (pl.s.length > 0 && j === n - 1 && !endsWithNL) {
          paraLines.push(pl.s);
          j++;
          continue;
        }
        break;
      }
      // A setext underline takes precedence over a thematic break when it
      // directly follows a paragraph line, so check it first.
      const su = setextUnderline(pl);
      if (su) {
        // Link definitions at the start are stripped before the heading
        // forms; if nothing is left, the underline starts a new block.
        const stripped = stripLinkDefs(paraLines.join('\n'), refs);
        if (stripped.trim() === '') break;
        blocks.push({ t: 'head', level: su, text: stripped.trim() });
        i = j + 1;
        paraLines.length = 0;
        break;
      }
      if (interruptsPara(pl)) break;
      paraLines.push(pl.s);
      j++;
    }
    if (paraLines.length === 0) continue;
    // A paragraph that is only link reference definitions produces no block.
    // A paragraph keeps its leading/trailing spaces (spec ex. 222, 56).
    const text = stripLinkDefs(paraLines.join('\n'), refs);
    if (text.trim() !== '') {
      blocks.push({ t: 'para', text });
    }
    i = j;
  }
  return { blocks, loose };
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Inline node kinds:
//   0 text      { k, s }            plain text, escaped keeping entities
//   1 rawtext   { k, s }            decoded character reference, fully escaped
//   2 delim     { k, ch, n, open, close }   a run of *, _ or ~
//   3 link      { k, href, title, img, children }
//   4 code      { k, s }            code span content
//   5 html      { k, s }            raw HTML tag, passed through
//   6 br        { k }               hard line break
//   7 autolink  { k, href, text }
//   8 em        { k, strong, children }   emphasis / strong / strikethrough

const EMAIL_LOCAL = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&\'*+/=?^_`{|}~-'.split(''));
const SCHEME_RE = /^(?:https?|ftp):\/\//i;
const NUMREF_RE = /^&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;

// Try to match an inline HTML tag at `i`. Returns the tag string or null.
function tryHtmlTag(text, i) {
  const rest = text.slice(i);
  let m;
  if ((m = /^<!--(?:-?>|[\s\S]*?(?:-->|$))/.exec(rest))) return m[0];
  if ((m = /^<\?[\\s\S]*?\?>/.exec(rest))) return m[0];
  if ((m = /^<![A-Za-z]+[\s\S]*?>/.exec(rest))) return m[0];
  if ((m = /^<!\[CDATA\[[\s\S]*?\]\]>/.exec(rest))) return m[0];
  if ((m = /^<\/[a-zA-Z][a-zA-Z0-9-]*[ \t]*>/.exec(rest))) return m[0];
  if ((m = /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/.exec(rest))) return m[0];
  return null;
}

// Try to match an angle-bracket autolink at `i`. Returns { href, text, end }.
function tryAngleAutolink(text, i) {
  if (text[i] !== '<') return null;
  const rest = text.slice(i);
  let m = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^ \x00-\x1f<>]*)>/.exec(rest);
  if (m) return { href: m[1], text: m[1], end: i + m[0].length };
  m = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)>/.exec(rest);
  if (m) return { href: 'mailto:' + m[1], text: m[1], end: i + m[0].length };
  return null;
}

// Trim trailing punctuation and unbalanced parentheses from a candidate
// extended autolink, the way the reference backpedals. `url` is the raw
// candidate; returns the trimmed url.
function backpedalUrl(url) {
  let end = url.length;
  // Drop a trailing entity-like "&word;" (it is not part of the link).
  // Drop trailing punctuation ? ! . , : ; * _ ' " ~ and unmatched ")".
  while (end > 0) {
    const c = url[end - 1];
    if (c === ')') {
      // Keep the paren only when the url holds a matching open paren.
      let opens = 0, closes = 0;
      for (let k = 0; k < end; k++) {
        if (url[k] === '(') opens++;
        else if (url[k] === ')') closes++;
      }
      if (closes <= opens) break;
      end--;
      continue;
    }
    if (c === '?' || c === '!' || c === '.' || c === ',' || c === ':' || c === ';' || c === '*' || c === '_' || c === "'" || c === '"' || c === '~') { end--; continue; }
    break;
  }
  // A trailing "&word;" is not part of the link.
  const amp = url.lastIndexOf('&', end - 1);
  if (amp >= 0) {
    const tail = url.slice(amp, end);
    if (/^&[a-zA-Z0-9]+;$/.test(tail)) end = amp;
  }
  return url.slice(0, end);
}

// Try to match an extended autolink (www., scheme:// or email) at `i`.
// Returns { href, text, end } or null. Only called when not inside a link.
function tryExtendedAutolink(text, i, end) {
  const rest = text.slice(i, end);
  // www. -- the preceding character must be a start, whitespace, *, _, ~
  // or (, or the match is not an autolink.
  if (rest.startsWith('www.')) {
    const prev = i > 0 ? text[i - 1] : '';
    if (i > 0 && !(prev === ' ' || prev === '\t' || prev === '\n' || prev === '*' || prev === '_' || prev === '~' || prev === '(')) return null;
    const m = /^www\.(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/.exec(rest);
    if (!m) return null;
    const url = backpedalUrl(m[0]);
    if (url.length <= 4) return null;
    return { href: 'http://' + url, text: url, end: i + url.length };
  }
  // scheme:// -- http, https or ftp, case-insensitive.
  const sm = SCHEME_RE.exec(rest);
  if (sm) {
    const m = /^(?:https?|ftp):\/\/(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/i.exec(rest);
    if (!m) return null;
    const url = backpedalUrl(m[0]);
    return { href: url, text: url, end: i + url.length };
  }
  return null;
}

// Try to match an email autolink ending at the "@" at position `at`.
// Returns { href, text, start, end } or null.
function tryEmailAt(text, at, end) {
  // Scan back over the local part.
  let s = at;
  while (s > 0 && EMAIL_LOCAL.has(text[s - 1])) s--;
  if (s === at) return null;
  const local = text.slice(s, at);
  const rest = text.slice(at + 1, end);
  const m = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/.exec(rest);
  if (!m) return null;
  const after = at + 1 + m[0].length;
  if (after < end && /[\w-]/.test(text[after])) return null;
  const email = local + '@' + m[0];
  return { href: 'mailto:' + email, text: email, start: s, end: after };
}

// Scan a code span starting at the backtick run at `i`. Returns
// { content, end } or null when there is no closing run. The opening run
// must start a backtick run (not be mid-run), and the closing run must be
// a run of exactly the same length (not part of a longer run on either side).
function tryCodeSpan(text, i, end) {
  if (i > 0 && text[i - 1] === '`') return null;
  let n = 0;
  while (i + n < end && text[i + n] === '`') n++;
  const close = '`'.repeat(n);
  let j = i + n;
  while (j < end) {
    const k = text.indexOf(close, j);
    if (k < 0) return null;
    // The closing run must not be part of a longer run on either side.
    if ((k > i + n && text[k - 1] === '`') || (k + n < end && text[k + n] === '`')) { j = k + 1; continue; }
    let content = text.slice(i + n, k);
    content = content.replace(/\n/g, ' ');
    if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
      content = content.slice(1, -1);
    }
    return { content, end: k + n };
  }
  return null;
}

// Flanking helpers for the emphasis delimiter rules. `before` is the
// character before the run (or ""), `after` the character after it.
function flanking(before, after) {
  const beforeWs = before === '' || before === ' ' || before === '\t' || before === '\n' || before === '\r';
  const afterWs = after === '' || after === ' ' || after === '\t' || after === '\n' || after === '\r';
  const beforePunct = isUnicodePunct(before);
  const afterPunct = isUnicodePunct(after);
  const left = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const right = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return { left, right };
}

// Scan a link label starting at `i` (text[i] === "["). Returns
// { label, end } where end is just past the closing "]", or null.
function scanLabel(text, i, end) {
  let depth = 0;
  let j = i + 1;
  while (j < end) {
    const c = text[j];
    if (c === '\n') {
      if (j + 1 < end && text[j + 1] === '\n') return null;
      j++;
      continue;
    }
    if (c === '\\' && j + 1 < end) { j += 2; continue; }
    if (c === '`') {
      const cs = tryCodeSpan(text, j, end);
      if (cs) { j = cs.end; continue; }
      j++;
      continue;
    }
    if (c === '[') { depth++; j++; continue; }
    if (c === ']') {
      if (depth === 0) return { label: text.slice(i + 1, j), end: j + 1 };
      depth--;
      j++;
      continue;
    }
    j++;
  }
  return null;
}

// Parse a link destination and optional title starting at `i` (just after
// the "("). Returns { href, title, end } (end just past ")") or null.
function parseInlineDestTitle(text, i, end) {
  let j = i;
  while (j < end && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
  if (j >= end) return null;
  let href = '';
  if (text[j] === '<') {
    j++;
    while (j < end && text[j] !== '>' && text[j] !== '\n') {
      if (text[j] === '\\' && j + 1 < end) { href += text[j + 1]; j += 2; continue; }
      href += text[j];
      j++;
    }
    if (j >= end || text[j] !== '>') return null;
    j++;
  } else {
    let parens = 0;
    while (j < end) {
      const c = text[j];
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
      if (c === '\\' && j + 1 < end) { href += text[j + 1]; j += 2; continue; }
      if (c === '(') parens++;
      else if (c === ')') {
        if (parens === 0) break;
        parens--;
      }
      href += c;
      j++;
    }
    if (parens !== 0) return null;
  }
  // Optional whitespace/newlines, then an optional title.
  let k = j;
  while (k < end && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
  let title = null;
  if (k < end && (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
    const open = text[k];
    const close = open === '(' ? ')' : open;
    let t = '';
    let m = k + 1;
    let ok = false;
    while (m < end) {
      const c = text[m];
      if (c === '\\' && m + 1 < end) { t += text[m + 1]; m += 2; continue; }
      if (c === close) { ok = true; m++; break; }
      if (c === '\n' && open === '(') break;
      t += c;
      m++;
    }
    if (!ok) return null;
    title = t;
    j = m;
    while (j < end && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
  }
  if (j >= end || text[j] !== ')') return null;
  return { href, title, end: j + 1 };
}

// The "Be" check: does the label hold a "<" that opens a tag or autolink
// reaching past the label's end? If so the link is not a link.
function labelHasRunawayTag(text, labelStart, label) {
  if (label.indexOf('<') < 0) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const cs = tryCodeSpan(label, s, label.length);
      if (cs) { s = cs.end - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const abs = labelStart + s;
    const tag = tryHtmlTag(text, abs);
    const auto = tag ? null : tryAngleAutolink(text, abs);
    const match = tag || (auto ? text.slice(abs, auto.end) : null);
    if (match && match.length > label.length - s) return true;
    if (match) s += match.length - 1;
  }
  return false;
}

// Try to parse a link or image starting at `i` (text[i] is "[" or "!"+"[").
// Returns { node, end } or null. `state` carries inLink / linkEmitted.
function tryLink(text, i, end, refs, state) {
  let img = false;
  let p = i;
  if (text[p] === '!') { img = true; p++; }
  if (p >= end || text[p] !== '[') return null;
  const scanned = scanLabel(text, p, end);
  if (!scanned) return null;
  const { label, end: afterLabel } = scanned;
  let href = null;
  let title = null;
  let after = afterLabel;
  if (after < end && text[after] === '(') {
    const dt = parseInlineDestTitle(text, after + 1, end);
    if (!dt) return null;
    href = dt.href;
    title = dt.title;
    after = dt.end;
  } else if (after < end && text[after] === '[') {
    const ref = scanLabel(text, after, end);
    if (!ref) return null;
    const key = ref.label === '' ? normalizeLabel(label) : normalizeLabel(ref.label);
    const found = refs.get(key);
    if (!found) return null;
    href = found.href;
    title = found.title;
    after = ref.end;
  } else {
    const found = refs.get(normalizeLabel(label));
    if (!found) return null;
    href = found.href;
    title = found.title;
  }
  // The label may not hold a link (unless this is an image), and may not
  // hold a tag that runs past its end.
  if (labelHasRunawayTag(text, p + 1, label)) return null;
  const savedInLink = state.inLink;
  const savedEmitted = state.linkEmitted;
  state.inLink = true;
  state.linkEmitted = false;
  const children = scanInline(label, 0, label.length, refs, state);
  const emitted = state.linkEmitted;
  state.inLink = savedInLink;
  state.linkEmitted = savedEmitted;
  if (!img) {
    if (emitted) return null;
    state.linkEmitted = true;
  }
  return { node: { k: 3, href, title, img, children }, end: after };
}

// Resolve emphasis, strong emphasis and strikethrough over the node list,
// using the CommonMark delimiter-stack algorithm.
function resolveEmphasis(nodes, stack) {
  let i = 0;
  while (i < stack.length) {
    const closer = stack[i];
    if (!closer.close || closer.n === 0) { i++; continue; }
    let oi = -1;
    for (let j = i - 1; j >= 0; j--) {
      const op = stack[j];
      if (op.ch !== closer.ch || !op.open || op.n === 0) continue;
      // Skip an opener already folded into an emphasis node (it is no
      // longer a top-level node, so it cannot pair across the boundary).
      if (nodes.indexOf(op) < 0) continue;
      if ((op.open && op.close) || (closer.open && closer.close)) {
        const sum = op.n + closer.n;
        if (sum % 3 === 0 && !(op.n % 3 === 0 && closer.n % 3 === 0)) continue;
      }
      oi = j;
      break;
    }
    if (oi < 0) { i++; continue; }
    const opener = stack[oi];
    const use = opener.n >= 2 && closer.n >= 2 ? 2 : 1;
    const oiPos = nodes.indexOf(opener);
    const ciPos = nodes.indexOf(closer);
    // Both must still be top-level nodes; if either was already folded
    // into an emphasis node, skip this pairing.
    if (oiPos < 0 || ciPos < 0 || ciPos <= oiPos) { i++; continue; }
    const children = nodes.slice(oiPos + 1, ciPos);
    const emNode = { k: 8, strong: use === 2, ch: closer.ch, children };
    opener.n -= use;
    closer.n -= use;
    const replacement = [];
    if (opener.n > 0) replacement.push(opener);
    replacement.push(emNode);
    if (closer.n > 0) replacement.push(closer);
    nodes.splice(oiPos, ciPos - oiPos + 1, ...replacement);
    if (opener.n === 0) stack.splice(oi, 1);
    if (closer.n === 0) {
      const ci = stack.indexOf(closer);
      if (ci >= 0) stack.splice(ci, 1);
      i = ci >= 0 ? ci : i;
      if (i < 0) i = 0;
    } else {
      i = stack.indexOf(closer);
    }
  }
}

// Scan inline content in text[start..end), returning the node list with
// emphasis resolved. `state` carries the inLink / linkEmitted flags.
function scanInline(text, start, end, refs, state) {
  const nodes = [];
  const stack = [];
  let i = start;
  let ts = start;
  const flush = (to) => {
    if (to > ts) nodes.push({ k: 0, s: text.slice(ts, to) });
    ts = to;
  };
  while (i < end) {
    const c = text[i];
    if (c === '\\') {
      if (i + 1 < end && text[i + 1] === '\n') {
        flush(i);
        nodes.push({ k: 6 });
        i += 2;
        // A hard break drops the next line's leading spaces/tabs.
        while (i < end && (text[i] === ' ' || text[i] === '\t')) i++;
        ts = i;
        continue;
      }
      if (i + 1 < end && PUNCT.has(text[i + 1])) {
        flush(i);
        nodes.push({ k: 0, s: text[i + 1] });
        i += 2; ts = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '`') {
      const cs = tryCodeSpan(text, i, end);
      if (cs) {
        flush(i);
        nodes.push({ k: 4, s: cs.content });
        i = cs.end; ts = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '<') {
      const auto = tryAngleAutolink(text, i);
      if (auto) {
        flush(i);
        nodes.push({ k: 7, href: auto.href, text: auto.text });
        i = auto.end; ts = i;
        continue;
      }
      const tag = tryHtmlTag(text, i);
      if (tag) {
        flush(i);
        if (/^<a[ \t]/i.test(tag)) state.inLink = true;
        else if (/^<\/a[ \t>]/i.test(tag)) state.inLink = false;
        nodes.push({ k: 5, s: tag });
        i += tag.length; ts = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '&') {
      const m = NUMREF_RE.exec(text.slice(i, end));
      if (m) {
        flush(i);
        nodes.push({ k: 1, s: decodeNumeric(m[1] !== undefined ? m[1] : 'x' + m[2]) });
        i += m[0].length; ts = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '\n') {
      let sp = 0;
      let j = i - 1;
      while (j >= ts && text[j] === ' ') { sp++; j--; }
      if (sp >= 2) {
        flush(i - sp);
        nodes.push({ k: 6 });
        i++;
        // A hard break drops the next line's leading spaces/tabs.
        while (i < end && (text[i] === ' ' || text[i] === '\t')) i++;
        ts = i;
        continue;
      }
      // Soft break: the newline is kept and the next line's leading
      // spaces are part of the paragraph text (spec ex. 222, 223).
      i++;
      continue;
    }
    if (c === '[' || (c === '!' && i + 1 < end && text[i + 1] === '[')) {
      const res = tryLink(text, i, end, refs, state);
      if (res) {
        flush(i);
        nodes.push(res.node);
        i = res.end; ts = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      // A tilde run is split into chunks of at most two; * and _ runs are
      // one delimiter node each. A run of three or more tildes is literal
      // text, never a strikethrough delimiter (GFM: `~~~not~~~` stays).
      if (c === '~') {
        let n = 0;
        while (i + n < end && text[i + n] === '~') n++;
        if (n >= 3) { i += n; continue; }
        let done = 0;
        while (done < n) {
          const chunk = Math.min(2, n - done);
          const before = i + done > 0 ? text[i + done - 1] : '';
          const after = i + done + chunk < end ? text[i + done + chunk] : '';
          const { left, right } = flanking(before, after);
          flush(i + done);
          const node = { k: 2, ch: '~', n: chunk, open: left, close: right };
          nodes.push(node);
          if (node.open || node.close) stack.push(node);
          done += chunk;
          ts = i + done;
        }
        i += n;
        continue;
      }
      let n = 0;
      while (i + n < end && text[i + n] === c) n++;
      const before = i > 0 ? text[i - 1] : '';
      const after = i + n < end ? text[i + n] : '';
      const { left, right } = flanking(before, after);
      let open;
      let close;
      if (c === '_') {
        open = left && (!right || isUnicodePunct(before));
        close = right && (!left || isUnicodePunct(after));
      } else {
        open = left;
        close = right;
      }
      flush(i);
      const node = { k: 2, ch: c, n, open, close };
      nodes.push(node);
      if (open || close) stack.push(node);
      i += n; ts = i;
      continue;
    }
    if (!state.inLink) {
      if (c === 'w' && text.startsWith('www.', i)) {
        const res = tryExtendedAutolink(text, i, end);
        if (res) {
          flush(i);
          nodes.push({ k: 7, href: res.href, text: res.text });
          i = res.end; ts = i;
          continue;
        }
      }
      if (c === 'h' || c === 'H' || c === 'f' || c === 'F') {
        const res = tryExtendedAutolink(text, i, end);
        if (res) {
          flush(i);
          nodes.push({ k: 7, href: res.href, text: res.text });
          i = res.end; ts = i;
          continue;
        }
      }
      if (c === '@') {
        const res = tryEmailAt(text, i, end);
        if (res) {
          flush(res.start);
          nodes.push({ k: 7, href: res.href, text: res.text });
          i = res.end; ts = i;
          continue;
        }
      }
    }
    i++;
  }
  flush(end);
  resolveEmphasis(nodes, stack);
  return nodes;
}

// The plain text of an inline node list, for image alt attributes.
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 0 || nd.k === 1) out += nd.s;
    else if (nd.k === 2) out += nd.ch.repeat(nd.n);
    else if (nd.k === 3) out += plainText(nd.children);
    else if (nd.k === 4) out += nd.s;
    else if (nd.k === 7) out += nd.text;
    else if (nd.k === 8) out += plainText(nd.children);
  }
  return out;
}

// Render an inline node list to HTML.
function renderInline(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 0) out += escapeKeepEntities(nd.s);
    else if (nd.k === 1) out += escapeAll(nd.s);
    else if (nd.k === 2) out += nd.ch.repeat(nd.n);
    else if (nd.k === 3) {
      const href = cleanUrl(nd.href);
      if (nd.img) {
        const alt = escapeAll(plainText(nd.children));
        out += `<img src="${escapeKeepEntities(href === null ? nd.href : href)}" alt="${alt}"${nd.title != null ? ` title="${escapeKeepEntities(nd.title)}"` : ''}>`;
      } else if (href === null) {
        out += renderInline(nd.children);
      } else {
        out += `<a href="${escapeKeepEntities(href)}"${nd.title != null ? ` title="${escapeKeepEntities(nd.title)}"` : ''}>${renderInline(nd.children)}</a>`;
      }
    }
    else if (nd.k === 4) out += `<code>${escapeAll(nd.s)}</code>`;
    else if (nd.k === 5) out += nd.s;
    else if (nd.k === 6) out += '<br>';
    else if (nd.k === 7) {
      const href = cleanUrl(nd.href);
      out += `<a href="${escapeKeepEntities(href === null ? nd.href : href)}">${escapeKeepEntities(nd.text)}</a>`;
    }
    else if (nd.k === 8) {
      const tag = nd.ch === '~' ? 'del' : nd.strong ? 'strong' : 'em';
      out += `<${tag}>${renderInline(nd.children)}</${tag}>`;
    }
  }
  return out;
}

// Render one block (and its children) to HTML. `refs` holds the link
// reference definitions gathered during block parsing.
function renderBlock(b, refs, state) {
  switch (b.t) {
    case 'para': {
      return `<p>${renderInline(scanInline(b.text, 0, b.text.length, refs, state))}</p>\n`;
    }
    case 'head': {
      return `<h${b.level}>${renderInline(scanInline(b.text, 0, b.text.length, refs, state))}</h${b.level}>\n`;
    }
    case 'code': {
      const lang = b.lang ? ` class="language-${escapeKeepEntities(b.lang)}"` : '';
      return `<pre><code${lang}>${escapeAll(b.text)}</code></pre>\n`;
    }
    case 'hr':
      return '<hr>\n';
    case 'html':
      // The text already carries its trailing newline (if any) per `ge`.
      return b.text;
    case 'quote': {
      let inner = '';
      for (const c of b.children) inner += renderBlock(c, refs, state);
      return `<blockquote>\n${inner}</blockquote>\n`;
    }
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
      let out = `<${tag}${start}>\n`;
      for (const it of b.items) {
        let inner = '';
        const kids = it.children;
        if (b.tight) {
          // In a tight list every paragraph renders inline (no <p> tags),
          // whether or not it is the item's first child.
          for (const c of kids) {
            if (c.t === 'para') {
              inner += renderInline(scanInline(c.text, 0, c.text.length, refs, state));
            } else {
              inner += renderBlock(c, refs, state);
            }
          }
        } else {
          for (const c of kids) inner += renderBlock(c, refs, state);
        }
        const box = it.task
          ? `<input ${it.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `
          : '';
        if (box && !b.tight && kids.length > 0 && kids[0].t === 'para') {
          // Loose list: the checkbox sits inside the first paragraph's
          // <p> tag, right after it opens.
          inner = '<p>' + box + inner.slice(3);
        } else if (box) {
          inner = box + inner;
        }
        out += `<li>${inner}</li>\n`;
      }
      return out + `</${tag}>\n`;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < b.head.length; c++) {
        const a = b.align[c];
        out += `<th${a ? ` align="${a}"` : ''}>${renderInline(scanInline(b.head[c], 0, b.head[c].length, refs, state))}</th>\n`;
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length > 0) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let c = 0; c < row.length; c++) {
            const a = b.align[c];
                out += `<td${a ? ` align="${a}"` : ''}>${renderInline(scanInline(row[c], 0, row[c].length, refs, state))}</td>\n`;
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

// Render Markdown to the HTML marked 18.1.3 produces for it.
export function parse(markdown) {
  const src = markdown.replace(/\r\n?/g, '\n');
  const rawLines = src.split('\n');
  // A trailing newline makes a final empty line; drop it (it is not a line).
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const lines = rawLines.map((s) => mkLine(s, 0));
  const refs = new Map();
  // Pre-pass: collect every link reference definition in the document, so
  // a link can use a definition that appears after it (spec ex. 204).
  collectAllRefDefs(src, refs);
  const blocks = parseBlocks(lines, refs, src.endsWith('\n')).blocks;
  // One shared inline state for the whole document: marked keeps
  // `inLink` across paragraphs, so an unclosed <a> tag suppresses
  // extended autolinks in later paragraphs too.
  const state = { inLink: false, linkEmitted: false };
  let out = '';
  for (const b of blocks) out += renderBlock(b, refs, state);
  return out;
}
