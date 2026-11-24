/*
 * GhostLabs AI - Document Extraction Engine
 * Dependency-free, deterministic, client-side parser for invoice and
 * receipt text. No model, no network, no simulation. It only reports
 * what it can find with the heuristics below and returns null for
 * anything missing. It never invents values.
 *
 * Limitations:
 * - Heuristic only. Unusual layouts, scanned images, PDFs, and tables
 *   without a trailing amount per row will miss line items.
 * - Vendor is a best-effort guess from the first header lines.
 * - Ambiguous dates such as 01/02/2026 are read as day/month/year.
 * - Ambiguous numbers such as 1,234 may be thousands or decimal in
 *   some locales. The parser uses the rules in parseNumber and the
 *   result can be wrong for documents that mix conventions.
 * - Currency for the dollar sign is reported as USD. Other dollar
 *   currencies cannot be distinguished from the symbol alone.
 * - Tax is read from a single tax, VAT, or GST line. Multi-tax
 *   documents are not fully modelled.
 * - Line items need a trailing amount. Quantity and unit price are
 *   null when the line does not state them clearly.
 */

// ------------------------------------------------------------------
// Number parsing
// ------------------------------------------------------------------

function parseNumber(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let negative = false;
  // Parentheses mean negative in accounting notation: (1,234.56)
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  if (/^-/.test(s)) { negative = true; s = s.replace(/^-/, '').trim(); }
  if (/^-$/.test(s)) return null;
  // Strip currency symbols and codes and spaces used as grouping.
  s = s.replace(/PHP|USD|EUR|GBP|JPY|AUD|CAD/gi, '');
  s = s.replace(/[$\u20AC\u00A3\u00A5]/g, '');
  s = s.replace(/\s+/g, '');
  s = s.replace(/%$/, '');
  if (!s || !/\d/.test(s)) return null;
  if (!/^-?[\d.,]+$/.test(s)) return null;

  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  let normalized = s;
  if (hasDot && hasComma) {
    // Last separator is the decimal separator.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      normalized = s.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = s.replace(/,/g, '');
    }
  } else if (hasComma && !hasDot) {
    const parts = s.split(',');
    const last = parts[parts.length - 1];
    if (parts.length === 2 && last.length === 3 && parts[0].length <= 3) {
      // Single comma with exactly three trailing digits: thousands.
      normalized = s.replace(/,/g, '');
    } else if (last.length === 1 || last.length === 2) {
      normalized = s.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = s.replace(/,/g, '');
    }
  }
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// Find the last amount-like token in a string. Returns {value, raw} or null.
function lastAmount(str) {
  if (!str) return null;
  // Amount token: optional parens, optional currency, digits with
  // grouping or decimal separators. Rate tokens ending in % are skipped
  // by the caller when needed.
  const re = /\(?[\$\u20AC\u00A3]?\s*-?\d[\d\s.,]*\d\)?|\(?[\$\u20AC\u00A3]?\s*-?\d\)?/g;
  let m, last = null;
  while ((m = re.exec(str)) !== null) {
    const token = m[0].trim();
    // Skip pure year-like tokens when a longer amount exists is hard;
    // keep all candidates and let caller decide by position.
    const v = parseNumber(token);
    if (v !== null) last = { value: v, raw: token, index: m.index };
  }
  return last;
}

function allAmounts(str) {
  const re = /\(?[\$\u20AC\u00A3]?\s*-?\d[\d.,]*\d\)?|\(?[\$\u20AC\u00A3]?\s*-?\d\)?/g;
  const out = [];
  let m;
  while ((m = re.exec(str)) !== null) {
    const v = parseNumber(m[0]);
    if (v !== null) out.push({ value: v, raw: m[0].trim(), index: m.index });
  }
  return out;
}

// ------------------------------------------------------------------
// Date parsing: returns YYYY-MM-DD or null
// ------------------------------------------------------------------
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12
};
function pad(n) { return String(n).padStart(2, '0'); }
function validDate(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}
function parseDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  let m;
  // 2026-11-23 or 2026/11/23
  m = s.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  // 23/11/2026 or 11/23/2026 : disambiguate, else day first
  m = s.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    if (a > 12 && b <= 12) return validDate(y, b, a);
    if (b > 12 && a <= 12) return validDate(y, a, b);
    return validDate(y, b, a); // day/month/year default
  }
  // Nov 23, 2026 or November 23 2026
  m = s.match(/([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) return validDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  // 23 Nov 2026
  m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()]) return validDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}
function findDateInLine(line) {
  // Try the whole line; parseDate searches inside the string.
  return parseDate(line);
}

// ------------------------------------------------------------------
// Currency
// ------------------------------------------------------------------
function detectCurrency(text) {
  const upper = text.toUpperCase();
  if (/\bPHP\b/.test(upper) || text.includes('\u20B1')) return 'PHP';
  if (/\bEUR\b/.test(upper) || text.includes('\u20AC')) return 'EUR';
  if (/\bGBP\b/.test(upper) || text.includes('\u00A3')) return 'GBP';
  if (/\bJPY\b/.test(upper) || text.includes('\u00A5')) return 'JPY';
  if (/\bUSD\b/.test(upper) || text.includes('$')) return 'USD';
  return null;
}

// ------------------------------------------------------------------
// Label helpers
// ------------------------------------------------------------------
const RE_SUBTOTAL = /\bsub\s*-?\s*total\b/i;
const RE_TAX = /\b(vat|gst|sales\s+tax|tax)\b/i;
const RE_SHIPPING = /\b(shipping|delivery|freight|postage)\b/i;
const RE_TIP = /\b(tip|gratuity)\b/i; // [PATCH P1]
const RE_TOTAL = /\b(grand\s+total|total\s+due|total)\b/i;
const RE_AMOUNT_DUE = /\b(amount\s+due|balance\s+due|balance)\b/i;

function isFooterLabel(line) {
  return RE_SUBTOTAL.test(line) || RE_TAX.test(line) || RE_SHIPPING.test(line) || RE_TIP.test(line) || // [PATCH P1]
    RE_AMOUNT_DUE.test(line) || /\bgrand\s+total\b/i.test(line) ||
    /^\s*total\b/i.test(line) || /\btotal\s*:/i.test(line) || /\btotal\s+due\b/i.test(line);
}
function isHeaderOrMetaLine(line) {
  return /\b(invoice|receipt|date|due|bill\s+to|ship\s+to|customer|payment|terms|thank|page|tel|phone|email|address|street|road|ave|city)\b/i.test(line) ||
    /^\s*(invoice|receipt)\s*$/i.test(line) || line.includes('@');
}

// ------------------------------------------------------------------
// Line item parsing
// ------------------------------------------------------------------
const AMT = String.raw`\(?\$?[\u20AC\u00A3]?\s*-?\d[\d.,]*\d\)?|\(?\$?[\u20AC\u00A3]?\s*-?\d\)?`;

function parseLineItem(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Pattern A: description, qty x unitPrice, amount
  // Example: Widget Pro 2 x 49.00 98.00
  let m = trimmed.match(new RegExp(`^(.+?)\\s+(\\d+(?:[.,]\\d+)?)\\s*[x\\u00D7]\\s*(${AMT})\\s+(${AMT})\\s*$`, 'i'));
  if (m) {
    const qty = parseNumber(m[2]);
    const unitPrice = parseNumber(m[3]);
    const amount = parseNumber(m[4]);
    const description = m[1].trim().replace(/[\t ]{2,}.*$/, '').trim() || m[1].trim();
    if (qty !== null && unitPrice !== null && amount !== null && description) {
      return { description, qty, unitPrice, amount };
    }
  }

  // Split by tab or 2+ spaces into columns.
  const cols = trimmed.split(/\t+|\s{2,}/).map(c => c.trim()).filter(Boolean);
  if (cols.length >= 3) {
    const last = parseNumber(cols[cols.length - 1]);
    const secondLast = parseNumber(cols[cols.length - 2]);
    const thirdLast = parseNumber(cols[cols.length - 3]);
    if (last !== null && secondLast !== null && thirdLast !== null && cols.length >= 4) {
      const description = cols.slice(0, cols.length - 3).join(' ');
      return { description, qty: thirdLast, unitPrice: secondLast, amount: last };
    }
    if (last !== null && secondLast !== null) {
      // desc, qty, amount  OR  desc, unitPrice, amount
      // If secondLast is a small integer and first column count allows,
      // treat as qty when there is a separate unit pattern? Heuristic:
      // if cols length is 3, ambiguous. Prefer qty if integer and
      // last / secondLast yields a plausible unit price only when
      // the middle value looks like qty (integer, <= 1000).
      const description = cols.slice(0, cols.length - 2).join(' ');
      if (Number.isInteger(secondLast)) {
        const unit = secondLast !== 0 ? round2(last / secondLast) : null;
        // If description columns already handled above, this is qty case
        // only when original line had qty pattern in columns.
        // Use qty interpretation for 3-col tab separated rows.
        return { description, qty: secondLast, unitPrice: unit, amount: last };
      }
      return { description, qty: null, unitPrice: secondLast, amount: last };
    }
    if (last !== null && cols.length >= 2) {
      const description = cols.slice(0, cols.length - 1).join(' ');
      if (description) return { description, qty: null, unitPrice: null, amount: last };
    }
  }

  // [PATCH P5] Comma separated line layout fallback:
  // "description, qty, unit price, amount". The qty segment may carry a
  // unit word ("2.5 hrs", "0.75 kg", "12.5 ft"). A 3-segment variant
  // carries the qty at the head of the description segment
  // ("2 Wood-Fired Margherita, 18.50, 37.00").
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',').map(c => c.trim());
    if (parts.length >= 3) {
      const amtC = parseNumber(parts[parts.length - 1]);
      const unitC = parseNumber(parts[parts.length - 2]);
      if (parts.length >= 4 && amtC !== null && unitC !== null) {
        const qm = parts[parts.length - 3].match(/^(\d+(?:[.,]\d+)?)\s*(?:[A-Za-z]{1,4}\.?)?$/);
        const descC = parts.slice(0, parts.length - 3).join(', ').trim();
        if (qm && descC && /[A-Za-z]/.test(descC)) {
          return { description: descC, qty: parseNumber(qm[1]), unitPrice: unitC, amount: amtC };
        }
      }
      if (parts.length === 3 && amtC !== null && unitC !== null) {
        const fm = parts[0].match(/^(\d+(?:[.,]\d+)?)\s+(.+)$/);
        if (fm) return { description: fm[2].trim(), qty: parseNumber(fm[1]), unitPrice: unitC, amount: amtC };
      }
    }
  }

  // [PATCH P5] Prefix line layout fallback:
  // "4 x Description @ $15.00, $60.00" and "2x Description @ GBP 120.00 = GBP 240.00".
  // A trailing bracket note (for example a tax class tag) is not part of
  // the description.
  m = trimmed.match(/^(\d+(?:[.,]\d+)?)\s*[x\u00D7]\s+(.+?)\s*@\s*((?:GBP|USD|EUR|PHP|[$\u20AC\u00A3])?\s*\(?-?\d[\d.,]*\d\)?|(?:GBP|USD|EUR|PHP|[$\u20AC\u00A3])?\s*\(?-?\d\)?)\s*(?:=|,)\s*((?:GBP|USD|EUR|PHP|[$\u20AC\u00A3])?\s*\(?-?\d[\d.,]*\d\)?|(?:GBP|USD|EUR|PHP|[$\u20AC\u00A3])?\s*\(?-?\d\)?)/i);
  if (m) {
    const qty = parseNumber(m[1]);
    const unitPrice = parseNumber(m[3]);
    const amount = parseNumber(m[4]);
    const description = m[2].trim().replace(/\s*\[[^\]]*\]\s*$/, '').trim();
    if (qty !== null && unitPrice !== null && amount !== null && description) {
      return { description, qty, unitPrice, amount };
    }
  }

  // Pattern B: description, qty, unitPrice, amount (single spaces)
  // Example: Widget Pro 3 25.50 76.50
  m = trimmed.match(new RegExp(`^(.+?)\\s+(\\d+)\\s+(${AMT})\\s+(${AMT})\\s*$`));
  if (m) {
    const qty = parseNumber(m[2]);
    const unitPrice = parseNumber(m[3]);
    const amount = parseNumber(m[4]);
    const description = m[1].trim();
    if (qty !== null && unitPrice !== null && amount !== null && description && !/\d$/.test(description)) {
      return { description, qty, unitPrice, amount };
    }
    if (qty !== null && unitPrice !== null && amount !== null && description) {
      return { description, qty, unitPrice, amount };
    }
  }

  // Pattern C: description and a single trailing amount.
  // Example: Coffee 45.50  or  Coffee - 45.50
  m = trimmed.match(new RegExp(`^(.+?)\\s+[-:]?\\s*(${AMT})\\s*$`));
  if (m) {
    const amount = parseNumber(m[2]);
    const description = m[1].trim().replace(/[-:]$/, '').trim();
    if (amount !== null && description && /[A-Za-z]/.test(description)) {
      // Reject if description is just a label or a date fragment.
      if (isFooterLabel(description) || isHeaderOrMetaLine(description)) return null;
      return { description, qty: null, unitPrice: null, amount };
    }
  }
  return null;
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function approxEqual(a, b, tol) { return Math.abs(a - b) <= tol; }

// ------------------------------------------------------------------
// [PATCH P4] Input normalizer, cherry-picked from the Genspark package
// (extractor.js normalize()). Runs before extraction so messy phone
// copy-paste survives: NBSP and exotic spaces, Unicode minus and dash
// variants, zero-width characters, currency glued to words, and
// split-line joining (a description-only line followed by a qty or
// price line is joined back into one line).
// ------------------------------------------------------------------
function normalizeInput(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u2212\u2012\u2013\u2014\uFE63\uFF0D]/g, '-')
    .replace(/([A-Za-z:])([$\u20AC\u00A3])/g, '$1 $2')
    .replace(/([$\u20AC\u00A3])\s+(?=\d)/g, '$1')
    .replace(/(\d)(USD|EUR|GBP)\b/gi, '$1 $2')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n');
  const linesIn = s.split('\n'); const out = [];
  for (let i = 0; i < linesIn.length; i++) {
    const cur = linesIn[i].trim();
    const next = i + 1 < linesIn.length ? linesIn[i + 1].trim() : '';
    if (cur && /[A-Za-z]/.test(cur) && !/\d/.test(cur) &&
        /^(?:\d+(?:[.,]\d+)?\s*[x\u00D7@]\s*)?[$\u20AC\u00A3]?\d[\d.,]*(?:\s+[$\u20AC\u00A3]?\d[\d.,]*)?$/i.test(next)) {
      out.push(cur + ' ' + next); i++; continue;
    }
    if (cur) out.push(cur);
  }
  return out.join('\n');
}

// ------------------------------------------------------------------
// Provenance helpers (GT117). Spans are character offsets into the
// normalized input string produced by normalizeInput, the exact string
// extractDocument parses. A span is recorded only when slicing that
// string at [start, end) returns the raw text stored on the span, so a
// span that cannot be made exact is left null instead of being wrong.
// ------------------------------------------------------------------
function makeSpan(sourceText, lineStart, lineNo, startInLine, raw, ruleId, anchor) {
  if (startInLine === null || startInLine === undefined || raw === null || raw === undefined || raw === '') return null;
  const start = lineStart + startInLine;
  const end = start + String(raw).length;
  if (sourceText.slice(start, end) !== String(raw)) return null;
  return { start, end, line: lineNo, raw: String(raw), ruleId, anchor: anchor || null };
}
function anchorSpan(sourceText, lineStart, line, re) {
  const m = line.match(re);
  if (!m) return null;
  const start = lineStart + m.index, end = start + m[0].length;
  return sourceText.slice(start, end) === m[0] ? { start, end } : null;
}
// stripRate with a position map: map[i] is the index in the original
// line of stripped character i. Lets amount positions found on the
// rate-stripped line be translated back to original line coordinates.
function stripRateWithMap(line) {
  const re = /\d+(?:[.,]\d+)?\s*%/g;
  let stripped = '', last = 0, m;
  const map = [];
  while ((m = re.exec(line)) !== null) {
    for (let i = last; i < m.index; i++) { stripped += line[i]; map.push(i); }
    last = m.index + m[0].length;
  }
  for (let i = last; i < line.length; i++) { stripped += line[i]; map.push(i); }
  map.push(line.length);
  return { stripped, map };
}
// Same selection as lastAmount(stripRate(line)), but the returned index
// is in original line coordinates. Returns { value, raw, index }.
function lastAmountMapped(line) {
  const { stripped, map } = stripRateWithMap(line);
  if (stripped !== stripRate(line)) return lastAmount(stripped);
  const re = /\(?[\$\u20AC\u00A3]?\s*-?\d[\d\s.,]*\d\)?|\(?[\$\u20AC\u00A3]?\s*-?\d\)?/g;
  let m, last = null;
  while ((m = re.exec(stripped)) !== null) {
    const token = m[0].trim();
    const v = parseNumber(token);
    if (v !== null) {
      const lead = m[0].length - m[0].trimStart().length;
      last = { value: v, raw: token, index: map[m.index + lead] };
    }
  }
  return last;
}
// Same values as allAmounts(stripRate(line)), indices in original line
// coordinates.
function allAmountsMapped(line) {
  const { stripped, map } = stripRateWithMap(line);
  if (stripped !== stripRate(line)) return allAmounts(stripped);
  const re = /\(?[\$\u20AC\u00A3]?\s*-?\d[\d.,]*\d\)?|\(?[\$\u20AC\u00A3]?\s*-?\d\)?/g;
  const out = [];
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const v = parseNumber(m[0]);
    if (v !== null) {
      const lead = m[0].length - m[0].trimStart().length;
      out.push({ value: v, raw: m[0].trim(), index: map[m.index + lead] });
    }
  }
  return out;
}
// The raw date token parseDate would read from a line, with its index,
// following the same pattern order and stopping rules as parseDate.
function findDateSpanInLine(line) {
  let m = line.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return parseDate(m[0]) ? { raw: m[0], index: m.index } : null;
  m = line.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (m) return parseDate(m[0]) ? { raw: m[0], index: m.index } : null;
  m = line.match(/([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) return { raw: m[0], index: m.index };
  m = line.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()]) return { raw: m[0], index: m.index };
  return null;
}
// Provenance for one parsed line item, located by token search on its
// source line. A subfield whose token cannot be located exactly stays
// null: the amount is the last amount token with the item value, the
// unit price is the last amount token before it with the unit value,
// the quantity is the last plain number token before the unit price
// (or amount) with the qty value, and the description must appear
// verbatim in the line. A unit price the parser computed (amount
// divided by qty) has no source token and stays null.
function lineItemProvenance(sourceText, lineStart, lineNo, line, item) {
  const out = { description: null, qty: null, unitPrice: null, amount: null };
  if (!item) return out;
  // Amount tokens on the line, with indices at the trimmed token start
  // (the amount regex can begin a match on the space before a token,
  // which is the offset allAmounts reports; that offset is not exact).
  const amounts = [];
  {
    const re = /-?\(?[\$\u20AC\u00A3]?\s*-?\d[\d.,]*\d\)?|-?\(?[\$\u20AC\u00A3]?\s*-?\d\)?/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const v = parseNumber(m[0]);
      if (v !== null) {
        const lead = m[0].length - m[0].trimStart().length;
        amounts.push({ value: v, raw: m[0].trim(), index: m.index + lead });
      }
    }
  }
  let amtTok = null;
  for (const t of amounts) if (t.value === item.amount) amtTok = t;
  if (amtTok) out.amount = makeSpan(sourceText, lineStart, lineNo, amtTok.index, amtTok.raw, 'LINE_ITEM_AMOUNT', null);
  let unitTok = null;
  if (item.unitPrice !== null && amtTok) {
    for (const t of amounts) if (t.index < amtTok.index && t.value === item.unitPrice) unitTok = t;
    if (unitTok) out.unitPrice = makeSpan(sourceText, lineStart, lineNo, unitTok.index, unitTok.raw, 'LINE_ITEM_UNIT_PRICE', null);
  }
  if (item.qty !== null) {
    const limit = unitTok ? unitTok.index : (amtTok ? amtTok.index : line.length);
    const numRe = /\d+(?:[.,]\d+)?/g;
    let nm, qTok = null;
    while ((nm = numRe.exec(line)) !== null) {
      if (nm.index < limit && parseNumber(nm[0]) === item.qty) qTok = { index: nm.index, raw: nm[0] };
    }
    if (qTok) out.qty = makeSpan(sourceText, lineStart, lineNo, qTok.index, qTok.raw, 'LINE_ITEM_QTY', null);
  }
  if (item.description) {
    const di = line.indexOf(item.description);
    if (di >= 0) out.description = makeSpan(sourceText, lineStart, lineNo, di, item.description, 'LINE_ITEM_DESCRIPTION', null);
  }
  return out;
}

// ------------------------------------------------------------------
// Main entry
// ------------------------------------------------------------------
export function extractDocument(text) {
  const warnings = [];
  const input = normalizeInput(typeof text === 'string' ? text : ''); // [PATCH P4]
  const rawLines = input.split(/\r?\n/);
  const lines = rawLines.map(l => l.trim()).filter(l => l.length > 0);
  // Provenance bookkeeping (GT117). lineInfos[i] locates lines[i] in the
  // normalized input: the offset of its first character and its 1-based
  // line number in that string. Every span below is verified against
  // the input by makeSpan before it is recorded.
  const lineInfos = [];
  {
    let off = 0;
    const parts = input.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].trim().length > 0) {
        lineInfos.push({ start: off + (parts[i].length - parts[i].trimStart().length), line: i + 1 });
      }
      off += parts[i].length + 1;
    }
  }
  const provFields = {
    vendor: null, invoiceNumber: null, invoiceDate: null, dueDate: null,
    currency: null, subtotal: null, taxLabel: null, taxRate: null,
    taxAmount: null, shipping: null, tip: null, total: null, amountDue: null
  };
  const provLineItems = [];
  const provTaxes = [];
  const ambiguous = {};
  const cand = { total: [], subtotal: [], amountDue: [], taxAmount: [], invoiceNumber: [] };
  function noteCandidate(key, span, value) { if (span) cand[key].push({ span, value }); }
  function settleAmbiguous() {
    for (const key of Object.keys(cand)) {
      const fspan = provFields[key];
      if (!fspan) continue;
      const byRule = {};
      for (const c of cand[key]) {
        if (!byRule[c.span.ruleId]) byRule[c.span.ruleId] = [];
        byRule[c.span.ruleId].push(c);
      }
      for (const rule of Object.keys(byRule)) {
        const group = byRule[rule];
        if (group.length < 2) continue;
        if (new Set(group.map(c => c.value)).size < 2) continue;
        let picked = -1;
        group.forEach((c, i) => { if (c.span.start === fspan.start && c.span.end === fspan.end) picked = i; });
        if (picked < 0) continue;
        ambiguous[key] = { candidates: group.map(c => c.span), picked };
      }
    }
  }
  const fields = {
    vendor: null, invoiceNumber: null, invoiceDate: null, dueDate: null,
    currency: null, lineItems: [], subtotal: null, taxLabel: null,
    taxRate: null, taxAmount: null, shipping: null, tip: null, taxes: [], total: null, amountDue: null // [PATCH P1] tip field; [PATCH P6] taxes array
  };
  fields.currency = detectCurrency(input);

  // Vendor: first plausible header line in first 5 lines.
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const l = lines[i];
    if (/^\s*(invoice|receipt|tax invoice|sales invoice)\s*$/i.test(l)) continue;
    if (findDateInLine(l) && l.length < 30) continue;
    if (/\b(invoice\s*(no|number|#)|date|due)\b/i.test(l)) continue;
    if (l.includes('@') || /^https?:\/\//i.test(l)) continue;
    if (/[A-Za-z]/.test(l)) {
      fields.vendor = l.replace(/\s{2,}.*$/, '').trim() || l;
      const info = lineInfos[i];
      provFields.vendor = info ? makeSpan(input, info.start, info.line, 0, fields.vendor, 'VENDOR_FIRST_HEADER_LINE', null) : null;
      break;
    }
  }

  // Invoice number. The first match wins, exactly as before; later
  // matches are still collected as AMBIGUOUS candidates (GT117, D-C).
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const info = lineInfos[li];
    let m = line.match(/(?:invoice\s*(?:no\.?|number|#)|inv\.?\s*(?:no\.?|#)|invoice)\s*[:#]\s*([A-Za-z0-9][A-Za-z0-9\-\/]*)/i);
    let ruleId = 'INVOICE_NUMBER_ANCHOR';
    let matched = !!(m && !parseDate(line));
    if (!matched) {
      m = line.match(/#\s*([A-Za-z0-9][A-Za-z0-9\-\/]{2,})/);
      ruleId = 'INVOICE_NUMBER_HASH';
      matched = !!(m && /\binvoice\b/i.test(line));
    }
    if (!matched) {
      // [PATCH P6] Receipt numbers count as document numbers on receipts.
      m = line.match(/(?:receipt\s*(?:no\.?|number|#))\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9\-\/]*)/i);
      ruleId = 'RECEIPT_NUMBER_ANCHOR';
      matched = !!m;
    }
    if (!matched || !m) continue;
    const valStart = m.index + m[0].length - m[1].length;
    const anchor = info ? { start: info.start + m.index, end: info.start + valStart } : null;
    const span = info ? makeSpan(input, info.start, info.line, valStart, m[1], ruleId, anchor) : null;
    noteCandidate('invoiceNumber', span, m[1]);
    if (fields.invoiceNumber === null) { fields.invoiceNumber = m[1]; provFields.invoiceNumber = span; }
  }

  // Dates
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const d = findDateInLine(line);
    if (!d) continue;
    const isDue = /\b(due|payment due|pay by)\b/i.test(line);
    const isInvoiceDate = /\b(invoice date|issued|issue date|date)\b/i.test(line);
    let target = null, ruleId = null;
    if (isDue && !fields.dueDate) { target = 'dueDate'; ruleId = 'DATE_DUE_ANCHOR'; }
    else if (isInvoiceDate && !fields.invoiceDate) { target = 'invoiceDate'; ruleId = 'DATE_INVOICE_ANCHOR'; }
    else if (!fields.invoiceDate && !isDue) { target = 'invoiceDate'; ruleId = 'DATE_FIRST_UNLABELED'; }
    if (!target) continue;
    fields[target] = d;
    const info = lineInfos[li];
    const ds = findDateSpanInLine(line);
    let anchor = null;
    if (info) {
      const am = line.match(/\b(invoice date|issue date|issued|payment due|pay by|due|date)\b/i);
      if (am) anchor = { start: info.start + am.index, end: info.start + am.index + am[0].length };
    }
    provFields[target] = (info && ds) ? makeSpan(input, info.start, info.line, ds.index, ds.raw, ruleId, anchor) : null;
  }

  // Footer fields and line items, line by line.
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const info = lineInfos[li];
    // [PATCH P2] Tax-line guards: identifier and registration lines are
    // never the tax line (a Tax ID or VAT Reg number is not a tax amount).
    if (/\b(tax\s*(id|no\.?|number|reg)|vat\s*reg|tax\s*number|registration|tax[-\s]?exempt)\b/i.test(line)) continue;
    // Subtotal takes priority over total.
    if (RE_SUBTOTAL.test(line)) {
      const a = lastAmountMapped(line);
      if (a) {
        fields.subtotal = a.value;
        const span = info ? makeSpan(input, info.start, info.line, a.index, a.raw, 'SUBTOTAL_ANCHOR', anchorSpan(input, info.start, line, RE_SUBTOTAL)) : null;
        provFields.subtotal = span;
        noteCandidate('subtotal', span, a.value);
      }
      continue;
    }
    if (RE_AMOUNT_DUE.test(line)) {
      const a = lastAmountMapped(line);
      if (a) {
        fields.amountDue = a.value;
        const anchor = info ? anchorSpan(input, info.start, line, RE_AMOUNT_DUE) : null;
        const span = info ? makeSpan(input, info.start, info.line, a.index, a.raw, 'AMOUNT_DUE_ANCHOR', anchor) : null;
        provFields.amountDue = span;
        noteCandidate('amountDue', span, a.value);
        // [PATCH P3] "Net Balance Due", "Total Due", "TOTAL PAYABLE" and
        // "Amount Due" also populate total when no total was found yet.
        if (fields.total === null && /\b(net\s+balance\s+due|total\s+due|total\s+payable|amount\s+due)\b/i.test(line)) {
          fields.total = a.value;
          const tspan = info ? makeSpan(input, info.start, info.line, a.index, a.raw, 'TOTAL_FROM_AMOUNT_DUE', anchor) : null;
          provFields.total = tspan;
          noteCandidate('total', tspan, a.value);
        }
      }
      // Amount Due line may also be the total in some layouts; do not
      // also treat it as total unless no total was found yet and the
      // line explicitly says total. Keep amountDue separate.
      continue;
    }
    // [PATCH P1] Tip is a first-class field: tip lines are never line
    // items, and the grand total check below accounts for the tip.
    if (RE_TIP.test(line)) {
      const a = lastAmountMapped(line);
      if (a) {
        fields.tip = a.value;
        provFields.tip = info ? makeSpan(input, info.start, info.line, a.index, a.raw, 'TIP_ANCHOR', anchorSpan(input, info.start, line, RE_TIP)) : null;
      }
      continue;
    }
    if (RE_SHIPPING.test(line) && !RE_TAX.test(line)) { // [PATCH P2] a VAT or tax line must not overwrite shipping
      const a = lastAmountMapped(line);
      if (a) {
        fields.shipping = a.value;
        provFields.shipping = info ? makeSpan(input, info.start, info.line, a.index, a.raw, 'SHIPPING_ANCHOR', anchorSpan(input, info.start, line, RE_SHIPPING)) : null;
      }
      continue;
    }
    if (RE_TAX.test(line) && !RE_SUBTOTAL.test(line) && !/\[\s*tax\b/i.test(line)) { // [PATCH P2] bracket guard
      // [PATCH P6] Split tax: every tax line is recorded in fields.taxes
      // with its own rate and stated base (the amount after "on", when
      // stated), following the Genspark per-tax-line structure. A
      // "Total Tax" summary line sets the combined amount and is not
      // itself another tax line.
      const rateMatch = line.match(/(\d+(?:[.,]\d+)?)\s*%/);
      const rate = rateMatch ? parseNumber(rateMatch[1]) : null;
      const amounts = allAmountsMapped(line);
      if (!amounts.length) continue;
      const amountTok = amounts[amounts.length - 1];
      const amount = amountTok.value;
      const taxAnchor = info ? anchorSpan(input, info.start, line, RE_TAX) : null;
      if (/^\s*total\s+(tax|vat|gst)\b/i.test(line)) {
        fields.taxAmount = amount;
        const span = info ? makeSpan(input, info.start, info.line, amountTok.index, amountTok.raw, 'TAX_TOTAL_SUMMARY', taxAnchor) : null;
        provFields.taxAmount = span;
        noteCandidate('taxAmount', span, amount);
        continue;
      }
      const labelMatch = line.match(RE_TAX);
      if (labelMatch && !fields.taxLabel) {
        fields.taxLabel = labelMatch[1].replace(/\s+/g, ' ').trim();
        provFields.taxLabel = info ? makeSpan(input, info.start, info.line, labelMatch.index, fields.taxLabel, 'TAX_LABEL', null) : null;
      }
      let base = null;
      const onMatch = line.match(/\bon\b/i);
      if (onMatch) {
        const bm = line.slice(onMatch.index + onMatch[0].length).match(/-?\d[\d.,]*\d|-?\d/);
        if (bm) { const bv = parseNumber(bm[0]); if (bv !== null && bv !== amount) base = bv; }
      }
      fields.taxes.push({ label: line.trim(), rate, base, amount });
      const taxAmtSpan = info ? makeSpan(input, info.start, info.line, amountTok.index, amountTok.raw, 'TAX_LINE_AMOUNT', taxAnchor) : null;
      provTaxes.push({ amount: taxAmtSpan });
      fields.taxAmount = round2(fields.taxes.reduce((sum, t) => sum + t.amount, 0));
      fields.taxRate = fields.taxes.length === 1 ? fields.taxes[0].rate : null;
      if (fields.taxes.length === 1) {
        // A single tax line: the combined amount is that line's amount.
        provFields.taxAmount = taxAmtSpan;
        provFields.taxRate = (info && rateMatch) ? makeSpan(input, info.start, info.line, rateMatch.index, rateMatch[1], 'TAX_RATE_PERCENT', taxAnchor) : null;
      } else {
        // A sum of several tax lines has no single source span.
        provFields.taxAmount = null;
        provFields.taxRate = null;
      }
      continue;
    }
    if (RE_TOTAL.test(line)) {
      // Only treat as total if line starts with total or has colon,
      // to avoid catching prose containing the word total.
      if (/^\s*(grand\s+)?total\b/i.test(line) || /\btotal\s*:/i.test(line) || /\btotal\s+due\b/i.test(line) || /\bgrand\s+total\b/i.test(line) || /\btotal\s+(payable|paid)\b/i.test(line)) { // [PATCH P3]
        const a = lastAmountMapped(line);
        if (a) {
          fields.total = a.value;
          const span = info ? makeSpan(input, info.start, info.line, a.index, a.raw, 'TOTAL_ANCHOR', anchorSpan(input, info.start, line, /\b(grand\s+total|total\s+due|total\s+payable|total\s+paid|total)\b/i)) : null;
          provFields.total = span;
          noteCandidate('total', span, a.value);
        }
        continue;
      }
    }
    // [PATCH P5] A prefix item line uses @ as its price marker; it is not
    // an email or header line even though isHeaderOrMetaLine matches @.
    if (/^\d+(?:[.,]\d+)?\s*[x\u00D7]\s+.+\s*@.*\d/.test(line)) {
      const item = parseLineItem(line);
      if (item) {
        fields.lineItems.push(item);
        provLineItems.push(info ? lineItemProvenance(input, info.start, info.line, line, item) : { description: null, qty: null, unitPrice: null, amount: null });
        continue;
      }
    }
    if (isHeaderOrMetaLine(line)) continue;
    if (fields.vendor && line === fields.vendor) continue;
    // Skip address-like and contact lines without a trailing amount pattern.
    const item = parseLineItem(line);
    if (item) {
      fields.lineItems.push(item);
      provLineItems.push(info ? lineItemProvenance(input, info.start, info.line, line, item) : { description: null, qty: null, unitPrice: null, amount: null });
      continue;
    }
    // Warning heuristic: line has letters and a number and at least
    // 8 chars, is not a date or header, and looked item-like.
    if (/[A-Za-z]/.test(line) && /\d/.test(line) && line.length >= 8 &&
        !findDateInLine(line) && !/^\d+\s/.test(line) === false) {
      // Only warn for lines with a currency or decimal amount fragment
      // that failed to parse as an item.
      if (/[\$\u20AC\u00A3]|\d+[.,]\d{2}\b/.test(line) && !isHeaderOrMetaLine(line)) {
        warnings.push(`Could not parse line as item: "${line}"`);
      }
    }
  }

  // If tax amount ended up equal to rate and no real amount, clear it
  // when there is no other evidence. Handled by samples: tax lines in
  // samples always carry an amount, so this guard is conservative.
  // (No-op unless tax line had only a percent: detect by scanning.)
  // Checks
  const TOL = 0.02;
  const checks = [];
  const itemsSum = fields.lineItems.reduce((s, it) => s + (it.amount || 0), 0);

  if (fields.lineItems.length && fields.subtotal !== null) {
    const ok = approxEqual(itemsSum, fields.subtotal, TOL);
    checks.push({ id: 'items-sum-subtotal', label: 'Line items sum vs subtotal', status: ok ? 'pass' : 'fail',
      detail: ok ? `Line items sum ${itemsSum.toFixed(2)} matches subtotal ${fields.subtotal.toFixed(2)}`
                 : `Line items sum ${itemsSum.toFixed(2)} does not match subtotal ${fields.subtotal.toFixed(2)} (difference ${(itemsSum - fields.subtotal).toFixed(2)})` });
  } else {
    checks.push({ id: 'items-sum-subtotal', label: 'Line items sum vs subtotal', status: 'skip',
      detail: !fields.lineItems.length ? 'Skipped: no line items found' : 'Skipped: no subtotal stated' });
  }

  if (fields.subtotal !== null && fields.total !== null) {
    const expected = fields.subtotal + (fields.taxAmount || 0) + (fields.shipping || 0) + (fields.tip || 0); // [PATCH P1]
    const parts = [`subtotal ${fields.subtotal.toFixed(2)}`];
    if (fields.taxAmount !== null) parts.push(`tax ${fields.taxAmount.toFixed(2)}`);
    if (fields.shipping !== null) parts.push(`shipping ${fields.shipping.toFixed(2)}`);
    if (fields.tip !== null) parts.push(`tip ${fields.tip.toFixed(2)}`); // [PATCH P1]
    const ok = approxEqual(expected, fields.total, TOL);
    checks.push({ id: 'subtotal-plus-charges-total', label: 'Subtotal + tax + shipping vs total', status: ok ? 'pass' : 'fail',
      detail: ok ? `${parts.join(' + ')} = ${expected.toFixed(2)} matches total ${fields.total.toFixed(2)}`
                 : `${parts.join(' + ')} = ${expected.toFixed(2)} does not match total ${fields.total.toFixed(2)} (difference ${(expected - fields.total).toFixed(2)})` });
  } else if (fields.subtotal === null && fields.total !== null && fields.lineItems.length) {
    // [PATCH P6] No subtotal stated: check the total against the implied
    // base (line items sum plus tax, shipping and tip). The subtotal
    // field itself stays null; nothing is invented.
    const expected = round2(itemsSum + (fields.taxAmount || 0) + (fields.shipping || 0) + (fields.tip || 0));
    const ok = approxEqual(expected, fields.total, TOL);
    checks.push({ id: 'subtotal-plus-charges-total', label: 'Line items + tax + shipping vs total (no subtotal stated)', status: ok ? 'pass' : 'fail',
      detail: ok ? `Line items ${itemsSum.toFixed(2)} + charges = ${expected.toFixed(2)} matches total ${fields.total.toFixed(2)} (no subtotal stated)`
                 : `Line items ${itemsSum.toFixed(2)} + charges = ${expected.toFixed(2)} does not match total ${fields.total.toFixed(2)} (difference ${(expected - fields.total).toFixed(2)})` });
  } else {
    checks.push({ id: 'subtotal-plus-charges-total', label: 'Subtotal + tax + shipping vs total', status: 'skip',
      detail: fields.subtotal === null ? 'Skipped: no subtotal stated' : 'Skipped: no total stated' });
  }

  const badLines = [];
  let anyQtyPrice = false;
  fields.lineItems.forEach((it, idx) => {
    if (it.qty !== null && it.unitPrice !== null && it.amount !== null) {
      anyQtyPrice = true;
      if (!approxEqual(it.qty * it.unitPrice, it.amount, TOL)) badLines.push(idx + 1);
    }
  });
  if (anyQtyPrice) {
    const ok = badLines.length === 0;
    checks.push({ id: 'line-qty-price-amount', label: 'Each line qty x unit price vs amount', status: ok ? 'pass' : 'fail',
      detail: ok ? 'All lines with qty and unit price match their amount' : `Lines failing qty x unit price check: ${badLines.join(', ')}` });
  } else {
    checks.push({ id: 'line-qty-price-amount', label: 'Each line qty x unit price vs amount', status: 'skip',
      detail: 'Skipped: no line items with both qty and unit price' });
  }

  if (fields.taxes.length > 1) {
    // [PATCH P6] Split tax check: each tax line is checked against its
    // own stated base (or the subtotal when no base is stated), and the
    // tax lines must sum to the stated tax amount.
    const parts = [];
    let allOk = true, anyChecked = false;
    for (const t of fields.taxes) {
      const base = t.base !== null ? t.base : fields.subtotal;
      if (t.rate === null || base === null) { parts.push(`"${t.label}": skipped, rate or base not stated`); continue; }
      anyChecked = true;
      const exp = round2(base * t.rate / 100);
      const ok = approxEqual(exp, t.amount, TOL);
      if (!ok) allOk = false;
      parts.push(`${t.rate}% of ${base.toFixed(2)} = ${exp.toFixed(2)} vs tax ${t.amount.toFixed(2)}`);
    }
    const taxSum = round2(fields.taxes.reduce((sum, t) => sum + t.amount, 0));
    if (!approxEqual(taxSum, fields.taxAmount, TOL)) allOk = false;
    parts.push(`tax lines sum ${taxSum.toFixed(2)} vs tax amount ${fields.taxAmount.toFixed(2)}`);
    checks.push({ id: 'tax-rate-amount', label: 'Tax amount vs rate x base, per tax line', status: anyChecked ? (allOk ? 'pass' : 'fail') : 'skip',
      detail: parts.join('; ') });
  } else if (fields.taxRate !== null && fields.taxAmount !== null &&
             (fields.subtotal !== null || fields.lineItems.length)) {
    // [PATCH P6] Single tax: base is the stated subtotal, or the implied
    // base (line items sum plus shipping) when no subtotal is stated.
    const implied = fields.subtotal === null;
    const base = implied ? round2(itemsSum + (fields.shipping || 0)) : fields.subtotal;
    const expectedTax = round2(base * fields.taxRate / 100);
    const ok = approxEqual(expectedTax, fields.taxAmount, TOL) || approxEqual(base * fields.taxRate / 100, fields.taxAmount, TOL);
    checks.push({ id: 'tax-rate-amount', label: 'Tax amount vs rate x subtotal', status: ok ? 'pass' : 'fail',
      detail: ok ? `Tax ${fields.taxAmount.toFixed(2)} matches ${fields.taxRate}% of ${implied ? 'implied base (line items plus shipping)' : 'subtotal'} ${base.toFixed(2)}`
                 : `Tax ${fields.taxAmount.toFixed(2)} does not match ${fields.taxRate}% of ${implied ? 'implied base (line items plus shipping)' : 'subtotal'} ${base.toFixed(2)} (expected ${expectedTax.toFixed(2)})` });
  } else {
    const missing = fields.taxRate === null ? 'no tax rate stated' : fields.taxAmount === null ? 'no tax amount stated' : 'no subtotal stated';
    checks.push({ id: 'tax-rate-amount', label: 'Tax amount vs rate x subtotal', status: 'skip', detail: `Skipped: ${missing}` });
  }

  const fieldsFound = [
    fields.vendor, fields.invoiceNumber, fields.invoiceDate, fields.dueDate,
    fields.currency, fields.subtotal, fields.taxAmount, fields.shipping, fields.tip, // [PATCH P1]
    fields.total, fields.amountDue
  ].filter(v => v !== null && v !== undefined).length + (fields.lineItems.length ? 1 : 0);

  // Check provenance (GT117): operand spans are the field spans the
  // check arithmetic reads; the target is the stated field span the
  // computed value is compared against. The line qty check compares
  // per line, so its operands carry qty, unit price and amount spans
  // and its target is null.
  settleAmbiguous();
  const spanRef = (field, span) => span ? { field, start: span.start, end: span.end } : null;
  const itemAmountRefs = [];
  provLineItems.forEach((p, i) => { if (p && p.amount) itemAmountRefs.push({ field: `lineItems[${i}].amount`, start: p.amount.start, end: p.amount.end }); });
  const provChecks = {};
  provChecks['items-sum-subtotal'] = { operands: itemAmountRefs, target: spanRef('subtotal', provFields.subtotal) };
  {
    const ops = [];
    if (provFields.subtotal) ops.push(spanRef('subtotal', provFields.subtotal));
    else ops.push(...itemAmountRefs);
    for (const k of ['taxAmount', 'shipping', 'tip']) if (provFields[k]) ops.push(spanRef(k, provFields[k]));
    provChecks['subtotal-plus-charges-total'] = { operands: ops, target: spanRef('total', provFields.total) };
  }
  {
    const ops = [];
    fields.lineItems.forEach((it, i) => {
      const p = provLineItems[i];
      if (!p || it.qty === null || it.unitPrice === null || it.amount === null) return;
      if (p.qty) ops.push({ field: `lineItems[${i}].qty`, start: p.qty.start, end: p.qty.end });
      if (p.unitPrice) ops.push({ field: `lineItems[${i}].unitPrice`, start: p.unitPrice.start, end: p.unitPrice.end });
      if (p.amount) ops.push({ field: `lineItems[${i}].amount`, start: p.amount.start, end: p.amount.end });
    });
    provChecks['line-qty-price-amount'] = { operands: ops, target: null };
  }
  {
    const ops = [];
    if (provFields.taxRate) ops.push(spanRef('taxRate', provFields.taxRate));
    if (fields.taxes.length > 1) {
      provTaxes.forEach((p, i) => { if (p && p.amount) ops.push({ field: `taxes[${i}].amount`, start: p.amount.start, end: p.amount.end }); });
      if (provFields.subtotal) ops.push(spanRef('subtotal', provFields.subtotal));
    } else if (provFields.subtotal) {
      ops.push(spanRef('subtotal', provFields.subtotal));
    } else {
      ops.push(...itemAmountRefs);
      if (provFields.shipping) ops.push(spanRef('shipping', provFields.shipping));
    }
    provChecks['tax-rate-amount'] = { operands: ops, target: spanRef('taxAmount', provFields.taxAmount) };
  }

  const provenance = {
    sourceText: input,
    fields: provFields,
    lineItems: provLineItems,
    taxes: provTaxes,
    checks: provChecks,
    ambiguous: ambiguous
  };

  return {
    fields,
    checks,
    meta: { linesProcessed: lines.length, fieldsFound, warnings },
    provenance
  };
}
function stripRate(line) {
  return line.replace(/\d+(?:[.,]\d+)?\s*%/g, '');
}

// Attach for plain script or module script use in the browser.
if (typeof globalThis !== 'undefined') {
  globalThis.extractDocument = extractDocument;
  globalThis.GhostLabsExtract = { extractDocument, parseNumber, parseDate };
}
export default extractDocument;
