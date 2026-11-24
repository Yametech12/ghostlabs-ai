import { extractDocument } from './extract.js';
import { SAMPLE_CLEAN, SAMPLE_ERROR, SAMPLE_MESSY } from './samples.js';

let failures = 0;
let total = 0;
function check(name, cond, detail = '') {
  total++;
  if (cond) { console.log(`PASS ${name}`); }
  else { failures++; console.log(`FAIL ${name}${detail ? ' - ' + detail : ''}`); }
}
function checkById(result, id) { return result.checks.find(c => c.id === id); }

// 1. Clean invoice passes all checks
{
  const r = extractDocument(SAMPLE_CLEAN);
  check('clean: vendor', r.fields.vendor === 'Acme Supplies Inc.', String(r.fields.vendor));
  check('clean: invoiceNumber', r.fields.invoiceNumber === 'INV-2026-001', String(r.fields.invoiceNumber));
  check('clean: invoiceDate', r.fields.invoiceDate === '2026-11-23', String(r.fields.invoiceDate));
  check('clean: dueDate', r.fields.dueDate === '2026-12-23', String(r.fields.dueDate));
  check('clean: currency USD', r.fields.currency === 'USD', String(r.fields.currency));
  check('clean: 3 line items', r.fields.lineItems.length === 3, JSON.stringify(r.fields.lineItems));
  check('clean: first item qty/price/amount', r.fields.lineItems[0] && r.fields.lineItems[0].qty === 2 && r.fields.lineItems[0].unitPrice === 49 && r.fields.lineItems[0].amount === 98, JSON.stringify(r.fields.lineItems[0]));
  check('clean: second item qty/price/amount', r.fields.lineItems[1] && r.fields.lineItems[1].qty === 3 && r.fields.lineItems[1].unitPrice === 25.5 && r.fields.lineItems[1].amount === 76.5, JSON.stringify(r.fields.lineItems[1]));
  check('clean: subtotal 200', r.fields.subtotal === 200, String(r.fields.subtotal));
  check('clean: taxRate 10', r.fields.taxRate === 10, String(r.fields.taxRate));
  check('clean: taxAmount 20', r.fields.taxAmount === 20, String(r.fields.taxAmount));
  check('clean: shipping 10', r.fields.shipping === 10, String(r.fields.shipping));
  check('clean: total 230', r.fields.total === 230, String(r.fields.total));
  check('clean: amountDue 230', r.fields.amountDue === 230, String(r.fields.amountDue));
  check('clean: all checks pass', r.checks.every(c => c.status === 'pass'), JSON.stringify(r.checks));
}

// 2. Error invoice fails the right check
{
  const r = extractDocument(SAMPLE_ERROR);
  check('error: line items sum is 100', Math.abs(r.fields.lineItems.reduce((s, i) => s + i.amount, 0) - 100) < 0.001, JSON.stringify(r.fields.lineItems));
  check('error: stated subtotal 120', r.fields.subtotal === 120, String(r.fields.subtotal));
  const c = checkById(r, 'items-sum-subtotal');
  check('error: items-sum-subtotal fails', c && c.status === 'fail', JSON.stringify(c));
  const t = checkById(r, 'subtotal-plus-charges-total');
  check('error: total check still passes (120+12=132)', t && t.status === 'pass', JSON.stringify(t));
  const tax = checkById(r, 'tax-rate-amount');
  check('error: tax check passes (10% of stated subtotal)', tax && tax.status === 'pass', JSON.stringify(tax));
}

// 3. Messy receipt: partial fields, some checks skip
{
  const r = extractDocument(SAMPLE_MESSY);
  check('messy: vendor Corner Store', r.fields.vendor === 'Corner Store', String(r.fields.vendor));
  check('messy: total 165.50', r.fields.total === 165.5, String(r.fields.total));
  check('messy: 2 line items', r.fields.lineItems.length === 2, JSON.stringify(r.fields.lineItems));
  check('messy: no invoiceNumber (null, not invented)', r.fields.invoiceNumber === null, String(r.fields.invoiceNumber));
  check('messy: no subtotal (null)', r.fields.subtotal === null, String(r.fields.subtotal));
  check('messy: invoiceDate parsed from Date line', r.fields.invoiceDate === '2026-11-23', String(r.fields.invoiceDate));
  check('messy: at least one check skips', r.checks.some(c => c.status === 'skip'), JSON.stringify(r.checks));
  check('messy: items-sum check skips', checkById(r, 'items-sum-subtotal').status === 'skip');
  check('messy: tax check skips', checkById(r, 'tax-rate-amount').status === 'skip');
  check('messy: no crash, meta present', typeof r.meta.linesProcessed === 'number' && Array.isArray(r.meta.warnings));
}

// 4. Empty text
{
  const r = extractDocument('');
  check('empty: no line items', r.fields.lineItems.length === 0);
  check('empty: subtotal null', r.fields.subtotal === null);
  check('empty: total null', r.fields.total === null);
  check('empty: all checks skip', r.checks.every(c => c.status === 'skip'), JSON.stringify(r.checks));
  check('empty: fieldsFound 0', r.meta.fieldsFound === 0, String(r.meta.fieldsFound));
}

// 5. Garbage text: no fields, no crash
{
  const r = extractDocument('hello world\nfoo bar baz\nlorem ipsum dolor');
  check('garbage: no line items', r.fields.lineItems.length === 0, JSON.stringify(r.fields.lineItems));
  check('garbage: subtotal null', r.fields.subtotal === null);
  check('garbage: total null', r.fields.total === null);
  check('garbage: checks present', r.checks.length === 4, String(r.checks.length));
}

// 6. Comma-decimal amounts
{
  const text = `Euro Shop\nInvoice No: EU-100\nInvoice Date: 23/11/2026\n\nKaffee 2 x 49,00 98,00\nKuchen 1 x 12,50 12,50\n\nSubtotal: 110,50\nTotal: 110,50`;
  const r = extractDocument(text);
  check('comma-decimal: subtotal 110.50', r.fields.subtotal === 110.5, String(r.fields.subtotal));
  check('comma-decimal: total 110.50', r.fields.total === 110.5, String(r.fields.total));
  check('comma-decimal: first amount 98', r.fields.lineItems[0] && r.fields.lineItems[0].amount === 98, JSON.stringify(r.fields.lineItems));
  check('comma-decimal: items-sum passes', checkById(r, 'items-sum-subtotal').status === 'pass', JSON.stringify(r.checks));
  check('comma-decimal: date day/month/year', r.fields.invoiceDate === '2026-11-23', String(r.fields.invoiceDate));
}

// 7. Thousands separators and parentheses negatives (extra robustness)
{
  const text = `Big Co\nInvoice No: BIG-1\n\nServer 1 x 1,234.56 1,234.56\n\nSubtotal: 1,234.56\nTotal: 1,234.56`;
  const r = extractDocument(text);
  check('thousands: subtotal 1234.56', r.fields.subtotal === 1234.56, String(r.fields.subtotal));
  check('thousands: items-sum passes', checkById(r, 'items-sum-subtotal').status === 'pass', JSON.stringify(r.checks));
}

console.log(`\n${total - failures}/${total} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
