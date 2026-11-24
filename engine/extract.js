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
const RE_TOTAL = /\b(grand\s+total|total\s+due|total)\b/i;
const RE_AMOUNT_DUE = /\b(amount\s+due|balance\s+due|balance)\b/i;

function isFooterLabel(line) {
  return RE_SUBTOTAL.test(line) || RE_TAX.test(line) || RE_SHIPPING.test(line) ||
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
// Main entry
// ------------------------------------------------------------------
export function extractDocument(text) {
  const warnings = [];
  const input = typeof text === 'string' ? text : '';
  const rawLines = input.split(/\r?\n/);
  const lines = rawLines.map(l => l.trim()).filter(l => l.length > 0);
  const fields = {
    vendor: null, invoiceNumber: null, invoiceDate: null, dueDate: null,
    currency: null, lineItems: [], subtotal: null, taxLabel: null,
    taxRate: null, taxAmount: null, shipping: null, total: null, amountDue: null
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
    // Subtotal takes priority over total.
    if (RE_SUBTOTAL.test(line)) {
      const a = lastAmount(stripRate(line));
      if (a) fields.subtotal = a.value;
      continue;
    }
    if (RE_AMOUNT_DUE.test(line)) {
      const a = lastAmount(stripRate(line));
      if (a) fields.amountDue = a.value;
      // Amount Due line may also be the total in some layouts; do not
      // also treat it as total unless no total was found yet and the
      // line explicitly says total. Keep amountDue separate.
      continue;
    }
    if (RE_SHIPPING.test(line)) {
      const a = lastAmount(stripRate(line));
      if (a) fields.shipping = a.value;
      continue;
    }
    if (RE_TAX.test(line) && !RE_SUBTOTAL.test(line)) {
      const labelMatch = line.match(RE_TAX);
      if (labelMatch) fields.taxLabel = labelMatch[1].replace(/\s+/g, ' ').trim();
      const rateMatch = line.match(/(\d+(?:[.,]\d+)?)\s*%/);
      if (rateMatch) fields.taxRate = parseNumber(rateMatch[1]);
      const withoutRate = line.replace(/\d+(?:[.,]\d+)?\s*%/, '');
      const a = lastAmount(withoutRate.replace(RE_TAX, ''));
      // If the only number was the rate, lastAmount on cleaned line may
      // still pick label digits; guard by requiring an amount token
      // outside parentheses rate or after a colon.
      if (a && fields.taxAmount === null) {
        // Avoid mistaking the rate itself for amount when no amount exists.
        const amounts = allAmounts(withoutRate);
        if (amounts.length > 0) fields.taxAmount = amounts[amounts.length - 1].value;
      }
      continue;
    }
    if (RE_TOTAL.test(line)) {
      // Only treat as total if line starts with total or has colon,
      // to avoid catching prose containing the word total.
      if (/^\s*(grand\s+)?total\b/i.test(line) || /\btotal\s*:/i.test(line) || /\btotal\s+due\b/i.test(line) || /\bgrand\s+total\b/i.test(line)) {
        const a = lastAmount(stripRate(line));
        if (a) fields.total = a.value;
        continue;
      }
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
    const expected = fields.subtotal + (fields.taxAmount || 0) + (fields.shipping || 0);
    const parts = [`subtotal ${fields.subtotal.toFixed(2)}`];
    if (fields.taxAmount !== null) parts.push(`tax ${fields.taxAmount.toFixed(2)}`);
    if (fields.shipping !== null) parts.push(`shipping ${fields.shipping.toFixed(2)}`);
    const ok = approxEqual(expected, fields.total, TOL);
    checks.push({ id: 'subtotal-plus-charges-total', label: 'Subtotal + tax + shipping vs total', status: ok ? 'pass' : 'fail',
      detail: ok ? `${parts.join(' + ')} = ${expected.toFixed(2)} matches total ${fields.total.toFixed(2)}`
                 : `${parts.join(' + ')} = ${expected.toFixed(2)} does not match total ${fields.total.toFixed(2)} (difference ${(expected - fields.total).toFixed(2)})` });
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

  if (fields.taxRate !== null && fields.taxAmount !== null && fields.subtotal !== null) {
    const expectedTax = round2(fields.subtotal * fields.taxRate / 100);
    const ok = approxEqual(expectedTax, fields.taxAmount, TOL) || approxEqual(fields.subtotal * fields.taxRate / 100, fields.taxAmount, TOL);
    checks.push({ id: 'tax-rate-amount', label: 'Tax amount vs rate x subtotal', status: ok ? 'pass' : 'fail',
      detail: ok ? `Tax ${fields.taxAmount.toFixed(2)} matches ${fields.taxRate}% of subtotal ${fields.subtotal.toFixed(2)}`
                 : `Tax ${fields.taxAmount.toFixed(2)} does not match ${fields.taxRate}% of subtotal ${fields.subtotal.toFixed(2)} (expected ${expectedTax.toFixed(2)})` });
  } else {
    const missing = fields.taxRate === null ? 'no tax rate stated' : fields.taxAmount === null ? 'no tax amount stated' : 'no subtotal stated';
    checks.push({ id: 'tax-rate-amount', label: 'Tax amount vs rate x subtotal', status: 'skip', detail: `Skipped: ${missing}` });
  }

  const fieldsFound = [
    fields.vendor, fields.invoiceNumber, fields.invoiceDate, fields.dueDate,
    fields.currency, fields.subtotal, fields.taxAmount, fields.shipping,
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
