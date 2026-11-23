// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Byte-identical output, single-pass design:
//  - chunked HTML escaping (plain runs sliced, specials replaced in one native pass)
//  - slugify with per-run cache + ASCII fast path (no NFKD for pure ASCII)
//  - front matter parsed by hand (no per-line regexes)
//  - Markdown lexed + rendered in one fused pass over the line array
//  - templates rendered into an array joined once
// Nothing is kept between run() calls: the slug cache is created fresh per run().

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------------ text */

// HTML escape table (README "Text"), in this order.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
const escReplacer = (ch) => ESCAPES[ch];

/** Escape the slice s[a..b) of s, pushed onto out. */
function escRange(s, a, b, out) {
  if (b <= a) return;
  // One native pass; with no match replace returns the slice unchanged.
  out.push(s.slice(a, b).replace(ESC_RE, escReplacer));
}

/** Escape a whole string (small strings: titles, hrefs). */
function escStr(s) {
  return s.replace(ESC_RE, escReplacer);
}

const SLUG_MAX = 64;
const NONASCII = /[^\x00-\x7F]/;

/** The slug of `text`, exactly as makefun-site's slugify (NFKD, drop \p{M}, lower, runs -> '-'). */
function slugifyRaw(text) {
  let plain = text;
  if (NONASCII.test(text)) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) {
    out = out.slice(0, SLUG_MAX);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
  }
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Whether char code c is a JS \s whitespace (ASCII set + the Unicode spaces). */
function isWSCode(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 ||
    c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 ||
    c === 8239 || c === 8287 || c === 12288 || c === 65279
  );
}

/* ------------------------------------------------------------------ front matter */

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isNameChar(c) {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = false;
      let y = 0, mo = 0, d = 0;
      if (
        raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45 &&
        isDigit(raw, 0) && isDigit(raw, 1) && isDigit(raw, 2) && isDigit(raw, 3) &&
        isDigit(raw, 5) && isDigit(raw, 6) && isDigit(raw, 8) && isDigit(raw, 9)
      ) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let k = 0; k < tags.length; k++) {
        const t = tags[k].trim();
        tags[k] = t;
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1)
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) if (!isNameChar(raw.charCodeAt(i))) return { error: 'key "layout": not a template name' };
      return { value: raw };
    }
    case 'slug': {
      // /^[a-z0-9]+(?:-[a-z0-9]+)*$/ and at most 64 chars.
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true; // no leading dash
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isDigit(s, i) {
  const c = s.charCodeAt(i);
  return c >= 48 && c <= 57;
}

/** Whether a line is blank (spaces and tabs only). */
function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter: { data, lines, start } (body starts at lines[start]),
 * or { error } with the first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    const ci = line.indexOf(':');
    if (ci <= 0) return { error: `line ${i + 1} is not "key: value"` };
    let keyOk = true;
    for (let k = 0; k < ci; k++) {
      const c = line.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) {
        keyOk = false;
        break;
      }
    }
    if (!keyOk) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, ci);
    let raw;
    if (ci === line.length - 1) raw = '';
    else if (line.charCodeAt(ci + 1) === 32) raw = line.slice(ci + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    // Drop trailing spaces and tabs from the raw value.
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c !== 32 && c !== 9) break;
      e--;
    }
    if (e !== raw.length) raw = raw.slice(0, e);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, lines, start: close + 1 };
}

/* ------------------------------------------------------------------ Markdown inline */

// The characters a backslash escapes (as codes).
function isEscapableCode(c) {
  return (
    c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 || c === 40 ||
    c === 41 || c === 35 || c === 43 || c === 45 || c === 46 || c === 33 || c === 62
  );
}

const WS_TEST = /\s/;
/** The structural inline chars, found with one native regex scan per segment. */
const STRUCT_RE = /[\\*\[`]/g;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline into `out` (an array of string chunks); `env.link(target)` is a link's href.
 * Plain runs are flushed escaped in one slice; structural chars are found with one regex exec.
 * (STRUCT_RE's lastIndex is set before every exec — inlineTo recurses — so sharing it is safe.)
 */
function inlineTo(s, env, out) {
  const n = s.length;
  let i = 0;
  let plain = 0;
  while (i < n) {
    STRUCT_RE.lastIndex = i;
    const rm = STRUCT_RE.exec(s);
    const p = rm === null ? -1 : rm.index;
    if (p === -1) break;
    const c = s.charCodeAt(p);
    if (c === 92) {
      const d = p + 1 < n ? s.charCodeAt(p + 1) : -1;
      if (d !== -1 && isEscapableCode(d)) {
        escRange(s, plain, p, out);
        // escapeHtml of the escaped char: only '>' among the escapables needs it.
        out.push(s[p + 1] === '>' ? '&gt;' : s[p + 1]);
        i = p + 2;
        plain = i;
        continue;
      }
      i = p + 1;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', p + 1);
      if (j > p + 1) {
        escRange(s, plain, p, out);
        out.push('<code>');
        escRange(s, p + 1, j, out);
        out.push('</code>');
        i = j + 1;
        plain = i;
        continue;
      }
      i = p + 1;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(p + 1) === 42) {
        const j = findUnescaped(s, '**', p + 2);
        if (j > p + 2) {
          escRange(s, plain, p, out);
          out.push('<strong>');
          inlineTo(s.slice(p + 2, j), env, out);
          out.push('</strong>');
          i = j + 2;
          plain = i;
          continue;
        }
        i = p + 2;
        continue;
      }
      const j = findSingleStar(s, p + 1);
      if (j > p + 1) {
        escRange(s, plain, p, out);
        out.push('<em>');
        inlineTo(s.slice(p + 1, j), env, out);
        out.push('</em>');
        i = j + 1;
        plain = i;
        continue;
      }
      i = p + 1;
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', p + 1);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !WS_TEST.test(target)) {
      escRange(s, plain, p, out);
      out.push('<a href="');
      const href = env.link(target);
      escRange(href, 0, href.length, out);
      out.push('">');
      inlineTo(s.slice(p + 1, k), env, out);
      out.push('</a>');
      i = m + 1;
      plain = i;
      continue;
    }
    i = p + 1;
  }
  escRange(s, plain, n, out);
}

/** `s` rendered inline as one string. */
function inlineStr(s, env) {
  const out = [];
  inlineTo(s, env, out);
  return out.join('');
}

/* ------------------------------------------------------------------ Markdown blocks */

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Fence-open language of a line, or null (line must be ``` + lang chars + spaces/tabs only). */
function fenceOpenLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** Whether a line closes a fence: ``` then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let s = n;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: n, text: line.slice(s, e) };
}

/** Whether a line is a thematic break: --- or *** then spaces or tabs only. */
function isHr(line) {
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let k = 3; k < line.length; k++) {
    const ch = line.charCodeAt(k);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. One first-char switch: most continuation lines start with a letter and return false at once. */
function endsParagraph(line) {
  const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
  if (c0 === -1) return true;
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceOpenLang(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/**
 * A list item start: { ordered, start, rest } or null.
 * Bullet: "- " or "* "; ordered: 1-9 digits then ". ".
 */
function listStart(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, rest: line.slice(2) };
  let j = 0;
  while (j < line.length && j < 9) {
    const c = line.charCodeAt(j);
    if (c < 48 || c > 57) break;
    j++;
  }
  if (j >= 1 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32)
    return { ordered: true, start: Number(line.slice(0, j)), rest: line.slice(j + 2) };
  return null;
}

/** Whether a line continues a list item: two or more spaces then a non-space. */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  if (k < 2 || k >= line.length) return false;
  return !isWSCode(line.charCodeAt(k));
}

/**
 * lines[start..end) rendered: { html, toc, excerpt }. `slug` is the cached slugify.
 * Lex + render fused: each line is visited once, blocks pushed straight to `out`.
 */
function renderBody(lines, start, end, env, slug) {
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = start;
  while (i < end) {
    const line = lines[i];
    // One first-char dispatch, in the reference lexer's priority order
    // (blank, fence, heading, hr, quote, list, paragraph). A line starting
    // with a space/tab can only be blank or a paragraph line; a line starting
    // with a letter (the common case) is a paragraph line at once.
    const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
    if (c0 === -1 || c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
      // Paragraph (indented lines are paragraph text).
      const parts = [trimLine(line)];
      i++;
      while (i < end && !endsParagraph(lines[i])) {
        parts.push(trimLine(lines[i]));
        i++;
      }
      out.push('<p>');
      if (excerpt === null) {
        const tmp = [];
        inlineTo(parts.join('\n'), env, tmp);
        const html = tmp.join('');
        excerpt = html;
        out.push(html);
      } else {
        inlineTo(parts.join('\n'), env, out);
      }
      out.push('</p>', '\n');
      continue;
    }
    if (c0 === 96) {
      const lang = fenceOpenLang(line);
      if (lang === null) {
        // Not a fence: a paragraph.
        const parts = [trimLine(line)];
        i++;
        while (i < end && !endsParagraph(lines[i])) {
          parts.push(trimLine(lines[i]));
          i++;
        }
        out.push('<p>');
        if (excerpt === null) {
          const tmp = [];
          inlineTo(parts.join('\n'), env, tmp);
          const html = tmp.join('');
          excerpt = html;
          out.push(html);
        } else {
          inlineTo(parts.join('\n'), env, out);
        }
        out.push('</p>', '\n');
        continue;
      }
      i++;
      const bodyStart = i;
      while (i < end && !isFenceClose(lines[i])) i++;
      const bodyEnd = i;
      i++;
      out.push('<pre><code');
      if (lang !== '') {
        out.push(' class="language-');
        out.push(lang);
        out.push('"');
      }
      out.push('>');
      for (let k = bodyStart; k < bodyEnd; k++) {
        escRange(lines[k], 0, lines[k].length, out);
        out.push('\n');
      }
      out.push('</code></pre>', '\n');
      continue;
    }
    if (c0 === 35) {
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slug(hd.text), ids);
        const html = inlineStr(hd.text, env);
        out.push(`<h${hd.depth} id="${id}">`, html, `</h${hd.depth}>`, '\n');
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        i++;
        continue;
      }
      // Not a heading: a paragraph.
      const parts = [trimLine(line)];
      i++;
      while (i < end && !endsParagraph(lines[i])) {
        parts.push(trimLine(lines[i]));
        i++;
      }
      out.push('<p>');
      if (excerpt === null) {
        const tmp = [];
        inlineTo(parts.join('\n'), env, tmp);
        const html = tmp.join('');
        excerpt = html;
        out.push(html);
      } else {
        inlineTo(parts.join('\n'), env, out);
      }
      out.push('</p>', '\n');
      continue;
    }
    if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        out.push('<hr>', '\n');
        i++;
        continue;
      }
      const ls = listStart(line);
      if (ls !== null) {
        const isOrdered = false;
        const items = [];
        while (i < end) {
          const m = listStart(lines[i]);
          if (m !== null && !m.ordered) {
            items.push([trimLine(m.rest)]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        out.push('<ul>', '\n');
        for (let k = 0; k < items.length; k++) {
          out.push('<li>');
          inlineTo(items[k].join('\n'), env, out);
          out.push('</li>', '\n');
        }
        out.push('</ul>', '\n');
        continue;
      }
      // Not a list: a paragraph.
      const parts = [trimLine(line)];
      i++;
      while (i < end && !endsParagraph(lines[i])) {
        parts.push(trimLine(lines[i]));
        i++;
      }
      out.push('<p>');
      if (excerpt === null) {
        const tmp = [];
        inlineTo(parts.join('\n'), env, tmp);
        const html = tmp.join('');
        excerpt = html;
        out.push(html);
      } else {
        inlineTo(parts.join('\n'), env, out);
      }
      out.push('</p>', '\n');
      continue;
    }
    if (c0 === 62) {
      const q = [];
      while (i < end && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        q.push(trimLine(l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
        i++;
      }
      const kept = q.filter((l) => l !== '');
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>', '\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineTo(kept.join('\n'), env, out);
        out.push('</p>\n</blockquote>', '\n');
      }
      continue;
    }
    if (c0 >= 48 && c0 <= 57) {
      const ls = listStart(line);
      if (ls !== null) {
        const startNum = ls.start;
        const items = [];
        while (i < end) {
          const m = listStart(lines[i]);
          if (m !== null && m.ordered) {
            items.push([trimLine(m.rest)]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        if (startNum !== 1) out.push(`<ol start="${startNum}">`, '\n');
        else out.push('<ol>', '\n');
        for (let k = 0; k < items.length; k++) {
          out.push('<li>');
          inlineTo(items[k].join('\n'), env, out);
          out.push('</li>', '\n');
        }
        out.push('</ol>', '\n');
        continue;
      }
      // Not a list: a paragraph.
      const parts = [trimLine(line)];
      i++;
      while (i < end && !endsParagraph(lines[i])) {
        parts.push(trimLine(lines[i]));
        i++;
      }
      out.push('<p>');
      if (excerpt === null) {
        const tmp = [];
        inlineTo(parts.join('\n'), env, tmp);
        const html = tmp.join('');
        excerpt = html;
        out.push(html);
      } else {
        inlineTo(parts.join('\n'), env, out);
      }
      out.push('</p>', '\n');
      continue;
    }
    // Paragraph: any other first character.
    {
      const parts = [trimLine(line)];
      i++;
      while (i < end && !endsParagraph(lines[i])) {
        parts.push(trimLine(lines[i]));
        i++;
      }
      out.push('<p>');
      if (excerpt === null) {
        const tmp = [];
        inlineTo(parts.join('\n'), env, tmp);
        const html = tmp.join('');
        excerpt = html;
        out.push(html);
      } else {
        inlineTo(parts.join('\n'), env, out);
      }
      out.push('</p>', '\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

/* ------------------------------------------------------------------ templates */

const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` into `out` (chunks). `ctx` holds the parsed templates and the include depth. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const t = textOf(lookup(scope, n.path));
        if (t !== '') out.push(t.replace(ESC_RE, escReplacer));
        break;
      }
      case 'raw': {
        const t = textOf(lookup(scope, n.path));
        if (t !== '') out.push(t);
        break;
      }
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        // One vars/loop pair reused across iterations: rendering is synchronous
        // and no scope is retained past its iteration, so mutating is safe.
        const vars = { [n.name]: null, loop: { index: 0, first: false, last: false, length: len } };
        const inner = { vars, parent: scope };
        for (let k = 0; k < len; k++) {
          vars[n.name] = xs[k];
          vars.loop.index = k + 1;
          vars.loop.first = k === 0;
          vars.loop.last = k === len - 1;
          renderNodes(n.body, inner, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

/* ------------------------------------------------------------------ pipeline */

const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** The words of a body: its runs of characters other than whitespace. Lines are counted one by one ('\n' breaks runs). */
function wordsOfLines(lines, start, end) {
  let n = 0;
  for (let li = start; li < end; li++) {
    const line = lines[li];
    let inWord = false;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11) inWord = false;
      else if (c > 127) {
        if (isWSCode(c)) {
          // A Unicode space: fall back to the reference's regex on the joined body.
          const m = lines.slice(start, end).join('\n').match(/\S+/g);
          return m === null ? 0 : m.length;
        }
        if (!inWord) {
          inWord = true;
          n++;
        }
      } else if (!inWord) {
        inWord = true;
        n++;
      }
    }
  }
  return n;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const slug = (s) => {
    let r = slugCache.get(s);
    if (r === undefined) {
      r = slugifyRaw(s);
      slugCache.set(s, r);
    }
    return r;
  };

  // 2. Templates, parsed in code-unit order of their names.
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let ni = 0; ni < names.length; ni++) {
    const name = names[ni];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, sorted by path; .md is a source, anything else static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in order: refused -> reserved dir -> post needs date -> layout -> draft.
  const kept = [];
  for (let si = 0; si < sources.length; si++) {
    const s = sources[si];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.lines = fm.lines;
    s.bodyStart = fm.start;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const sl = uniqueSlug(s.data.slug ?? slug(s.data.title), set);
    s.slug = sl;
    s.outDir = dir === '' ? sl : `${dir}/${sl}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderBody(s.lines, s.bodyStart, s.lines.length, env, slug);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, ties by slug; newer/older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let k = 0; k < tags.length; k++) {
      const name = tags[k];
      const sl = slug(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (let pi = 0; pi < posts.length; pi++) {
    const p = posts[pi];
    p.tagRefs = [];
    const names2 = ownTags(p);
    for (let k = 0; k < names2.length; k++) {
      const name = names2[k];
      const sl = slug(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    if (s.post) continue;
    const names2 = ownTags(s);
    s.tagRefs = names2.map((name) => bySlug.get(slug(name)) ?? { name, slug: slug(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cardOf = (s) => {
    if (s._rm === undefined) s._rm = Math.max(1, Math.ceil(wordsOfLines(s.lines, s.bodyStart, s.lines.length) / 200));
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: s._rm,
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  };
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  // pageOf reuses a post's card (built once above) instead of rebuilding it.
  const pageOf = (s) => ({
    ...(cards.get(s) ?? cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const output = {};
  // Root scopes are built once per run() and only their page/posts/pager/tag
  // slots are rewritten per render (same keys, so the shape stays stable) —
  // no per-render object spread.
  const rootPage = { site, tags: allTags, recent, page: null };
  const rootIndex = { site, tags: allTags, recent, posts: null, pager: null };
  const rootTag = { site, tags: allTags, recent, tag: null };
  const rootTags = { site, tags: allTags, recent };
  const scopePage = { vars: rootPage, parent: null };
  const scopeIndex = { vars: rootIndex, parent: null };
  const scopeTag = { vars: rootTag, parent: null };
  const scopeTags = { vars: rootTags, parent: null };
  const renderPage = (name, s) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    rootPage.page = pageOf(s);
    const out = [];
    renderNodes(nodes, scopePage, ctx, 0, out);
    return out.join('');
  };
  const renderOther = (name, scope) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, scope, ctx, 0, out);
    return out.join('');
  };
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    output[`${s.outDir}/index.html`] = renderPage(s.layout, s);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    rootIndex.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
    rootIndex.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    const html = renderOther('index', scopeIndex);
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let ti = 0; ti < tags.length; ti++) {
    const t = tags[ti];
    rootTag.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
    const html = renderOther('tag', scopeTag);
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = renderOther('tags', scopeTags);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let fi = 0; fi < statics.length; fi++) {
    const f = statics[fi];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
