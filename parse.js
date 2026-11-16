// parse.js — hand-built Markdown -> HTML, byte-identical to marked 18.1.3
// (CommonMark 0.31.2 + GFM 0.29, default options). No dependencies.
// Written from the CommonMark spec + black-box behaviour of the reference
// renderer; no vendored code, no hardcoded case outputs, no cross-case cache.

// Document-global GFM autolink suppression (marked quirk): once an inline
// `<a` open tag that contains a space (i.e. has attributes) appears,
// marked stops producing bare-email / extended-URL / www autolinks until
// an inline `</a>` (exactly, lowercase) appears (explicit `<...>`
// autolinks and markdown links are unaffected). A bare `<a>`, one with
// only tab/newline separators, or an `<a>` that is an HTML block does not
// trigger it. Reset per parse().
let noAutolink = false;

export function parse(markdown) {
  const src = markdown.indexOf('\r') === -1 ? markdown : markdown.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  // A trailing empty line from a final newline is not a real line.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const refs = Object.create(null);
  noAutolink = false;
  const doc = parseBlocks(lines, refs);
  let out = renderBlocks(doc.children, refs);
  // An HTML block that is the document's last block keeps a trailing
  // newline, but only when the source itself ends with one (gfm-657:
  // input ending `</blockquote>` with no newline renders no trailing `\n`).
  const last = doc.children[doc.children.length - 1];
  if (last && last.t === 'html' && src.endsWith('\n')) out += '\n';
  return out;
}

// ---------------------------------------------------------------------------
// Character classes (CommonMark: ASCII punct + Unicode P/S for punctuation;
// whitespace = space, tab, LF, FF, CR + Unicode space separators)
// ---------------------------------------------------------------------------

function isSpaceCh(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
}
function isDigitCh(c) {
  return c >= 48 && c <= 57;
}
function isAlphaCh(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isAlnumCh(c) {
  return isAlphaCh(c) || isDigitCh(c);
}
function isPunctAscii(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
const PUNCT_NONASCII = /[\p{P}\p{S}]/u;
const SPACE_NONASCII = /\s/;
function isPunctCh(s, i) {
  const c = s.charCodeAt(i);
  if (c < 128) return isPunctAscii(c);
  return PUNCT_NONASCII.test(s[i]);
}
function isSpaceCode(c) {
  if (c < 128) return isSpaceCh(c);
  return c === 0x85 || c === 0xa0 || (c >= 0x1680 && c <= 0x200a && c !== 0x2007 && c !== 0x202f) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}
function isWhitespaceStr(s, i) {
  const c = s.charCodeAt(i);
  if (c < 128) return isSpaceCh(c);
  return SPACE_NONASCII.test(s[i]);
}

// ---------------------------------------------------------------------------
// Escaping. marked escapes & < > " ' in text, but leaves a valid character
// reference (&name; / &#123; / &#x1f;) untouched; it never decodes named
// references. Code spans escape every &.
// ---------------------------------------------------------------------------

// Returns the index just past a valid entity reference starting at s[i]=='&',
// or 0 when there is none. Named: & + [A-Za-z0-9_]+ + ';'. Numeric: &# + 1-7
// digits + ';' or &#[xX] + 1-6 hex + ';'.
function entityEnd(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return 0;
  const c = s.charCodeAt(j);
  if (c === 35) {
    j++;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
      j++;
      const start = j;
      while (j < n && j - start < 6) {
        const h = s.charCodeAt(j);
        if (!((h >= 48 && h <= 57) || (h >= 97 && h <= 102) || (h >= 65 && h <= 70))) break;
        j++;
      }
      if (j > start && j < n && s.charCodeAt(j) === 59) return j + 1;
      return 0;
    }
    const start = j;
    while (j < n && j - start < 7 && isDigitCh(s.charCodeAt(j))) j++;
    if (j > start && j < n && s.charCodeAt(j) === 59) return j + 1;
    return 0;
  }
  const start = j;
  while (j < n) {
    const w = s.charCodeAt(j);
    if (!((w >= 48 && w <= 57) || (w >= 65 && w <= 90) || (w >= 97 && w <= 122) || w === 95)) break;
    j++;
  }
  if (j > start && j < n && s.charCodeAt(j) === 59) return j + 1;
  return 0;
}

// Decode a numeric character reference starting at s[i]=='&' (already known
// to be &#...; or &#[xX]...;). Returns {ch, end} or null when not a valid
// numeric reference (wrong length / bad digits).
function decodeNumeric(s, i) {
  const n = s.length;
  let j = i + 2;
  let hex = false;
  if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
  const start = j;
  let v = 0;
  if (hex) {
    while (j < n && j - start < 6) {
      const h = s.charCodeAt(j);
      let d;
      if (h >= 48 && h <= 57) d = h - 48;
      else if (h >= 97 && h <= 102) d = h - 87;
      else if (h >= 65 && h <= 70) d = h - 55;
      else break;
      v = v * 16 + d;
      j++;
    }
  } else {
    while (j < n && j - start < 7 && isDigitCh(s.charCodeAt(j))) {
      v = v * 10 + (s.charCodeAt(j) - 48);
      j++;
    }
  }
  if (j === start || j >= n || s.charCodeAt(j) !== 59) return null;
  let ch;
  if (v === 0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) ch = '\uFFFD';
  else ch = String.fromCodePoint(v);
  return { ch, end: j + 1 };
}

function escText(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  let last = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const e = entityEnd(s, i);
      if (e > 0) { i = e - 1; continue; }
      out += s.slice(last, i) + '&amp;';
      last = i + 1;
    } else if (c === 60) {
      out += s.slice(last, i) + '&lt;';
      last = i + 1;
    } else if (c === 62) {
      out += s.slice(last, i) + '&gt;';
      last = i + 1;
    } else if (c === 34) {
      out += s.slice(last, i) + '&quot;';
      last = i + 1;
    } else if (c === 39) {
      out += s.slice(last, i) + '&#39;';
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

function escDumb(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  let last = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      out += s.slice(last, i) + '&amp;';
      last = i + 1;
    } else if (c === 60) {
      out += s.slice(last, i) + '&lt;';
      last = i + 1;
    } else if (c === 62) {
      out += s.slice(last, i) + '&gt;';
      last = i + 1;
    } else if (c === 34) {
      out += s.slice(last, i) + '&quot;';
      last = i + 1;
    } else if (c === 39) {
      out += s.slice(last, i) + '&#39;';
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

// A link destination: percent-encode (encodeURI) then escape for an attribute.
function cleanUrl(href) {
  // encodeURI would double-encode existing %XX sequences and would encode
  // a bare '%' to %25, but marked keeps both as-is. Split on valid %XX
  // first, then on bare '%', encode only the other segments.
  const parts = href.split(/(%[0-9A-Fa-f]{2})/g);
  let enc = '';
  for (const p of parts) {
    if (/^%[0-9A-Fa-f]{2}$/.test(p)) { enc += p; continue; }
    const segs = p.split('%');
    for (let k = 0; k < segs.length; k++) {
      if (k > 0) enc += '%';
      try { enc += encodeURI(segs[k]); } catch (_e) { enc += segs[k]; }
    }
  }
  return escText(enc);
}

// Normalize a link label for lookup: collapse whitespace runs to one space,
// trim, lowercase.
function normalizeLabel(s) {
  let out = '';
  let lastSpace = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) {
      if (!lastSpace) { out += ' '; lastSpace = true; }
    } else {
      // Unicode case folding: sharp S (capital ẞ and small ß) folds to "ss".
      if (c === 0x1E9E || c === 0x00DF) { out += 'ss'; lastSpace = false; continue; }
      out += s[i];
      lastSpace = false;
    }
  }
  if (lastSpace && out.length) out = out.slice(0, -1);
  return out.toLowerCase();
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------
// Node types: 0 text {a,b} (source span, escText) | 1 raw {s} (pre-escaped,
// verbatim) | 2 code {s} (escDumb) | 3 html {s} (verbatim) | 4 br |
// 5 link {href,title,ch} | 6 image {src,title,alt} | 7 autolink {href,text} |
// 8 em {ch} | 9 strong {ch} | 10 del {ch}
const T_TEXT = 0, T_RAW = 1, T_CODE = 2, T_HTML = 3, T_BR = 4,
      T_LINK = 5, T_IMG = 6, T_AUTO = 7, T_EM = 8, T_STRONG = 9, T_DEL = 10;

// Delimiter entry: {ch, len, orig, canOpen, canClose, node, dead}
// Bracket entry: {node, idx, pos, image, active, dstart}

const BACKPEDAL = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const BARE_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/y;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/;
const EMAIL_LOCAL = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@/;

function backpedalUrl(u) {
  let prev;
  do {
    prev = u;
    const m = BACKPEDAL.exec(u);
    u = m ? m[0] : '';
  } while (u !== prev);
  return u;
}

// Parse a link destination starting at src[i] (after '(' + whitespace, or at
// the start of a ref-def dest). Returns {dest, end} or null. Escapes resolved.
function parseLinkDest(src, i) {
  const n = src.length;
  if (i >= n) return null;
  if (src.charCodeAt(i) === 60) {
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 62) return { dest: out, end: j + 1 };
      if (c === 10 || c === 60) return null;
      if (c === 92 && j + 1 < n && isPunctAscii(src.charCodeAt(j + 1))) { out += src[j + 1]; j += 2; continue; }
      out += src[j];
      j++;
    }
    return null;
  }
  let j = i;
  let out = '';
  let parens = 0;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) break;
    if (c === 40) { parens++; out += '('; j++; continue; }
    if (c === 41) {
      if (parens === 0) break;
      parens--; out += ')'; j++; continue;
    }
    if (c === 92 && j + 1 < n && isPunctAscii(src.charCodeAt(j + 1))) { out += src[j + 1]; j += 2; continue; }
    if (c < 32) return null;
    out += src[j];
    j++;
  }
  return { dest: out, end: j };
}

// Parse a link title starting at src[i] ('"' or "'" or '('). Escapes resolved.
function parseLinkTitle(src, i) {
  const n = src.length;
  const q = src.charCodeAt(i);
  let close;
  if (q === 34) close = 34;
  else if (q === 39) close = 39;
  else if (q === 40) close = 41;
  else return null;
  let j = i + 1;
  let out = '';
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === close) return { title: out, end: j + 1 };
    if (c === 92 && j + 1 < n && isPunctAscii(src.charCodeAt(j + 1))) { out += src[j + 1]; j += 2; continue; }
    out += src[j];
    j++;
  }
  return null;
}

// Skip spaces/tabs/newlines from src[i]; returns the new index.
function skipWs(src, i) {
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) i++;
    else break;
  }
  return i;
}

// <...> autolink or email autolink starting at src[i]=='<'. Returns
// {href, text, end} (href/text already attribute-escaped) or null.
function matchAutolink(src, i) {
  const n = src.length;
  let j = i + 1;
  // scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}: then non-space, non-<, non-> chars
  if (j < n && isAlphaCh(src.charCodeAt(j))) {
    let k = j + 1;
    while (k < n && k - j < 32) {
      const c = src.charCodeAt(k);
      if (isAlnumCh(c) || c === 43 || c === 46 || c === 45) k++;
      else break;
    }
    if (k < n && src.charCodeAt(k) === 58 && k - j >= 2) {
      let e = k + 1;
      while (e < n) {
        const c = src.charCodeAt(e);
        if (c === 32 || c === 9 || c === 10 || c === 60 || c === 62) break;
        e++;
      }
      if (e < n && src.charCodeAt(e) === 62 && e > k + 1) {
        const url = src.slice(i + 1, e);
        return { href: cleanUrl(url), text: url, end: e + 1 };
      }
    }
  }
  // email: local@domain (broad charset), must contain a dot in the domain
  const m = EMAIL_LOCAL.exec(src.slice(j));
  if (m) {
    let e = j + m[0].length;
    // domain: labels [a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])? joined by '.'
    let labels = 0;
    while (e < n) {
      const c0 = src.charCodeAt(e);
      if (!isAlnumCh(c0)) break;
      let k = e + 1;
      while (k < n && k - e < 63 && (isAlnumCh(src.charCodeAt(k)) || src.charCodeAt(k) === 45)) k++;
      // label must end with alnum
      if (!isAlnumCh(src.charCodeAt(k - 1))) break;
      labels++;
      e = k;
      if (e < n && src.charCodeAt(e) === 46) { e++; continue; }
      break;
    }
    if (labels >= 2 && e < n && src.charCodeAt(e) === 62) {
      const c = src.charCodeAt(e - 1);
      if (c !== 45 && c !== 95) {
        const email = src.slice(i + 1, e);
        return { href: cleanUrl('mailto:' + email), text: email, end: e + 1 };
      }
    }
  }
  return null;
}

// HTML tag starting at src[i]=='<'. Returns the index just past the tag, or 0.
// Open tag / close tag / comment / PI / declaration / CDATA.
function matchHtmlTag(src, i) {
  const n = src.length;
  let j = i + 1;
  if (j >= n) return 0;
  const c0 = src.charCodeAt(j);
  if (c0 === 33) { // ! -- comment / declaration / CDATA
    if (src.startsWith('!--', j)) {
      // Abruptly closed comments: <!--> and <!---> end at the '>'.
      if (j + 3 < n && src.charCodeAt(j + 3) === 62) return j + 4;
      if (j + 4 < n && src.charCodeAt(j + 3) === 45 && src.charCodeAt(j + 4) === 62) return j + 5;
      const e = src.indexOf('-->', j + 3);
      if (e === -1) return 0;
      return e + 3;
    }
    if (src.startsWith('[CDATA[', j + 1)) {
      const e = src.indexOf(']]>', j + 8);
      if (e === -1) return 0;
      return e + 3;
    }
    // declaration: <!A ... > (letter, then anything up to '>')
    if (j + 1 < n && isAlphaCh(src.charCodeAt(j + 1))) {
      let k = j + 1;
      while (k < n && src.charCodeAt(k) !== 62) k++;
      return k < n ? k + 1 : 0;
    }
    return 0;
  }
  if (c0 === 63) { // <? ... ?>
    const e = src.indexOf('?>', j + 1);
    if (e === -1) return 0;
    return e + 2;
  }
  if (c0 === 47) { // </name>
    j++;
    if (j >= n || !isAlphaCh(src.charCodeAt(j))) return 0;
    while (j < n && (isAlnumCh(src.charCodeAt(j)) || src.charCodeAt(j) === 45)) j++;
    j = skipWs(src, j);
    if (j < n && src.charCodeAt(j) === 62) return j + 1;
    return 0;
  }
  if (!isAlphaCh(c0)) return 0;
  // open tag: <name (whitespace+ attr)* whitespace* /?>
  while (j < n && (isAlnumCh(src.charCodeAt(j)) || src.charCodeAt(j) === 45)) j++;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 62) return j + 1;
    if (c === 47 && j + 1 < n && src.charCodeAt(j + 1) === 62) return j + 2;
    // An attribute must be preceded by whitespace.
    if (!(c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13)) return 0;
    j = skipWs(src, j);
    if (j >= n) return 0;
    const a0 = src.charCodeAt(j);
    if (a0 === 62) return j + 1;
    if (a0 === 47 && j + 1 < n && src.charCodeAt(j + 1) === 62) return j + 2;
    // attribute name
    if (!(isAlphaCh(a0) || a0 === 95 || a0 === 58)) return 0;
    j++;
    while (j < n) {
      const a = src.charCodeAt(j);
      if (isAlnumCh(a) || a === 95 || a === 58 || a === 46 || a === 45) j++;
      else break;
    }
    // An optional value: '=' (with optional whitespace around it). Peek
    // without consuming the whitespace, so a valueless attribute leaves the
    // separating whitespace for the next loop iteration.
    const k = skipWs(src, j);
    if (k < n && src.charCodeAt(k) === 61) {
      j = k + 1;
      j = skipWs(src, j);
      if (j >= n) return 0;
      const q = src.charCodeAt(j);
      if (q === 34 || q === 39) {
        j++;
        while (j < n && src.charCodeAt(j) !== q) j++;
        if (j >= n) return 0;
        j++;
      } else {
        while (j < n) {
          const v = src.charCodeAt(j);
          if (v === 32 || v === 9 || v === 10 || v === 34 || v === 39 || v === 61 || v === 60 || v === 62 || v === 96) break;
          j++;
        }
        if (j >= n) return 0;
      }
    }
  }
  return 0;
}

// Extended autolink (GFM) starting at src[i]: www. / http:// / https:// /
// ftp:// (case-insensitive scheme). Returns {href, text, end} or null.
function matchExtUrl(src, i, brackets) {
  if (noAutolink) return null;
  const n = src.length;
  let scheme = null;
  let start = i;
  if (src.startsWith('www.', i)) {
    // must be preceded by start, whitespace, *, _, ~, or (
    if (i > 0) {
      const p = src.charCodeAt(i - 1);
      if (!(p === 32 || p === 9 || p === 10 || p === 11 || p === 12 || p === 13 || p === 42 || p === 95 || p === 126 || p === 40)) return null;
    }
    scheme = 'www.';
  } else {
    const low = src.slice(i, i + 8).toLowerCase();
    if (low.startsWith('http://')) scheme = src.slice(i, i + 7);
    else if (low.startsWith('https://')) scheme = src.slice(i, i + 8);
    else if (low.startsWith('ftp://')) scheme = src.slice(i, i + 6);
    else return null;
  }
  // domain: (label.)+ then rest [^\s<]*, then backpedal
  let j = i + scheme.length;
  // domain labels: [a-zA-Z0-9-]+ with optional trailing '.'
  let k = j;
  let sawDot = false;
  while (k < n) {
    const c = src.charCodeAt(k);
    if (isAlnumCh(c) || c === 45) { k++; continue; }
    if (c === 46) { sawDot = true; k++; continue; }
    break;
  }
  // The tail is [^\s<]*, backpedalled — brackets are part of the URL
  // (marked includes `]`/`[` and encodes them %5D/%5B), EXCEPT a `]`
  // that closes an ACTIVE open bracket and is followed by `(` or `[`
  // (a link dest/ref): that `]` must stay the bracket closer so the
  // link can form. An inactive bracket (a link already formed inside
  // it) never forms, so its `]` belongs to the URL.
  let hasActiveBracket = false;
  if (brackets) for (let b = brackets.length - 1; b >= 0; b--) { if (brackets[b].active) { hasActiveBracket = true; break; } }
  let e = k;
  let sawBracket = false;
  while (e < n) {
    const c = src.charCodeAt(e);
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 60) break;
    if (c === 93 && !sawBracket && hasActiveBracket && e + 1 < n && (src.charCodeAt(e + 1) === 40 || src.charCodeAt(e + 1) === 91)) break;
    if (c === 91 || c === 93) sawBracket = true;
    e++;
  }
  if (e === j) return null;
  let url = backpedalUrl(src.slice(i, e));
  if (!url) return null;
  // www. requires a domain that the regex matched: at least the labels part
  // must be non-empty and the backpedalled url must still start with www.
  if (scheme === 'www.' && !url.startsWith('www.')) return null;
  const href = scheme === 'www.' ? 'http://' + url : url;
  return { href: cleanUrl(href), text: url, end: i + url.length };
}

// mailto:/xmpp: extended autolink starting at src[i] ('m' or 'x').
// The prefix must be lowercase and not preceded by [A-Za-z0-9].
function matchMailto(src, i) {
  const n = src.length;
  if (i > 0 && isAlnumCh(src.charCodeAt(i - 1))) return null;
  let proto = null;
  if (src.startsWith('mailto:', i)) proto = 'mailto:';
  else if (src.startsWith('xmpp:', i)) proto = 'xmpp:';
  else return null;
  BARE_EMAIL.lastIndex = i + proto.length;
  const m = BARE_EMAIL.exec(src);
  if (!m) return null;
  let end = i + proto.length + m[0].length;
  if (proto === 'xmpp:' && end < n && src.charCodeAt(end) === 47) {
    let k = end + 1;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (isAlnumCh(c) || c === 64 || c === 46) k++;
      else break;
    }
    if (k > end + 1) end = k;
  }
  const text = src.slice(i, end);
  return { href: cleanUrl(text), text, end };
}

// Strikethrough (GFM) starting at src[i]=='~'. Returns
// {content, end} (content = raw inner source) or null. On failure the caller
// consumes the whole '~' run as literal text.
function matchDel(src, i) {
  // Marked's strikethrough is delimiter-counting, not a regex: the opener
  // is 1-2 '~' followed by a non-space, non-'~' char; the closer is the
  // '~' run of the same length that balances all nested openers of that
  // length (a run that can only open increases the balance, a run that can
  // close decreases it; the del closes when the balance reaches 0).
  const n = src.length;
  let o = 0;
  while (i + o < n && src.charCodeAt(i + o) === 126 && o < 2) o++;
  if (o === 0) return null;
  const after = i + o;
  if (after >= n) return null;
  const ac = src.charCodeAt(after);
  if (ac === 32 || ac === 9 || ac === 10 || ac === 11 || ac === 12 || ac === 13 || ac === 126) return null;
  let p = o;
  let j = after;
  while (j < n) {
    // A backslash-escaped tilde is literal text, not a delimiter: skip
    // the pair so `\~` never counts toward (or breaks) a run (`~~run
    // \~~~` closes on the `~~` after the escaped `~`; `~~a \~~` has no
    // closer because the `\~` leaves only one unescaped `~`).
    if (src.charCodeAt(j) === 92 && j + 1 < n && src.charCodeAt(j + 1) === 126) { j += 2; continue; }
    if (src.charCodeAt(j) !== 126) { j++; continue; }
    const runStart = j;
    let runLen = 0;
    while (j < n && src.charCodeAt(j) === 126) { runLen++; j++; }
    if (runLen !== o) continue;
    const before = runStart > 0 ? src[runStart - 1] : null;
    const afterRun = j < n ? src[j] : null;
    const prevWS = before === null || isWhitespaceStr(src, runStart - 1);
    const nextWS = afterRun === null || isWhitespaceStr(src, j);
    const prevP = before !== null && isPunctCh(src, runStart - 1);
    const nextP = afterRun !== null && isPunctCh(src, j);
    const leftFlank = !nextWS && (!nextP || prevWS || prevP);
    const rightFlank = !prevWS && (!prevP || nextWS || nextP);
    const canOpen = leftFlank;
    const canClose = rightFlank;
    if (canOpen && !canClose) {
      p += runLen;
    } else if (canClose) {
      p -= runLen;
      if (p <= 0) {
        return { contentStart: i + o, contentEnd: runStart, end: j };
      }
    }
  }
  return null;
}

// Plain-text extraction for image alt attributes.
function plainTextOf(nodes, src) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case T_TEXT: out += src.slice(nd.a, nd.b); break;
      case T_RAW: out += nd.s; break;
      case T_CODE: out += nd.s; break;
      case T_HTML: out += nd.s; break;
      case T_LINK: case T_AUTO: case T_EM: case T_STRONG: case T_DEL:
        out += plainTextOf(nd.ch, src); break;
      case T_IMG: out += nd.alt; break;
      default: break;
    }
  }
  return out;
}

// Process emphasis on a node list using the delimiter stack algorithm
// (commonmark.js). delims is the delimiter array (document order); only
// delimiters with index > stackBottom are considered. Marks consumed
// delimiters dead; the caller truncates the array afterwards.
function processEmphasis(nodes, delims, stackBottom, src) {
  const bottom = new Array(14).fill(null);
  // Ranges [openerIdx, closerIdx] of `**` strongs whose opener is a pure
  // opener (canOpen, cannot close — preceded by whitespace). Such a strong
  // blocks a later single `*` closer from matching a single `*` opener
  // that encloses it (marked behaviour: `*a **b**c*` leaves the outer `*`
  // literal, but `*foo**bar**baz*` forms em).
  const strongPureOpener = [];
  let ci = stackBottom + 1;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (closer.dead || closer.len === 0 || !closer.canClose) { ci++; continue; }
    const bidx = closer.ch === 42
      ? 8 + (closer.canOpen ? 3 : 0) + (closer.orig % 3)
      : 2 + (closer.canOpen ? 3 : 0) + (closer.orig % 3);
    const bObj = bottom[bidx];
    let openerFound = null;
    let openerIdx = -1;
    for (let oi = ci - 1; oi > stackBottom; oi--) {
      const op = delims[oi];
      if (op.dead || op.len === 0) continue;
      if (bObj !== null && op === bObj) break;
      if (!op.canOpen || op.ch !== closer.ch) continue;
      const oddMatch = (closer.canOpen || op.canClose) &&
        (closer.orig % 3 !== 0) && ((op.orig + closer.orig) % 3 === 0);
      if (!oddMatch) {
        // Blocked by an intervening strong whose opener is a pure opener.
        // Any closer (single `*` or `**`) forming an em with a single `*`
        // opener that encloses such a strong is blocked (`**a *b **c**d*
        // e**`: the outer `**` forms the strong, `*b...d*` stays literal).
        if (closer.ch === 42 && op.orig === 1 &&
            strongPureOpener.some(r => r[0] > oi && r[1] < ci)) continue;
        // A single `*` closer must not steal a pure-opener `**` when a
        // later `**` closer can form the strong with it
        // (`**public as *so*other* option html**`: the `*` after `other`
        // stays literal, the trailing `**` closes the strong). Only when
        // the opener has exactly 2 left (a `***` opener has 3, enough for
        // both the em and the strong — cm-430 `***foo* bar**`).
        if (closer.ch === 42 && closer.orig === 1 && op.len === 2 &&
            op.canOpen && !op.canClose) {
          let laterStrong = false;
          for (let k = ci + 1; k < delims.length; k++) {
            const dk = delims[k];
            if (!dk.dead && dk.len >= 2 && dk.ch === 42 && dk.canClose) { laterStrong = true; break; }
          }
          if (laterStrong) continue;
        }
        openerFound = op; openerIdx = oi; break;
      }
    }
    if (openerFound) {
      const use = (openerFound.len >= 2 && closer.len >= 2) ? 2 : 1;
      const tag = use === 2 ? T_STRONG : T_EM;
      wrapEmphasis(nodes, openerFound, closer, use, tag, src);
      for (let k = openerIdx + 1; k < ci; k++) delims[k].dead = true;
      if (use === 2 && openerFound.canOpen && !openerFound.canClose && closer.canOpen && closer.ch === 42) strongPureOpener.push([openerIdx, ci]);
      openerFound.len -= use;
      closer.len -= use;
      if (openerFound.len === 0) openerFound.dead = true;
      if (closer.len === 0) { closer.dead = true; ci++; }
    } else {
      let p = ci - 1;
      while (p > stackBottom && (delims[p].dead || delims[p].len === 0)) p--;
      bottom[bidx] = p > stackBottom ? delims[p] : null;
      if (!closer.canOpen) closer.dead = true;
      ci++;
    }
  }
}

function wrapEmphasis(nodes, opener, closer, use, tag, src) {
  const oi = nodes.indexOf(opener.node);
  const ci = nodes.indexOf(closer.node);
  if (oi === -1 || ci === -1 || oi > ci) return;
  opener.node.b -= use;
  closer.node.a += use;
  let insertPos, closerIdx;
  if (opener.node.b <= opener.node.a) { nodes.splice(oi, 1); insertPos = oi; closerIdx = ci - 1; }
  else { insertPos = oi + 1; closerIdx = ci; }
  const moved = nodes.splice(insertPos, closerIdx - insertPos);
  const strongNode = { t: tag, ch: moved };
  nodes.splice(insertPos, 0, strongNode);
  if (closer.node.a >= closer.node.b) {
    const cidx = nodes.indexOf(closer.node);
    if (cidx !== -1) nodes.splice(cidx, 1);
  } else if (use === 2 && tag === T_STRONG && src && closer.ch === 42 && moved.length >= 2) {
    // marked quirk (only for `*`): a strong closed by a run with a
    // leftover `*` (e.g. `***` closing `**`) keeps the leftover INSIDE
    // the strong when the content ends with an <em> immediately followed
    // by non-space text (`**a *b*c***` → `<strong>a <em>b</em>c*</strong>`),
    // but not when there is a space (`**a *b* c***`) or no inner em.
    // NOT for `_`: a leftover `__` must stay outside to close an outer
    // `__` strong (`__a __b____` nests, it is not literal inside).
    const last = moved[moved.length - 1];
    const prev = moved[moved.length - 2];
    if (last && last.t === T_TEXT && last.a < last.b && src.charCodeAt(last.a) !== 32 && src.charCodeAt(last.a) !== 9 &&
        prev && (prev.t === T_EM || prev.t === T_STRONG)) {
      strongNode.ch.push({ t: T_TEXT, a: closer.node.a, b: closer.node.b });
      const cidx = nodes.indexOf(closer.node);
      if (cidx !== -1) nodes.splice(cidx, 1);
    }
  }
}

// Link-text source for a shortcut/collapsed reference label (escapes resolved).
function linkTextSource(src, br, i) {
  // The raw source of the link text, escapes kept literally (label matching
  // uses the raw label, so `foo\!` does not match `foo!`).
  const start = br.image ? br.pos + 2 : br.pos + 1;
  return src.slice(start, i);
}

// Find the `]` closing the bracket opened at `openPos` (the `[`), skipping
// code spans and nested brackets. Returns the index or -1. Used to bound a
// code span: it must close before the `]` that ends its link's label.
function findClosingBracket(src, openPos, n) {
  let depth = 0;
  let i = openPos + 1;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 96) {
      // A code span only protects a `]` when its closer comes before
      // that `]` — but only for 2+ backtick spans. A single-backtick
      // span may cross the `]` (cm-342: `[not a `link](/foo`)` forms a
      // code span, no link). A 2+ span whose closer lies past the `]`
      // does not form inside the label (marked lexes the link first),
      // so the `]` still closes the bracket.
      const cs = codeSpanAt(src, i);
      if (cs) {
        if (cs.n === 1) { i = cs.end; continue; }
        let hasBracket = false;
        for (let q = i; q < cs.end; q++) if (src.charCodeAt(q) === 93) { hasBracket = true; break; }
        if (!hasBracket) { i = cs.end; continue; }
      }
      i++;
      continue;
    }
    if (c === 92 && i + 1 < n && isPunctAscii(src.charCodeAt(i + 1))) { i += 2; continue; }
    if (c === 91) { depth++; i++; continue; }
    if (c === 93) {
      if (depth === 0) return i;
      depth--;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

// Parse a code span starting at a backtick run in `s` at `pos`.
// Returns { end, n, content } or null when there is no matching closer.
function codeSpanAt(s, pos) {
  let n = 0;
  while (pos + n < s.length && s.charCodeAt(pos + n) === 96) n++;
  if (n === 0) return null;
  let k = pos + n;
  while (k < s.length) {
    if (s.charCodeAt(k) === 96) {
      let m = 0;
      while (k + m < s.length && s.charCodeAt(k + m) === 96) m++;
      if (m === n) return { end: k + m, n, content: s.slice(pos + n, k) };
      k += m;
    } else k++;
  }
  return null;
}

// True when the link text must NOT form a link (marked quirk, probed):
// it holds a code span of 2+ backticks whose content contains a backtick,
// and that span is followed by anything other than further code spans
// (a trailing space or letter after it breaks the link; a code span as
// the last thing does not). A span with an inner backtick as the very
// last token still forms the link.
function linkTextBadCodeSpan(text) {
  let p = 0;
  while (p < text.length) {
    if (text.charCodeAt(p) !== 96) { p++; continue; }
    const cs = codeSpanAt(text, p);
    if (!cs) { p++; continue; }
    if (cs.n >= 2 && cs.content.indexOf('`') !== -1) {
      const rest = text.slice(cs.end);
      if (rest === '') return false;
      // The rest must be only code spans (whitespace between them is fine).
      let q = 0, sawCode = false;
      while (q < rest.length) {
        const c = rest.charCodeAt(q);
        if (c === 32 || c === 9 || c === 10) { q++; continue; }
        if (c === 96) {
          const cs2 = codeSpanAt(rest, q);
          if (!cs2) return true;
          sawCode = true;
          q = cs2.end;
          continue;
        }
        return true;
      }
      return !sawCode;
    }
    p = cs.end;
  }
  return false;
}

function removeDelimForNode(st, node) {
  const d = st.delims;
  for (let k = d.length - 1; k >= 0; k--) {
    if (d[k].node === node) { d.splice(k, 1); break; }
  }
}

// Bare email autolink ending at '@' (position i). Rewinds the local part out
// of the buffer/nodes and creates an autolink. Returns the end index or -1.
function tryBareEmail(st, i) {
  if (noAutolink) return -1;
  const src = st.src;
  let ls = i - 1;
  while (ls >= 0) {
    const c = src.charCodeAt(ls);
    if (isAlnumCh(c) || c === 46 || c === 95 || c === 43 || c === 45) ls--;
    else break;
  }
  ls++;
  if (ls === i) return -1;
  BARE_EMAIL.lastIndex = ls;
  const m = BARE_EMAIL.exec(src);
  if (!m || m.index !== ls) return -1;
  let end = ls + m[0].length;
  // The `(?![\w-])` lookahead makes the regex backtrack past a final
  // `.label` when the email is followed by `_` (e.g. inside `__...__`).
  // Marked consumes that `_` as an emphasis closer first, so the full
  // email matches. Extend across `.label` groups while the `_` after
  // the label is an emphasis closer (followed by a non-alphanumeric).
  while (src.charCodeAt(end) === 46) {
    let p = end + 1;
    while (p < src.length) {
      const c = src.charCodeAt(p);
      if (isAlnumCh(c) || c === 45 || c === 95) p++;
      else break;
    }
    if (p === end + 1) break;
    // Label must end with an alnum.
    let q = p;
    while (q > end + 1 && !isAlnumCh(src.charCodeAt(q - 1))) q--;
    if (q === end + 1) break;
    const after = src.charCodeAt(q);
    if (after === 95) {
      let r = q;
      while (src.charCodeAt(r) === 95) r++;
      const nc = src.charCodeAt(r);
      if (r < src.length && isAlnumCh(nc)) break; // `_` followed by alnum: part of a word
    } else if (after !== undefined && (isAlnumCh(after) || after === 45)) {
      break;
    }
    end = q;
  }
  const nodes = st.nodes;
  // If the local part starts inside the current text buffer, just trim the
  // buffer; the nodes before it are untouched.
  if (ls >= st.bufA) {
    if (st.bufB > st.bufA && st.bufA < ls) nodes.push({ t: T_TEXT, a: st.bufA, b: ls });
    const email = src.slice(ls, end);
    nodes.push({ t: T_AUTO, href: cleanUrl('mailto:' + email), text: email, a: ls, b: end, ext: true });
    st.bufA = st.bufB = end;
    return end;
  }
  // Otherwise the local part starts in a flushed text node: walk back.
  // Verify the nodes covering [ls, bufA) are all plain text nodes.
  let k = nodes.length - 1;
  let trimNode = null;
  let removeCount = 0;
  while (k >= 0) {
    const nd = nodes[k];
    if (nd.t !== T_TEXT) return -1;
    if (nd.b <= ls) break;
    if (nd.a >= ls) { removeCount++; k--; }
    else { trimNode = nd; break; }
  }
  // Apply: remove nodes, trim the straddling one, keep buffer text before ls.
  for (let r = 0; r < removeCount; r++) {
    const nd = nodes.pop();
    removeDelimForNode(st, nd);
  }
  if (trimNode) trimNode.b = ls;
  if (st.bufB > st.bufA) {
    if (st.bufA < ls) nodes.push({ t: T_TEXT, a: st.bufA, b: ls });
  }
  const email = src.slice(ls, end);
  nodes.push({ t: T_AUTO, href: cleanUrl('mailto:' + email), text: email, a: ls, b: end, ext: true });
  st.bufA = st.bufB = end;
  return end;
}

function parseInline(src, refs, start = 0, end = src.length) {
  const n = end;
  const st = { src, refs, nodes: [], delims: [], brackets: [], bufA: start, bufB: start, unclosedBT: [], codeEnds: [] };
  const nodes = st.nodes;
  const flush = () => {
    if (st.bufB > st.bufA) nodes.push({ t: T_TEXT, a: st.bufA, b: st.bufB });
    st.bufA = st.bufB = st.i;
  };
  let i = start;
  st.i = start;
  while (i < n) {
    st.i = i;
    // After a node push that jumped i forward, the (empty) text buffer still
    // points at the old position; re-anchor it here.
    if (st.bufA === st.bufB && st.bufA < i) st.bufA = st.bufB = i;
    const c = src.charCodeAt(i);
    if (c === 92) { // backslash
      if (i + 1 < n && src.charCodeAt(i + 1) === 10) {
        flush();
        nodes.push({ t: T_BR });
        i += 2;
        // A hard break strips the next line's leading whitespace.
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
        continue;
      }
      if (i + 1 < n && isPunctAscii(src.charCodeAt(i + 1))) {
        flush();
        nodes.push({ t: T_RAW, s: escText(src[i + 1]) });
        i += 2;
        continue;
      }
      st.bufB++;
      i++;
      continue;
    }
    if (c === 96) { // backtick: code span
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      const m = j - i;
      // A code span inside link text must close before the `]` that ends
      // the label (marked lexes the link first); it may not swallow that
      // `]` and reach a backtick on a later line (doc-35: the lone `` ` ``
      // after a failed `` `` `` must not span `][tool-91]` to `onChange`).
      let searchEnd = n;
      if (st.brackets.length > 0) {
        const br = st.brackets[st.brackets.length - 1];
        const closePos = findClosingBracket(src, br.pos, n);
        if (closePos !== -1 && closePos > i) searchEnd = closePos;
      }
      let k = j;
      let closeStart = -1;
      while (k < searchEnd) {
        if (src.charCodeAt(k) === 96) {
          let r = k;
          while (r < n && src.charCodeAt(r) === 96) r++;
          if (r - k === m) { closeStart = k; break; }
          k = r;
        } else k++;
      }
      if (closeStart === -1) {
        // An unclosed 2+ backtick run inside brackets suppresses emphasis
        // delimiters until the next code span that forms (recorded below).
        if (m >= 2 && st.brackets.length > 0) st.unclosedBT.push(i);
        st.bufB += m;
        i = j;
        continue;
      }
      let content = src.slice(j, closeStart).replace(/\n/g, ' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32) {
        let allSpace = true;
        for (let q = 0; q < content.length; q++) if (content.charCodeAt(q) !== 32) { allSpace = false; break; }
        if (!allSpace) content = content.slice(1, -1);
      }
      flush();
      nodes.push({ t: T_CODE, s: content });
      st.codeEnds.push(closeStart + m);
      i = closeStart + m;
      continue;
    }
    if (c === 91) { // '['
      flush();
      const node = { t: T_TEXT, a: i, b: i + 1 };
      nodes.push(node);
      st.brackets.push({ node, idx: nodes.length - 1, pos: i, image: false, active: true, dstart: st.delims.length });
      i++;
      continue;
    }
    if (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91) { // '!['
      flush();
      const node = { t: T_TEXT, a: i, b: i + 2 };
      nodes.push(node);
      st.brackets.push({ node, idx: nodes.length - 1, pos: i, image: true, active: true, dstart: st.delims.length });
      i += 2;
      continue;
    }
    if (c === 93) { // ']' : try to form a link/image
      // The most recent bracket is the opener; if it is inactive (a link
      // formed inside it), the `]` is literal text and the opener is
      // removed — do NOT skip to an earlier active bracket (cm-520).
      const bi = st.brackets.length - 1;
      if (bi < 0) { st.bufB++; i++; continue; }
      if (!st.brackets[bi].active) {
        st.brackets.splice(bi, 1);
        st.bufB++;
        i++;
        continue;
      }
      const br = st.brackets[bi];
      let linkEnd = -1, dest = null, title = null;
      // The '(' must follow ']' immediately (no whitespace allowed).
      let j = i + 1;
      if (j < n && src.charCodeAt(j) === 40) { // inline link '('
        let k = skipWs(src, j + 1);
        let d = null;
        if (k < n && src.charCodeAt(k) === 41) d = { dest: '', end: k };
        else d = parseLinkDest(src, k);
        if (d) {
          let m2 = skipWs(src, d.end);
          let t = null;
          let ok = true;
          if (m2 < n && (src.charCodeAt(m2) === 34 || src.charCodeAt(m2) === 39 || src.charCodeAt(m2) === 40)) {
            if (m2 > d.end) {
              t = parseLinkTitle(src, m2);
              if (t) m2 = skipWs(src, t.end);
              else ok = false;
            } else ok = false;
          }
          if (ok && m2 < n && src.charCodeAt(m2) === 41) {
            linkEnd = m2 + 1;
            dest = d.dest;
            title = t ? t.title : null;
          }
        }
      }
      if (linkEnd === -1) { // reference link
        let refLabel = null;
        let refEnd = -1;
        let hasSecond = false;
        if (i + 1 < n && src.charCodeAt(i + 1) === 91) {
          let k = i + 2;
          let labelOut = '';
          let ok = false;
          while (k < n) {
            const cc = src.charCodeAt(k);
            // Keep escapes literally (no resolution for label matching).
            if (cc === 92 && k + 1 < n && isPunctAscii(src.charCodeAt(k + 1))) { labelOut += src[k] + src[k + 1]; k += 2; continue; }
            if (cc === 91) break; // unescaped '[': invalid label
            if (cc === 93) { ok = true; break; }
            labelOut += src[k];
            k++;
          }
          if (ok) { hasSecond = true; refEnd = k + 1; refLabel = labelOut; }
        }
        let lookup = null;
        if (hasSecond) lookup = refLabel === '' ? linkTextSource(src, br, i) : refLabel;
        else lookup = linkTextSource(src, br, i);
        if (lookup !== null && lookup.length > 0 && lookup.length <= 999) {
          const ref = refs[normalizeLabel(lookup)];
          if (ref) {
            linkEnd = hasSecond ? refEnd : i + 1;
            dest = ref.dest;
            title = ref.title;
          }
        }
      }
      if (linkEnd === -1) {
        st.brackets.splice(bi, 1);
        st.bufB++;
        i++;
        continue;
      }
      // marked quirk: a multi-backtick code span holding a backtick, not
      // the last thing in the text, prevents the link from forming.
      if (linkTextBadCodeSpan(linkTextSource(src, br, i))) {
        // The failed link also kills every emphasis delimiter inside its
        // text: they render literally (probed — even _a_ / *a* that do not
        // span the code span stay literal).
        st.delims.length = br.dstart;
        st.brackets.splice(bi, 1);
        st.bufB++;
        i++;
        continue;
      }
      flush();
      const linkText = nodes.slice(br.idx + 1);
      processEmphasis(linkText, st.delims, br.dstart - 1, src);
      st.delims.length = br.dstart;
      st.brackets.length = bi;
      if (!br.image) {
        // Extended-URL autolinks inside link text render as plain text
        // (a link cannot contain a link); unwrap them back to text nodes,
        // including ones nested inside emphasis/strikethrough in the text.
        const unwrapAuto = (arr) => {
          for (let q = 0; q < arr.length; q++) {
            const nd = arr[q];
            if (nd.t === T_AUTO && nd.ext) { arr[q] = { t: T_TEXT, a: nd.a, b: nd.b }; continue; }
            if (nd.ch) unwrapAuto(nd.ch);
          }
        };
        unwrapAuto(linkText);
        for (const b of st.brackets) if (!b.image) b.active = false;
      }
      const href = cleanUrl(dest);
      const ttl = title !== null && title !== undefined ? escText(title) : null;
      let node;
      if (br.image) {
        node = { t: T_IMG, src: href, title: ttl, alt: escText(plainTextOf(linkText, src)) };
      } else {
        node = { t: T_LINK, href, title: ttl, ch: linkText };
      }
      nodes.splice(br.idx, nodes.length - br.idx, node);
      st.bufA = st.bufB = linkEnd;
      i = linkEnd;
      continue;
    }
    if (c === 60) { // '<' : autolink or html tag
      const al = matchAutolink(src, i);
      if (al) {
        flush();
        nodes.push({ t: T_AUTO, href: al.href, text: al.text });
        i = al.end;
        continue;
      }
      const ht = matchHtmlTag(src, i);
      if (ht > 0) {
        // `<a` inLink quirk (see noAutolink above): an inline `<a` open
        // tag that contains a space (i.e. has attributes — a bare `<a>`
        // or one with only tab/newline separators does not count) sets
        // inLink, suppressing later GFM autolinks until an inline
        // `</a>` (exactly, lowercase) clears it. An HTML block `</a>`
        // alone on a line never reaches here, so it does not reset.
        if (src.charCodeAt(i + 1) === 47 && src.charCodeAt(i + 2) === 97 &&
            src.charCodeAt(i + 3) === 62 && ht === i + 4) {
          noAutolink = false;
        } else if (!noAutolink && (src.charCodeAt(i + 1) === 97 || src.charCodeAt(i + 1) === 65)) {
          const c2 = src.charCodeAt(i + 2);
          if (!(isAlnumCh(c2) || c2 === 45)) {
            for (let k = i + 2; k < ht; k++) {
              if (src.charCodeAt(k) === 32) { noAutolink = true; break; }
            }
          }
        }
        flush();
        nodes.push({ t: T_HTML, s: src.slice(i, ht) });
        i = ht;
        continue;
      }
      st.bufB++;
      i++;
      continue;
    }
    if (c === 38) { // '&' : entity
      if (i + 1 < n && src.charCodeAt(i + 1) === 35) {
        const dec = decodeNumeric(src, i);
        if (dec) {
          flush();
          nodes.push({ t: T_RAW, s: escText(dec.ch) });
          i = dec.end;
          continue;
        }
        st.bufB++;
        i++;
        continue;
      }
      const e = entityEnd(src, i);
      if (e > 0) {
        st.bufB = e;
        i = e;
        continue;
      }
      st.bufB++;
      i++;
      continue;
    }
    if (c === 42 || c === 95) { // '*' or '_' : delimiter run
      let j = i;
      while (j < n && src.charCodeAt(j) === c) j++;
      const m = j - i;
      const prev = i === 0 ? null : src[i - 1];
      const next = j >= n ? null : src[j];
      const prevWS = prev === null || isWhitespaceStr(src, i - 1);
      const nextWS = next === null || isWhitespaceStr(src, j);
      const prevP = prev !== null && isPunctCh(src, i - 1);
      const nextP = next !== null && isPunctCh(src, j);
      const leftFlank = !nextWS && (!nextP || prevWS || prevP);
      const rightFlank = !prevWS && (!prevP || nextWS || nextP);
      let canOpen, canClose;
      if (c === 95) {
        canOpen = leftFlank && (!rightFlank || prevP);
        canClose = rightFlank && (!leftFlank || nextP);
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      flush();
      const node = { t: T_TEXT, a: i, b: j };
      nodes.push(node);
      st.delims.push({ ch: c, len: m, orig: m, canOpen, canClose, node, dead: false });
      i = j;
      continue;
    }
    if (c === 126) { // '~' : strikethrough
      const d = matchDel(src, i);
      if (d) {
        flush();
        nodes.push({ t: T_DEL, ch: parseInline(src, refs, d.contentStart, d.contentEnd) });
        i = d.end;
        continue;
      }
      let j = i;
      while (j < n && src.charCodeAt(j) === 126) j++;
      st.bufB += j - i;
      i = j;
      continue;
    }
    if (c === 64) { // '@' : bare email autolink
      const end = tryBareEmail(st, i);
      if (end !== -1) { i = end; continue; }
      st.bufB++;
      i++;
      continue;
    }
    if (c === 119 || c === 87 || c === 104 || c === 72 || c === 102 || c === 70) { // w/W h/H f/F
      // A `www.` URL inside open brackets must not autolink: its tail
      // would swallow the `]` that closes a link (marked lexes the link
      // first and never autolinks its text). `http(s)://` and `ftp://`
      // stop at whitespace/`]` so they are safe to link even inside
      // brackets; when the bracket fails to form a link they must still
      // autolink (doc-39).
      const isWww = (c === 119 || c === 87) && src.startsWith('www.', i);
      if (!isWww || st.brackets.length === 0) {
        const u = matchExtUrl(src, i, st.brackets);
        if (u) {
          flush();
          // Remember the source range so the autolink can be unwrapped
          // back to plain text if it lands inside a link's text.
          nodes.push({ t: T_AUTO, href: u.href, text: u.text, a: i, b: u.end, ext: true });
          i = u.end;
          continue;
        }
      }
      st.bufB++;
      i++;
      continue;
    }
    if (c === 109 || c === 120) { // 'm' / 'x' : mailto:/xmpp:
      const mt = matchMailto(src, i);
      if (mt) {
        flush();
        nodes.push({ t: T_AUTO, href: mt.href, text: mt.text });
        i = mt.end;
        continue;
      }
      st.bufB++;
      i++;
      continue;
    }
    if (c === 10) { // newline: hard break if 2+ trailing spaces
      let k = st.bufB;
      while (k > st.bufA && src.charCodeAt(k - 1) === 32) k--;
      if (st.bufB - k >= 2) {
        st.bufB = k;
        flush();
        nodes.push({ t: T_BR });
        i++;
        // A hard break strips the next line's leading whitespace.
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
        continue;
      }
      st.bufB++;
      i++;
      continue;
    }
    st.bufB++;
    i++;
  }
  flush();
  // Unclosed 2+ backtick run inside a link label suppresses emphasis
  // delimiters until the next code span that forms (marked quirk: the
  // span's opener "swallows" the delimiters up to its closer even though
  // the span itself does not form across the `]`). Kill delimiters whose
  // source position falls in [opener, nextCodeSpanEnd).
  if (st.unclosedBT.length > 0 && st.codeEnds.length > 0) {
    for (const op of st.unclosedBT) {
      let endPos = -1;
      for (const ce of st.codeEnds) if (ce > op) { endPos = ce; break; }
      if (endPos === -1) continue;
      for (const d of st.delims) {
        if (!d.dead && (d.ch === 42 || d.ch === 95) && d.node.a >= op && d.node.a < endPos) d.dead = true;
      }
    }
  }
  processEmphasis(nodes, st.delims, -1, src);
  return nodes;
}

function renderInline(nodes, src) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case T_TEXT: out += escText(src.slice(nd.a, nd.b)); break;
      case T_RAW: out += nd.s; break;
      case T_CODE: out += '<code>' + escDumb(nd.s) + '</code>'; break;
      case T_HTML: out += nd.s; break;
      case T_BR: out += '<br>'; break;
      case T_LINK:
        out += '<a href="' + nd.href + '"';
        if (nd.title !== null) out += ' title="' + nd.title + '"';
        out += '>' + renderInline(nd.ch, src) + '</a>';
        break;
      case T_IMG:
        out += '<img src="' + nd.src + '" alt="' + nd.alt + '"';
        if (nd.title !== null) out += ' title="' + nd.title + '"';
        out += '>';
        break;
      case T_AUTO: out += '<a href="' + nd.href + '">' + escText(nd.text) + '</a>'; break;
      case T_EM: out += '<em>' + renderInline(nd.ch, src) + '</em>'; break;
      case T_STRONG: out += '<strong>' + renderInline(nd.ch, src) + '</strong>'; break;
      case T_DEL: out += '<del>' + renderInline(nd.ch, src) + '</del>'; break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------
// Block types: doc, quote, list, item, para, head, hr, fence, code, html, table
// A cursor tracks position/column in a line; advancing past a tab expands it
// to spaces in place (so a partially consumed tab leaves spaces), while tabs
// inside block content are never touched and stay literal.

function makeCursor(s) {
  return { s, i: 0, col: 0 };
}
function curCh(cu) {
  return cu.i >= cu.s.length ? -1 : cu.s.charCodeAt(cu.i);
}
function advanceOne(cu) {
  if (cu.i >= cu.s.length) return;
  if (cu.s.charCodeAt(cu.i) === 9) {
    const spaces = 4 - (cu.col % 4);
    cu.s = cu.s.slice(0, cu.i) + ' '.repeat(spaces) + cu.s.slice(cu.i + 1);
  }
  cu.i++;
  cu.col++;
}
// Skip up to n columns of spaces (tabs expand). Returns false if a non-space
// (or end of line) is hit before n columns.
function skipIndent(cu, n) {
  let count = 0;
  while (count < n) {
    const c = curCh(cu);
    if (c === 32 || c === 9) { advanceOne(cu); count++; }
    else return false;
  }
  return true;
}
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
// Number of leading spaces (0-3) before a non-space, or -1 if the line is
// blank / has 4+ leading spaces. Tabs count by column.
function leadingSpaces(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col % 4);
    else return col <= 3 ? col : -1;
  }
  return -1;
}

const HTML_BLOCK_END_SCRIPT = /<\/script\s*>/i;
const HTML_BLOCK_END_PRE = /<\/pre\s*>/i;
const HTML_BLOCK_END_STYLE = /<\/style\s*>/i;
const HTML_BLOCK_END_TEXTAREA = /<\/textarea\s*>/i;
const HTML_BLOCK_END_COMMENT = /-->/;
const HTML_BLOCK_END_PI = /\?>/;
const HTML_BLOCK_END_DECL = />/;
const HTML_BLOCK_END_CDATA = /\]\]>/;
const BLOCK_TAGS_RE = /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/i;

// Returns {type, endRe} for an HTML block starting at cu (first non-space
// char), or null. endRe null means the block ends at a blank line (types 6/7).
function htmlBlockType(cu) {
  const rest = cu.s.slice(cu.i);
  const m1 = /^<(script|pre|style|textarea)(?:\s|>|$)/i.exec(rest);
  if (m1) {
    const tag = m1[1].toLowerCase();
    const endRe = tag === 'script' ? HTML_BLOCK_END_SCRIPT
      : tag === 'pre' ? HTML_BLOCK_END_PRE
      : tag === 'style' ? HTML_BLOCK_END_STYLE : HTML_BLOCK_END_TEXTAREA;
    return { type: 1, endRe };
  }
  if (rest.startsWith('<!--')) return { type: 2, endRe: HTML_BLOCK_END_COMMENT };
  if (rest.startsWith('<?')) return { type: 3, endRe: HTML_BLOCK_END_PI };
  if (/^<![A-Za-z]/.test(rest)) return { type: 4, endRe: HTML_BLOCK_END_DECL };
  if (rest.startsWith('<![CDATA[')) return { type: 5, endRe: HTML_BLOCK_END_CDATA };
  if (rest.charCodeAt(0) === 60) {
    const off = rest.charCodeAt(1) === 47 ? 2 : 1;
    if (BLOCK_TAGS_RE.test(rest.slice(off))) return { type: 6, endRe: null };
  }
  // Type 7: a complete open or closing tag alone on the line.
  const tagEnd = matchHtmlTag(rest, 0);
  if (tagEnd > 0 && /^[ \t]*$/.test(rest.slice(tagEnd))) return { type: 7, endRe: null };
  return null;
}

// Parse link reference definitions from a paragraph's lines. Returns the
// remaining lines (those that are not defs) or null if the whole paragraph
// is defs. Mutates refs.
function extractRefDefs(lines, refs) {
  let idx = 0;
  const n = lines.length;
  let anyDef = false;
  while (idx < n) {
    let line = lines[idx];
    // A def starts with up to 3 spaces, then '[' label ']:'
    let p = 0;
    while (p < line.length && line.charCodeAt(p) === 32 && p < 3) p++;
    if (p >= line.length || line.charCodeAt(p) !== 91) break;
    // parse label (may span lines): 1-999 chars after normalization
    const pl = parseDefLabel(lines, idx, p);
    if (!pl) break;
    const label = pl.label;
    const norm0 = normalizeLabel(label);
    if (norm0.length === 0 || norm0.length > 999) break;
    let endLine = pl.endLine;
    line = lines[endLine];
    let k = pl.endPos;
    if (k >= line.length || line.charCodeAt(k) !== 58) break; // ':'
    k++;
    // dest: skip whitespace (may continue on the next line)
    let dest = null, title = null;
    let d = skipWsStr(line, k);
    if (d < line.length) {
      const pd = parseLinkDest(line, d);
      if (pd) { dest = pd.dest; k = pd.end; }
    }
    if (dest === null) {
      // dest on the next line (after the label's last line)
      if (endLine + 1 < n) {
        const nl = lines[endLine + 1];
        const nd = skipWsStr(nl, 0);
        if (nd < nl.length) {
          const pd = parseLinkDest(nl, nd);
          if (pd) { dest = pd.dest; k = pd.end; endLine = endLine + 1; line = nl; }
        }
      }
      if (dest === null) break;
    }
    // title: same line (needs whitespace after the dest), or the next line
    // (a title on a later line that is followed by junk is dropped and the
    // def stays dest-only; junk on the dest's own line invalidates the def).
    const destEndLine = endLine, destEndPos = k;
    let t = skipWsStr(line, k);
    if (t < line.length) {
      if (t === k) break; // no whitespace between dest and title: invalid
      const pt = parseLinkTitle(line, t);
      if (pt) { title = pt.title; k = pt.end; }
      else {
        // The title may span lines: try the remaining lines joined by \n.
        const mt = parseTitleMulti(lines, endLine, t);
        if (mt) { title = mt.title; endLine = mt.endLine; k = mt.endPos; line = lines[endLine]; }
        else break; // junk after dest
      }
    }
    if (title === null && endLine + 1 < n) {
      const nl = lines[endLine + 1];
      const nt = skipWsStr(nl, 0);
      if (nt < nl.length) {
        const pt = parseLinkTitle(nl, nt);
        if (pt) { title = pt.title; endLine = endLine + 1; k = pt.end; line = nl; }
        else {
          const mt = parseTitleMulti(lines, endLine + 1, nt);
          if (mt) { title = mt.title; endLine = mt.endLine; k = mt.endPos; line = lines[endLine]; }
        }
      }
    }
    // after dest/title, only whitespace may remain on the last line used
    if (line.slice(k).trim() !== '') {
      if (endLine > destEndLine) {
        // Drop the title; the def is dest-only and the title line is separate.
        title = null;
        endLine = destEndLine;
        k = destEndPos;
        line = lines[endLine];
      } else break;
    }
    // a second title on the same/next line invalidates the def
    const norm = normalizeLabel(label);
    if (!(norm in refs)) refs[norm] = { dest, title };
    anyDef = true;
    idx = endLine + 1;
  }
  if (!anyDef) return lines;
  return idx >= n ? null : lines.slice(idx);
}

// Parse a link title starting at lines[li][pos], spanning lines if the
// closing quote is on a later line. Returns {title, endLine, endPos} or null.
function parseTitleMulti(lines, li, pos) {
  const first = lines[li];
  if (pos >= first.length) return null;
  const q = first.charCodeAt(pos);
  let close;
  if (q === 34) close = 34;
  else if (q === 39) close = 39;
  else if (q === 40) close = 41;
  else return null;
  let out = '';
  let i = pos + 1;
  for (let l = li; l < lines.length; l++) {
    const s = lines[l];
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === close) return { title: out, endLine: l, endPos: i + 1 };
      if (c === 92 && i + 1 < s.length && isPunctAscii(s.charCodeAt(i + 1))) { out += s[i + 1]; i += 2; continue; }
      out += s[i];
      i++;
    }
    // end of line: the title continues on the next line (joined by \n)
    if (l + 1 < lines.length) { out += '\n'; i = 0; }
  }
  return null;
}

// Parse a link label starting at lines[li][pos] (pos at '['), spanning lines
// if needed. Returns {label, endLine, endPos} (endPos just past ']') or null.
// The label keeps backslashes literally (no escape resolution, so `foo\!`
// does not match `foo!`), and an unescaped '[' makes the label invalid.
function parseDefLabel(lines, li, pos) {
  let label = '';
  let l = li, i = pos + 1;
  while (l < lines.length) {
    const s = lines[l];
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 92 && i + 1 < s.length && isPunctAscii(s.charCodeAt(i + 1))) {
        // Keep the escape literally; it does not close or open brackets.
        label += s[i] + s[i + 1];
        i += 2;
        continue;
      }
      if (c === 91) return null; // unescaped '[': invalid label
      if (c === 93) return { label, endLine: l, endPos: i + 1 };
      label += s[i];
      i++;
    }
    if (l + 1 < lines.length) { label += '\n'; l++; i = 0; }
    else break;
  }
  return null;
}

function skipWsStr(s, i) {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else break;
  }
  return i;
}

// --- block starter helpers (operate on a cursor positioned at content) ---

function matchAtx(cu) {
  // cu at first non-space char (0-3 spaces already consumed). Returns the
  // heading level (1-6) or 0.
  if (curCh(cu) !== 35) return 0;
  let i = cu.i;
  let level = 0;
  while (i < cu.s.length && cu.s.charCodeAt(i) === 35) { level++; i++; }
  if (level > 6) return 0;
  if (i >= cu.s.length) return level;
  const c = cu.s.charCodeAt(i);
  if (c !== 32 && c !== 9) return 0;
  return level;
}

function atxContent(cu, level) {
  // content after the hashes + following spaces, with trailing closing hashes
  // (and the spaces before them) stripped.
  let s = cu.s.slice(cu.i + level);
  s = s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  // strip a closing sequence of hashes preceded by a space
  const m = s.match(/^(.*?)[ \t]+#+$/);
  if (m) s = m[1].replace(/[ \t]+$/, '');
  else if (/^#+$/.test(s)) s = '';
  return s;
}

function matchThematicBreak(cu) {
  // cu at first non-space char. A line of 3+ '-', '_', or '*' with only
  // spaces/tabs between them.
  const s = cu.s.slice(cu.i);
  const c = s.charCodeAt(0);
  if (c !== 45 && c !== 95 && c !== 42) return false;
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === c) count++;
    else if (ch === 32 || ch === 9) continue;
    else return false;
  }
  return count >= 3;
}

function matchFence(cu) {
  // cu at first non-space char. Returns {marker, len, info} or null.
  const c = curCh(cu);
  if (c !== 96 && c !== 126) return null;
  let i = cu.i;
  let len = 0;
  while (i < cu.s.length && cu.s.charCodeAt(i) === c) { len++; i++; }
  if (len < 3) return null;
  let info = cu.s.slice(i).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  // Backslash escapes in the info string are resolved (e.g. foo\+bar -> foo+bar).
  if (info.indexOf('\\') !== -1) info = info.replace(/\\([!-/:-@\[-`{-~])/g, '$1');
  if (c === 96 && info.indexOf('`') !== -1) return null;
  return { marker: c, len, info };
}

function matchSetext(cu) {
  // cu at first non-space char. Returns 1 for '=', 2 for '-', or 0.
  const s = cu.s.slice(cu.i);
  let i = 0;
  const c = s.charCodeAt(0);
  if (c !== 61 && c !== 45) return 0;
  while (i < s.length && s.charCodeAt(i) === c) i++;
  while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  if (i !== s.length) return 0;
  return c === 61 ? 1 : 2;
}

function matchListMarker(cu) {
  // cu at first non-space char. Returns {bullet, ordered, start, delim,
  // markerLen, contentCol} or null. contentCol is the column where the item
  // content starts (after the marker + 1-4 spaces, per the spec).
  const c = curCh(cu);
  if (c === 42 || c === 45 || c === 43) {
    const next = cu.i + 1 < cu.s.length ? cu.s.charCodeAt(cu.i + 1) : -1;
    if (next !== 32 && next !== 9 && cu.i + 1 < cu.s.length) return null;
    if (cu.i + 1 >= cu.s.length) {
      // empty item: marker alone on the line
      return { bullet: true, ordered: false, start: 0, delim: '', marker: c, markerLen: 1, contentCol: cu.col + 2 };
    }
    // spaces after the marker (1-4); 5+ means the marker is not a list marker
    let j = cu.i + 1;
    let spaces = 0;
    while (j < cu.s.length && (cu.s.charCodeAt(j) === 32 || cu.s.charCodeAt(j) === 9)) {
      spaces += cu.s.charCodeAt(j) === 9 ? 4 - ((cu.col + 1 + spaces) % 4) : 1;
      j++;
    }
    if (spaces === 0) return null;
    if (j >= cu.s.length) {
      // marker + only spaces: empty item; content indent is marker + 1
      return { bullet: true, ordered: false, start: 0, delim: '', marker: c, markerLen: 1, contentCol: cu.col + 2 };
    }
    // 5+ spaces: content indent is marker + 1 space; the rest is content.
    if (spaces >= 5) return { bullet: true, ordered: false, start: 0, delim: '', marker: c, markerLen: 1, contentCol: cu.col + 2 };
    return { bullet: true, ordered: false, start: 0, delim: '', marker: c, markerLen: 1, contentCol: cu.col + 1 + spaces };
  }
  if (c >= 48 && c <= 57) {
    let i = cu.i;
    let num = 0;
    let digits = 0;
    while (i < cu.s.length && cu.s.charCodeAt(i) >= 48 && cu.s.charCodeAt(i) <= 57 && digits < 9) {
      num = num * 10 + (cu.s.charCodeAt(i) - 48);
      i++;
      digits++;
    }
    if (digits === 0 || digits > 9) return null;
    if (i >= cu.s.length) return null;
    const d = cu.s.charCodeAt(i);
    if (d !== 46 && d !== 41) return null;
    const delim = d === 46 ? '.' : ')';
    const next = i + 1 < cu.s.length ? cu.s.charCodeAt(i + 1) : -1;
    if (i + 1 < cu.s.length && next !== 32 && next !== 9) return null;
    if (i + 1 >= cu.s.length) {
      return { bullet: false, ordered: true, start: num, delim, markerLen: digits + 1, contentCol: cu.col + digits + 2 };
    }
    let j = i + 1;
    let spaces = 0;
    while (j < cu.s.length && (cu.s.charCodeAt(j) === 32 || cu.s.charCodeAt(j) === 9)) {
      spaces += cu.s.charCodeAt(j) === 9 ? 4 - ((cu.col + digits + 1 + spaces) % 4) : 1;
      j++;
    }
    if (spaces === 0) return null;
    if (j >= cu.s.length) {
      return { bullet: false, ordered: true, start: num, delim, markerLen: digits + 1, contentCol: cu.col + digits + 2 };
    }
    if (spaces >= 5) return { bullet: false, ordered: true, start: num, delim, markerLen: digits + 1, contentCol: cu.col + digits + 2 };
    return { bullet: false, ordered: true, start: num, delim, markerLen: digits + 1, contentCol: cu.col + digits + 1 + spaces };
  }
  return null;
}

// GFM table delimiter row: cells of - / :- / -: / :-: separated by '|',
// optional leading/trailing '|'.
function matchTableDelim(s) {
  const t = s.trim();
  if (t.indexOf('-') === -1) return null;
  let inner = t;
  if (inner.charCodeAt(0) === 124) inner = inner.slice(1);
  if (inner.charCodeAt(inner.length - 1) === 124) inner = inner.slice(0, -1);
  if (inner.length === 0) return null;
  const cells = inner.split('|');
  const align = [];
  for (const cell of cells) {
    const c = cell.trim();
    if (!/^:?-+:?$/.test(c)) return null;
    if (c.charCodeAt(0) === 58 && c.charCodeAt(c.length - 1) === 58) align.push('center');
    else if (c.charCodeAt(c.length - 1) === 58) align.push('right');
    else if (c.charCodeAt(0) === 58) align.push('left');
    else align.push(null);
  }
  return align;
}

function splitTableRow(s) {
  // Split a table row on unescaped '|', honouring '\|'. Trims cells.
  let cells = [];
  let cur = '';
  let leadingPipe = false;
  let i = 0;
  const n = s.length;
  if (n > 0 && s.charCodeAt(0) === 124) { leadingPipe = true; i = 1; }
  let trailingPipe = false;
  let end = n;
  // find trailing pipe (last non-space char)
  let lastNonSpace = -1;
  for (let q = n - 1; q >= 0; q--) {
    const c = s.charCodeAt(q);
    if (c !== 32 && c !== 9) { lastNonSpace = q; break; }
  }
  if (lastNonSpace >= 0 && s.charCodeAt(lastNonSpace) === 124) {
    trailingPipe = true;
    end = lastNonSpace;
  }
  for (; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < end && s.charCodeAt(i + 1) === 124) { cur += '|'; i++; continue; }
    if (c === 124) { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  if (cells.length === 0) cells = [''];
  return cells;
}


function parseBlocks(lines, refs) {
  const doc = { t: 'doc', children: [] };
  const stack = [];
  let leaf = null;
  let blankBeforeNext = false;
  // True only when the blank line before the next block was truly empty
  // (zero characters). A whitespace-only line does NOT count for the HTML
  // block trailing-newline rule (marked keeps the `\n` after `-->`
  // when the separator line holds spaces/tabs).
  let blankBeforeNextEmpty = false;

  const curContainer = () => (stack.length ? stack[stack.length - 1] : doc);
  const addBlock = (b) => {
    b.blankBefore = blankBeforeNext;
    b.blankBeforeEmpty = blankBeforeNextEmpty;
    blankBeforeNext = false; blankBeforeNextEmpty = false;
    // A list only holds items; a non-item block closes any trailing list.
    while (stack.length && stack[stack.length - 1].t === 'list') {
      finalizeList(stack.pop());
    }
    b.parent = curContainer();
    // A blank line before a block inside an item that already has content
    // makes the item (and its list) loose, even if the block is later
    // removed as a link reference definition.
    if (b.parent.t === 'item' && b.blankBefore && b.parent.children.length > 0) {
      b.parent.loose = true;
    }
    curContainer().children.push(b);
    return b;
  };
  const closeLeaf = () => {
    if (!leaf) return;
    if (leaf.t === 'para') {
      const rest = extractRefDefs(leaf.lines, refs);
      if (rest === null) {
        const p = leaf.parent;
        const idx = p.children.indexOf(leaf);
        if (idx !== -1) p.children.splice(idx, 1);
      } else {
        leaf.lines = rest;
      }
    }
    if (leaf.t === 'code') {
      while (leaf.lines.length && leaf.lines[leaf.lines.length - 1] === '') leaf.lines.pop();
    }
    leaf = null;
  };
  const finalizeItem = (item) => {
    if (item.children.length && item.children[0].t === 'para') {
      const p = item.children[0];
      if (p.lines.length) {
        const first = p.lines[0];
        const m = first.match(/^\[([ xX])\][ \t]+/);
        if (m) {
          item.task = m[1] === ' ' ? 'unchecked' : 'checked';
          p.lines[0] = first.slice(m[0].length);
        }
      }
    }
  };
  const finalizeList = (list) => {
    let loose = false;
    for (let ii = 0; ii < list.children.length; ii++) {
      const item = list.children[ii];
      if (ii > 0 && item.blankBefore) loose = true;
      if (item.loose) loose = true;
      for (let ci = 1; ci < item.children.length; ci++) {
        if (item.children[ci].blankBefore) loose = true;
      }
    }
    list.tight = !loose;
  };
  const closeTo = (depth) => {
    closeLeaf();
    while (stack.length > depth) {
      const b = stack.pop();
      if (b.t === 'item') finalizeItem(b);
      else if (b.t === 'list') finalizeList(b);
    }
  };
  // Convert the current paragraph leaf into a setext heading of `level`.
  // Returns true when a heading was created, false when the paragraph was
  // entirely link reference definitions (no heading; the caller must not
  // consume the current line as a setext underline).
  const paraToHeading = (level) => {
    // A setext heading's content is the paragraph's content with the first
    // line's leading whitespace and the last line's trailing whitespace
    // stripped; middle lines keep their leading whitespace. Link reference
    // definitions are extracted first (they are not heading content).
    const rest = extractRefDefs(leaf.lines, refs);
    if (rest === null) {
      // The paragraph was entirely definitions: remove it, no heading.
      const p = leaf.parent;
      const idx = p.children.indexOf(leaf);
      if (idx !== -1) p.children.splice(idx, 1);
      leaf = null;
      return false;
    }
    const ls = rest;
    if (ls.length) {
      ls[0] = ls[0].replace(/^[ \t]+/, '');
      ls[ls.length - 1] = ls[ls.length - 1].replace(/[ \t]+$/, '');
    }
    const content = ls.join('\n');
    const p = leaf.parent;
    const idx = p.children.indexOf(leaf);
    const head = { t: 'head', level, content, blankBefore: leaf.blankBefore, blankBeforeEmpty: leaf.blankBeforeEmpty, parent: p };
    p.children[idx] = head;
    leaf = null;
    return true;
  };

  // Does the line at the cursor start a block that can interrupt a paragraph?
  const startsInterrupt = (cu) => {
    const saveI = cu.i, saveCol = cu.col, saveS = cu.s;
    let sp = 0;
    while (sp < 3 && (curCh(cu) === 32 || curCh(cu) === 9)) { advanceOne(cu); sp++; }
    const c = curCh(cu);
    let r = false;
    if (c === 35) r = matchAtx(cu) > 0;
    else if (c === 96 || c === 126) r = matchFence(cu) !== null;
    else if (c === 60) {
      const hb = htmlBlockType(cu);
      // Type 7 (a lone tag) cannot interrupt a paragraph; types 1-6 can.
      r = hb !== null && hb.type !== 7;
    }
    else if (c === 62) r = true;
    else if (c === 45 || c === 95 || c === 42) {
      r = matchThematicBreak(cu);
      if (!r && c !== 95) {
        const lm = matchListMarker(cu);
        if (lm) r = listInterrupts(lm, cu);
      }
    } else if (c === 43 || (c >= 48 && c <= 57)) {
      const lm = matchListMarker(cu);
      if (lm) r = listInterrupts(lm, cu);
    }
    cu.i = saveI; cu.col = saveCol; cu.s = saveS;
    return r;
  };

  // Does a list marker interrupt the open paragraph? Inside a list item any
  // marker does (a new item or a new list ends the item's paragraph).
  // Otherwise only a bullet or an ordered marker starting at 1, and only
  // when the item is non-empty.
  const listInterrupts = (lm, cu) => {
    // The paragraph may be nested (e.g. inside a blockquote) within an item.
    let p = leaf && leaf.parent;
    while (p) {
      if (p.t === 'item') return true;
      p = p.parent;
    }
    if (!lm.bullet && lm.start !== 1) return false;
    // An empty item (marker alone on the line) does not interrupt.
    let j = cu.i + lm.markerLen;
    while (j < cu.s.length && (cu.s.charCodeAt(j) === 32 || cu.s.charCodeAt(j) === 9)) j++;
    return j < cu.s.length;
  };

  lineLoop: for (let li = 0; li < lines.length; li++) {
    const rawLine = lines[li];
    if (isBlankLine(rawLine)) {
      // A line containing a TAB (but no other content) inside a table is
      // a row of empty cells, not a blank line ending the table (marked
      // keeps the table going through a tab-only line; a spaces-only line
      // DOES end it — doc-21's `   ` ends the table, doc-26's `\t` is a
      // row). Only a truly empty line, or a spaces-only line, ends it.
      if (leaf && leaf.t === 'table' && rawLine.indexOf('\t') !== -1) {
        leaf.rows.push(splitTableRow(rawLine));
        blankBeforeNext = false; blankBeforeNextEmpty = false;
        continue;
      }
      // A blank line ends a blockquote (and everything inside it) and an
      // empty list item; a list itself survives blank lines.
      if (leaf && (leaf.t === 'fence' || leaf.t === 'html' || leaf.t === 'code')) {
        let qd = -1;
        for (let d = 0; d < stack.length; d++) if (stack[d].t === 'quote') { qd = d; break; }
        if (qd >= 0) {
          // A blank line inside a fence in a quote ends the quote (and
          // the fence) — but NOT an enclosing list/item, which survives
          // blank lines and continues with later items. Close only up
          // to the blockquote, not the whole stack.
          closeTo(qd);
          blankBeforeNext = true;
          blankBeforeNextEmpty = (rawLine === '');
          continue;
        }
        if (leaf.t === 'code') {
          // Indented code: strip up to 4 spaces; the rest (if any) is content.
          let k = 0;
          while (k < rawLine.length && k < 4 && rawLine.charCodeAt(k) === 32) k++;
          leaf.lines.push(rawLine.slice(k));
          continue;
        }
        if (leaf.t === 'fence') {
          leaf.lines.push(rawLine);
          continue;
        }
        // html: types 6/7 end at a blank line; types 1-5 keep it raw.
        if (leaf.endRe === null) {
          closeLeaf();
          blankBeforeNext = true;
          blankBeforeNextEmpty = (rawLine === '');
          continue;
        }
        leaf.lines.push(rawLine);
        continue;
      }
      closeLeaf();
      // Close any open blockquote (a blank line ends it).
      let qd = -1;
      for (let d = 0; d < stack.length; d++) if (stack[d].t === 'quote') { qd = d; break; }
      if (qd >= 0) closeTo(qd);
      // An empty list item is closed by a blank line (the list stays open
      // for later items).
      const top = stack.length ? stack[stack.length - 1] : null;
      if (top && top.t === 'item' && top.children.length === 0) closeTo(stack.length - 1);
      blankBeforeNext = true;
      blankBeforeNextEmpty = (rawLine === '');
      continue;
    }

    const cu = makeCursor(rawLine);
    // --- Phase 1: match open containers, outermost first ---
    let matchedDepth = 0;
    const stackLenAtPhase1 = stack.length;
    for (let d = 0; d < stack.length; d++) {
      const cont = stack[d];
      const saveI = cu.i, saveCol = cu.col, saveS = cu.s;
      if (cont.t === 'quote') {
        let sp = 0;
        while (sp < 3 && (curCh(cu) === 32 || curCh(cu) === 9)) { advanceOne(cu); sp++; }
        if (curCh(cu) === 62) {
          advanceOne(cu);
          if (curCh(cu) === 32 || curCh(cu) === 9) advanceOne(cu);
          matchedDepth = d + 1;
          continue;
        }
        cu.i = saveI; cu.col = saveCol; cu.s = saveS;
        break;
      } else if (cont.t === 'list') {
        matchedDepth = d + 1;
        continue;
      } else if (cont.t === 'item') {
        const need = cont.contentCol - cu.col;
        // Already past the content column: only still inside the item
        // for a paragraph continuation (a new block after a blank line
        // at a deeper column belongs to the outer container, cm-260).
        if (need <= 0) {
          if (leaf && leaf.t === 'para') { matchedDepth = d + 1; continue; }
          cu.i = saveI; cu.col = saveCol; cu.s = saveS;
          break;
        }
        // An empty (or whitespace-only) remainder is inside the item.
        if (/^[ \t]*$/.test(cu.s.slice(cu.i))) { matchedDepth = d + 1; continue; }
        if (skipIndent(cu, need)) { matchedDepth = d + 1; continue; }
        cu.i = saveI; cu.col = saveCol; cu.s = saveS;
        break;
      }
    }

    // --- Lazy paragraph continuation (not for an empty line: that ends
    // the paragraph and its containers) ---
    if (matchedDepth < stack.length && leaf && leaf.t === 'para' && cu.i < cu.s.length && !startsInterrupt(cu)) {
      let line = cu.s.slice(cu.i);
      // A lazy line in a container with 4+ columns of leading whitespace
      // loses 4 columns (indented-code stripping); fewer columns are kept.
      const inner = stack[matchedDepth];
      if (inner && (inner.t === 'quote' || inner.t === 'item')) {
        let cols = 0, k = 0;
        while (k < line.length) {
          const c = line.charCodeAt(k);
          if (c === 32) { cols++; k++; }
          else if (c === 9) { cols += 4 - (cols % 4); k++; }
          else break;
        }
        if (cols >= 4) {
          let stripped = 0, j = 0, out = '';
          while (stripped < 4 && j < line.length) {
            const c = line.charCodeAt(j);
            if (c === 32) { stripped++; j++; }
            else if (c === 9) {
              const w = 4 - (stripped % 4);
              if (stripped + w <= 4) { stripped += w; j++; }
              else { out = ' '.repeat(stripped + w - 4); stripped = 4; j++; }
            } else break;
          }
          line = out + line.slice(j);
        }
      }
      const m = line.match(/^ {0,3}(=+|-+)[ \t]*$/);
      if (m && m[1].charCodeAt(0) === 61) {
        // lazy '=' setext underline
        if (inner && inner.t === 'quote') {
          // marked quirk: 4 spaces if the previous paragraph line was lazy
          const trail = (line.match(/=+([ \t]*)$/) || [])[1] || '';
          leaf.lines.push(leaf.lastWasLazy ? '    ' + m[1] + trail : line);
          leaf.lastWasLazy = true;
          blankBeforeNext = false; blankBeforeNextEmpty = false;
          continue;
        }
        // list item (or other): forms a setext heading
        if (paraToHeading(1)) { blankBeforeNext = false; blankBeforeNextEmpty = false; continue; }
        // No heading (paragraph was all defs): fall through to Phase 2/3
        // so the line is processed as a fresh line.
      }
      if (leaf) {
        leaf.lines.push(line);
        leaf.lastWasLazy = true;
        blankBeforeNext = false; blankBeforeNextEmpty = false;
        continue;
      }
    }
    // Fenced code inside a list item: content lines are raw and do not need
    // to match the item container. If the fence is in a list item (not a
    // blockquote) and the containers did not all match, treat the raw line
    // as fence content (closing fence or content, stripped by absolute
    // indent, leading tab expanded by absolute column).
    if (leaf && leaf.t === 'fence' && matchedDepth < stack.length) {
      let inQuote = false, inItem = false;
      for (let d = 0; d < stack.length; d++) {
        if (stack[d].t === 'quote') inQuote = true;
        if (stack[d].t === 'item') inItem = true;
      }
      // Only consume the line as fence content if it is part of the item:
      // blank, or indented to at least the fence's absolute column — but
      // ONLY while the fence is still empty. A flush-left (or
      // under-indented) non-blank line as the FIRST content line ends the
      // item, so the fence is empty (doc-17: `if my-package previous` at
      // col 0 right after ```toml). Once the fence already holds content,
      // later under-indented lines are fence content (doc-02: `function
      // f(a, b) {` at col 0 after two indented lines stays in the fence).
      const abs0 = leaf.absIndent || 0;
      let indCol = 0, ip = 0;
      while (ip < rawLine.length) {
        const ch = rawLine.charCodeAt(ip);
        if (ch === 32) { indCol++; ip++; }
        else if (ch === 9) { indCol += 4 - (indCol % 4); ip++; }
        else break;
      }
      const inItemLine = leaf.lines.length > 0 || ip >= rawLine.length || indCol >= abs0;
      if (inItem && !inQuote && inItemLine) {
        const abs = leaf.absIndent || 0;
        let col = 0, p = 0, prefix = '';
        while (p < rawLine.length && col < abs) {
          const ch = rawLine.charCodeAt(p);
          if (ch === 32) { col++; p++; }
          else if (ch === 9) {
            const w = 4 - (col % 4);
            if (col + w > abs) { prefix = ' '.repeat(col + w - abs); p++; col = abs; }
            else { col += w; p++; }
          } else break;
        }
        // A tab exactly at the boundary expands to spaces (in a container).
        let content = prefix + rawLine.slice(p);
        if (prefix === '' && content.charCodeAt(0) === 9) {
          const w = 4 - (abs % 4);
          content = ' '.repeat(w) + content.slice(1);
        }
        // Closing fence? (up to 3 spaces, then >= len markers, whitespace only)
        let q = 0;
        while (q < content.length && q < 3 && content.charCodeAt(q) === 32) q++;
        let mlen = 0;
        while (q + mlen < content.length && content.charCodeAt(q + mlen) === leaf.marker) mlen++;
        const closing = mlen >= leaf.len && /^[ \t]*$/.test(content.slice(q + mlen));
        if (closing) { closeLeaf(); blankBeforeNext = false; blankBeforeNextEmpty = false; continue; }
        leaf.lines.push(content);
        blankBeforeNext = false; blankBeforeNextEmpty = false;
        continue;
      }
    }
    if (matchedDepth < stack.length) closeTo(matchedDepth);

    // --- Phase 2: open fenced / html / indented code leaf ---
    if (leaf && leaf.t === 'fence') {
      const saveI = cu.i, saveCol = cu.col, saveS = cu.s;
      let sp = 0;
      while (sp < 3 && (curCh(cu) === 32 || curCh(cu) === 9)) { advanceOne(cu); sp++; }
      const c = curCh(cu);
      let closing = false;
      if (c === leaf.marker) {
        let k = cu.i;
        let len = 0;
        while (k < cu.s.length && cu.s.charCodeAt(k) === c) { len++; k++; }
        if (len >= leaf.len && /^[ \t]*$/.test(cu.s.slice(k))) closing = true;
      }
      cu.i = saveI; cu.col = saveCol; cu.s = saveS;
      if (closing) { closeLeaf(); blankBeforeNext = false; blankBeforeNextEmpty = false; continue; }
      // Strip up to the opening fence's indentation from the content line.
      // Inside a container (cu.col > 0) leading tabs expand to spaces by
      // absolute column before the indent is stripped; at the top level a
      // leading tab is kept literally.
      if (cu.col > 0) {
        let col = 0;
        let p = cu.i;
        let spaces = '';
        while (p < cu.s.length) {
          const ch = cu.s.charCodeAt(p);
          if (ch === 32) { spaces += ' '; col++; p++; }
          else if (ch === 9) {
            const w = 4 - ((cu.col + col) % 4);
            spaces += ' '.repeat(w); col += w; p++;
          } else break;
        }
        leaf.lines.push(spaces.slice(leaf.indent) + cu.s.slice(p));
      } else {
        let stripped = 0;
        let p = cu.i;
        while (stripped < leaf.indent && p < cu.s.length && cu.s.charCodeAt(p) === 32) { stripped++; p++; }
        leaf.lines.push(cu.s.slice(p));
      }
      blankBeforeNext = false; blankBeforeNextEmpty = false;
      continue;
    }
    if (leaf && leaf.t === 'html') {
      const line = cu.s.slice(cu.i);
      leaf.lines.push(line);
      if (leaf.endRe !== null && leaf.endRe.test(line)) closeLeaf();
      blankBeforeNext = false; blankBeforeNextEmpty = false;
      continue;
    }
    if (leaf && leaf.t === 'code') {
      const saveI = cu.i, saveCol = cu.col, saveS = cu.s;
      if (skipIndent(cu, 4)) {
        leaf.lines.push(cu.s.slice(cu.i));
        blankBeforeNext = false; blankBeforeNextEmpty = false;
        continue;
      }
      cu.i = saveI; cu.col = saveCol; cu.s = saveS;
      closeLeaf();
    }

    // --- Phase 3: start new blocks (loop: one line can open several) ---
    let handled = false;
    let guard = 0;
    while (!handled && guard++ < 12) {
      const contentStart = cu.i;
      // A line empty after its container prefixes ends the paragraph
      // (a blank line inside the container). It counts as a blank line
      // for looseness unless it is nested inside a list item (i.e. the
      // innermost matched container is a non-item inside an item, e.g. a
      // blockquote inside an item) — then it separates nothing at the
      // outer level. When the innermost matched container IS the item
      // itself, the blank line lies directly between that item's children
      // and must loosen it (doc-11: blank `>` between a paragraph and a
      // fence inside the same item).
      // Skip the end-of-line reset so blankBeforeNext survives.
      if (cu.i >= cu.s.length) {
        if (leaf && leaf.t === 'para') closeLeaf();
        let nestedInItem = false;
        if (matchedDepth > 0 && stack[matchedDepth - 1].t !== 'item') {
          for (let d = 0; d < matchedDepth - 1; d++) {
            if (stack[d].t === 'item') { nestedInItem = true; break; }
          }
        }
        if (!nestedInItem) { blankBeforeNext = true; blankBeforeNextEmpty = false; }
        handled = true;
        continue lineLoop;
      }
      let sp = 0;
      while (sp < 3 && (curCh(cu) === 32 || curCh(cu) === 9)) { advanceOne(cu); sp++; }

      if (leaf && leaf.t === 'para') {
        // Setext underlines and table delimiters need at most 3 leading spaces.
        const indented4 = sp === 3 && (curCh(cu) === 32 || curCh(cu) === 9);
        const st = indented4 ? 0 : matchSetext(cu);
        if (st > 0) {
          if (paraToHeading(st)) { handled = true; break; }
          // No heading (paragraph was all defs): the line is a fresh line.
          closeLeaf();
        }
        if (leaf && leaf.lines.length === 1 && !indented4) {
          const align = matchTableDelim(cu.s.slice(cu.i));
          if (align) {
            const header = splitTableRow(leaf.lines[0]);
            // The delimiter must have exactly as many columns as the header.
            if (align.length === header.length) {
              const p = leaf.parent;
              const idx = p.children.indexOf(leaf);
              const table = { t: 'table', align, header, rows: [], blankBefore: leaf.blankBefore, blankBeforeEmpty: leaf.blankBeforeEmpty, parent: p };
              p.children[idx] = table;
              leaf = table;
              handled = true;
              break;
            }
          }
        }
      }
      if (leaf && leaf.t === 'table') {
        // A line starting a blockquote (or other interrupting block) ends
        // the table; it is not a table row. A fence line or a list-marker
        // line also ends it (doc-07: `* Lexer...` starts a <ul>; doc-33:
        // ```bash starts a fenced block).
        let p0 = cu.i;
        while (p0 < cu.s.length && p0 - cu.i < 3 && cu.s.charCodeAt(p0) === 32) p0++;
        if (p0 < cu.s.length && cu.s.charCodeAt(p0) === 62) {
          closeLeaf();
        } else if (matchFence(cu) !== null || matchListMarker(cu) !== null) {
          closeLeaf();
        } else {
          leaf.rows.push(splitTableRow(cu.s.slice(cu.i)));
          handled = true;
          break;
        }
      }

      const c = curCh(cu);
      if (c === 35) {
        const level = matchAtx(cu);
        if (level > 0) {
          closeLeaf();
          addBlock({ t: 'head', level, content: atxContent(cu, level) });
          handled = true;
          break;
        }
      }
      if (c === 96 || c === 126) {
        const f = matchFence(cu);
        if (f) {
          closeLeaf();
          // A TILDE fence inside a blockquote keeps its content's
          // leading spaces after the `> ` prefix: marked does not strip
          // the fence's indentation there (probed: fence indent 3,
          // content indent 2–5 all keep every space). A BACKTICK fence
          // in the same place DOES strip its indent. Set indent 0 only
          // for tilde fences in a quote; backtick fences keep sp.
          let inQuoteF = false;
          for (let d = 0; d < stack.length; d++) if (stack[d].t === 'quote') { inQuoteF = true; break; }
          leaf = addBlock({ t: 'fence', marker: f.marker, len: f.len, info: f.info, indent: (inQuoteF && f.marker === 126) ? 0 : sp, absIndent: cu.col, lines: [] });
          handled = true;
          break;
        }
      }
      if (c === 45 || c === 95 || c === 42) {
        if (matchThematicBreak(cu)) {
          closeLeaf();
          addBlock({ t: 'hr' });
          handled = true;
          break;
        }
      }
      if (c === 60) {
        const hb = htmlBlockType(cu);
        // Type 7 (a lone tag) cannot interrupt a paragraph; types 1-6 can.
        if (hb !== null && !(leaf && leaf.t === 'para' && hb.type === 7)) {
          closeLeaf();
          // The HTML block keeps the line's leading spaces (raw HTML).
          const firstLine = cu.s.slice(contentStart);
          leaf = addBlock({ t: 'html', type: hb.type, endRe: hb.endRe, lines: [firstLine] });
          // If the first line already holds the end marker, the block ends now.
          if (hb.endRe !== null && hb.endRe.test(firstLine)) leaf = null;
          handled = true;
          break;
        }
      }
      if (c === 62) {
        closeLeaf();
        const nb = addBlock({ t: 'quote', children: [] });
        stack.push(nb);
        advanceOne(cu);
        if (curCh(cu) === 32 || curCh(cu) === 9) advanceOne(cu);
        continue;
      }
      const lm = matchListMarker(cu);
      if (lm) {
        const canInterrupt = !leaf || leaf.t !== 'para' || listInterrupts(lm, cu);
        if (canInterrupt) {
          closeLeaf();
          const cont = curContainer();
          let list = null;
          let listOnStack = false;
          // Reuse the current list (still open) when the marker matches it.
          if (cont.t === 'list' && cont.bullet === lm.bullet && cont.ordered === !lm.bullet &&
              (lm.bullet ? cont.marker === lm.marker : cont.delim === lm.delim)) {
            list = cont;
            listOnStack = true;
          } else {
            list = addBlock({ t: 'list', bullet: lm.bullet, ordered: !lm.bullet, start: lm.start, delim: lm.delim, marker: lm.marker, children: [] });
          }
          // Nested blockquotes each consume `>` + a space, but the list
          // content indent is measured from the innermost blockquote's
          // content start: every blockquote beyond the first shifts the
          // content column by one less (marked: `> > 1. one` has
          // contentCol 6, not 7; `> > > 1. one` has 7, not 9). Leading
          // spaces before the first container marker on the opening line
          // are the container's indentation, not the item's: they must
          // not inflate the content column (cm-259: `   > > 1.  one`
          // has contentCol 7, the same as `> > 1.  one`). The first
          // line's content still starts at the unadjusted column.
          let nQuotes = 0;
          for (let d = 0; d < stack.length; d++) if (stack[d].t === 'quote') nQuotes++;
          let leadSpaces = 0;
          if (nQuotes > 0) {
            const m0 = rawLine.match(/^ */);
            leadSpaces = m0 ? m0[0].length : 0;
          }
          const targetCol = Math.max(lm.contentCol - Math.max(0, nQuotes - 1) - leadSpaces, 0)
            // When the opening line's first `>` is directly followed by
            // the marker (no space, e.g. `>16.`), the blockquote consumed
            // only 1 column there, but continuation lines like `>    First`
            // consume `> ` (2 columns) — a 1-column mismatch that would
            // wrongly pull the paragraph into the item. Compensate +1.
            + ((nQuotes > 0 && rawLine.length > leadSpaces + 1 && rawLine[leadSpaces] === '>' && rawLine[leadSpaces + 1] !== ' ' && rawLine[leadSpaces + 1] !== '\t' && rawLine[leadSpaces + 1] !== '>') ? 1 : 0);
          const firstLineCol = lm.contentCol;
          // Consume the marker itself, then spaces/tabs up to the content column.
          for (let k = 0; k < lm.markerLen; k++) advanceOne(cu);
          while (cu.col < firstLineCol && (curCh(cu) === 32 || curCh(cu) === 9)) advanceOne(cu);
          const item = { t: 'item', children: [], task: null, contentCol: targetCol, blankBefore: blankBeforeNext, blankBeforeEmpty: blankBeforeNextEmpty, parent: list };
          blankBeforeNext = false; blankBeforeNextEmpty = false;
          list.children.push(item);
          if (!listOnStack) stack.push(list);
          stack.push(item);
          if (cu.i >= cu.s.length) { handled = true; break; }
          continue;
        }
      }
      // Indented code: 4+ spaces of indentation, not in a paragraph.
      if ((!leaf || leaf.t !== 'para') && sp === 3 && (curCh(cu) === 32 || curCh(cu) === 9)) {
        closeLeaf();
        advanceOne(cu);
        leaf = addBlock({ t: 'code', lines: [cu.s.slice(cu.i)] });
        handled = true;
        break;
      }
      // Paragraph (default). Content keeps its leading spaces. A line that
      // is empty (or only whitespace) after the container prefixes does not
      // start a paragraph.
      if (!leaf || leaf.t !== 'para') {
        if (cu.s.slice(contentStart).trim() === '') { handled = true; break; }
        closeLeaf();
        leaf = addBlock({ t: 'para', lines: [] });
      }
      leaf.lines.push(cu.s.slice(contentStart));
      leaf.lastWasLazy = false;
      handled = true;
      break;
    }
    blankBeforeNext = false; blankBeforeNextEmpty = false;
  }

  closeTo(0);
  return doc;
}

// ---------------------------------------------------------------------------
// Rendering (marked 18.1.3 output shape)
// ---------------------------------------------------------------------------

function renderBlocks(children, refs) {
  let out = '';
  for (let bi = 0; bi < children.length; bi++) {
    const b = children[bi];
    switch (b.t) {
      case 'para': {
        const src = b.lines.join('\n');
        out += '<p>' + renderInline(parseInline(src, refs), src) + '</p>\n';
        break;
      }
      case 'head': {
        out += '<h' + b.level + '>' + renderInline(parseInline(b.content, refs), b.content) + '</h' + b.level + '>\n';
        break;
      }
      case 'hr': out += '<hr>\n'; break;
      case 'fence': {
        const info = b.info ? ' class="language-' + escText(b.info.split(/\s+/)[0]) + '"' : '';
        // One trailing blank line of fence content is dropped.
        const lines = b.lines;
        const n = lines.length;
        const body = (n > 0 && lines[n - 1] === '')
          ? lines.slice(0, n - 1).join('\n') + (n - 1 > 0 ? '\n' : '')
          : lines.join('\n') + (n ? '\n' : '');
        out += '<pre><code' + info + '>' + escDumb(body) + '</code></pre>\n';
        break;
      }
      case 'code': {
        out += '<pre><code>' + escDumb(b.lines.join('\n') + (b.lines.length ? '\n' : '')) + '</code></pre>\n';
        break;
      }
      case 'html': {
        out += b.lines.join('\n');
        // A trailing newline when the next sibling follows. For types
        // 1–5 only a truly empty separator line suppresses it; a
        // whitespace-only line (spaces/tabs) does not (marked keeps the
        // `\n` then). For type 6 (block tag) ANY blank separator line
        // suppresses it (probed: `<div>` + `\t` → no `\n`).
        const next = children[bi + 1];
        if (next && !(b.type === 6 ? next.blankBefore : next.blankBeforeEmpty)) out += '\n';
        break;
      }
      case 'quote': {
        out += '<blockquote>\n' + renderBlocks(b.children, refs) + '</blockquote>\n';
        break;
      }
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const start = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
        out += '<' + tag + start + '>\n';
        for (const item of b.children) out += renderItem(item, b.tight, refs);
        out += '</' + tag + '>\n';
        break;
      }
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let ci = 0; ci < b.header.length; ci++) {
          const cell = b.header[ci];
          const al = b.align[ci];
          out += '<th' + (al ? ' align="' + al + '"' : '') + '>' + renderInline(parseInline(cell, refs), cell) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (b.rows.length === 0) {
          out += '</table>\n';
          break;
        }
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let ci = 0; ci < b.header.length; ci++) {
            const cell = ci < row.length ? row[ci] : '';
            const al = b.align[ci];
            out += '<td' + (al ? ' align="' + al + '"' : '') + '>' + renderInline(parseInline(cell, refs), cell) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody></table>\n';
        break;
      }
    }
  }
  return out;
}

function renderItem(item, tight, refs) {
  let inner = '';
  if (tight) {
    // tight: paragraphs render without <p>, other blocks as-is
    for (const b of item.children) {
      if (b.t === 'para') {
        const src = b.lines.join('\n');
        inner += renderInline(parseInline(src, refs), src);
      } else {
        inner += renderBlocks([b], refs);
      }
    }
  } else {
    inner = renderBlocks(item.children, refs);
  }
  let prefix = '';
  if (item.task) {
    prefix = item.task === 'checked'
      ? '<input checked="" disabled="" type="checkbox"> '
      : '<input disabled="" type="checkbox"> ';
  }
  if (tight) {
    return '<li>' + prefix + inner + '</li>\n';
  }
  // loose: the checkbox goes inside the first paragraph
  if (item.task && item.children.length && item.children[0].t === 'para') {
    const first = item.children[0];
    const src = first.lines.join('\n');
    const rest = renderBlocks(item.children.slice(1), refs);
    inner = '<p>' + prefix + renderInline(parseInline(src, refs), src) + '</p>\n' + rest;
    return '<li>' + inner + '</li>\n';
  }
  return '<li>' + prefix + inner + '</li>\n';
}
