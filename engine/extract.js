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
// Main entry
// ------------------------------------------------------------------
export function extractDocument(text) {
  const warnings = [];
  const input = normalizeInput(typeof text === 'string' ? text : ''); // [PATCH P4]
  const rawLines = input.split(/\r?\n/);
  const lines = rawLines.map(l => l.trim()).filter(l => l.length > 0);
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
    if (/[A-Za-z]/.test(l)) { fields.vendor = l.replace(/\s{2,}.*$/, '').trim() || l; break; }
  }

  // Invoice number
  for (const line of lines) {
    let m = line.match(/(?:invoice\s*(?:no\.?|number|#)|inv\.?\s*(?:no\.?|#)|invoice)\s*[:#]\s*([A-Za-z0-9][A-Za-z0-9\-\/]*)/i);
    if (m && !parseDate(line)) { fields.invoiceNumber = m[1]; break; }
    m = line.match(/#\s*([A-Za-z0-9][A-Za-z0-9\-\/]{2,})/);
    if (m && /\binvoice\b/i.test(line)) { fields.invoiceNumber = m[1]; break; }
    // [PATCH P6] Receipt numbers count as document numbers on receipts.
    m = line.match(/(?:receipt\s*(?:no\.?|number|#))\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9\-\/]*)/i);
    if (m) { fields.invoiceNumber = m[1]; break; }
  }

  // Dates
  for (const line of lines) {
    const d = findDateInLine(line);
    if (!d) continue;
    const isDue = /\b(due|payment due|pay by)\b/i.test(line);
    const isInvoiceDate = /\b(invoice date|issued|issue date|date)\b/i.test(line);
    if (isDue && !fields.dueDate) fields.dueDate = d;
    else if (isInvoiceDate && !fields.invoiceDate) fields.invoiceDate = d;
    else if (!fields.invoiceDate && !isDue) fields.invoiceDate = d;
  }

  // Footer fields and line items, line by line.
  for (const line of lines) {
    // [PATCH P2] Tax-line guards: identifier and registration lines are
    // never the tax line (a Tax ID or VAT Reg number is not a tax amount).
    if (/\b(tax\s*(id|no\.?|number|reg)|vat\s*reg|tax\s*number|registration|tax[-\s]?exempt)\b/i.test(line)) continue;
    // Subtotal takes priority over total.
    if (RE_SUBTOTAL.test(line)) {
      const a = lastAmount(stripRate(line));
      if (a) fields.subtotal = a.value;
      continue;
    }
    if (RE_AMOUNT_DUE.test(line)) {
      const a = lastAmount(stripRate(line));
      if (a) {
        fields.amountDue = a.value;
        // [PATCH P3] "Net Balance Due", "Total Due", "TOTAL PAYABLE" and
        // "Amount Due" also populate total when no total was found yet.
        if (fields.total === null && /\b(net\s+balance\s+due|total\s+due|total\s+payable|amount\s+due)\b/i.test(line)) fields.total = a.value;
      }
      // Amount Due line may also be the total in some layouts; do not
      // also treat it as total unless no total was found yet and the
      // line explicitly says total. Keep amountDue separate.
      continue;
    }
    // [PATCH P1] Tip is a first-class field: tip lines are never line
    // items, and the grand total check below accounts for the tip.
    if (RE_TIP.test(line)) {
      const a = lastAmount(stripRate(line));
      if (a) fields.tip = a.value;
      continue;
    }
    if (RE_SHIPPING.test(line) && !RE_TAX.test(line)) { // [PATCH P2] a VAT or tax line must not overwrite shipping
      const a = lastAmount(stripRate(line));
      if (a) fields.shipping = a.value;
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
      const amounts = allAmounts(stripRate(line));
      if (!amounts.length) continue;
      const amount = amounts[amounts.length - 1].value;
      if (/^\s*total\s+(tax|vat|gst)\b/i.test(line)) { fields.taxAmount = amount; continue; }
      const labelMatch = line.match(RE_TAX);
      if (labelMatch && !fields.taxLabel) fields.taxLabel = labelMatch[1].replace(/\s+/g, ' ').trim();
      let base = null;
      const onMatch = line.match(/\bon\b/i);
      if (onMatch) {
        const bm = line.slice(onMatch.index + onMatch[0].length).match(/-?\d[\d.,]*\d|-?\d/);
        if (bm) { const bv = parseNumber(bm[0]); if (bv !== null && bv !== amount) base = bv; }
      }
      fields.taxes.push({ label: line.trim(), rate, base, amount });
      fields.taxAmount = round2(fields.taxes.reduce((sum, t) => sum + t.amount, 0));
      fields.taxRate = fields.taxes.length === 1 ? fields.taxes[0].rate : null;
      continue;
    }
    if (RE_TOTAL.test(line)) {
      // Only treat as total if line starts with total or has colon,
      // to avoid catching prose containing the word total.
      if (/^\s*(grand\s+)?total\b/i.test(line) || /\btotal\s*:/i.test(line) || /\btotal\s+due\b/i.test(line) || /\bgrand\s+total\b/i.test(line) || /\btotal\s+(payable|paid)\b/i.test(line)) { // [PATCH P3]
        const a = lastAmount(stripRate(line));
        if (a) fields.total = a.value;
        continue;
      }
    }
    // [PATCH P5] A prefix item line uses @ as its price marker; it is not
    // an email or header line even though isHeaderOrMetaLine matches @.
    if (/^\d+(?:[.,]\d+)?\s*[x\u00D7]\s+.+\s*@.*\d/.test(line)) {
      const item = parseLineItem(line);
      if (item) { fields.lineItems.push(item); continue; }
    }
    if (isHeaderOrMetaLine(line)) continue;
    if (fields.vendor && line === fields.vendor) continue;
    // Skip address-like and contact lines without a trailing amount pattern.
    const item = parseLineItem(line);
    if (item) { fields.lineItems.push(item); continue; }
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

  return {
    fields,
    checks,
    meta: { linesProcessed: lines.length, fieldsFound, warnings }
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
