/*
 * GhostLabs AI - Built-in sample documents for the Playground.
 * No em dash characters are used in sample text.
 */

export const SAMPLE_CLEAN = `Acme Supplies Inc.
123 Main Street, Springfield
Invoice No: INV-2026-001
Invoice Date: 2026-11-23
Due Date: 2026-12-23

Widget Pro 2 x 49.00 98.00
Gadget Basic 3 25.50 76.50
Service Fee 1 x 25.50 25.50

Subtotal: $200.00
VAT (10%): $20.00
Shipping: $10.00
Total: $230.00
Amount Due: $230.00`;

export const SAMPLE_ERROR = `Northwind Traders
456 Commerce Road
Invoice No: INV-2026-002
Invoice Date: Nov 23, 2026
Due Date: Dec 7, 2026

Item Alpha 2 x 30.00 60.00
Item Beta 1 x 40.00 40.00

Subtotal: $120.00
VAT (10%): $12.00
Total: $132.00
Amount Due: $132.00`;

export const SAMPLE_MESSY = `Corner Store
Receipt
Date: Nov 23, 2026

Coffee 45.50
Sandwich 120.00

Total: 165.50
Thank you for shopping`;

export const SAMPLES = [
  { id: 'clean', label: 'Clean invoice (all checks should pass)', text: SAMPLE_CLEAN },
  { id: 'error', label: 'Invoice with arithmetic error (subtotal check should fail)', text: SAMPLE_ERROR },
  { id: 'messy', label: 'Messy receipt (partial fields, some checks skip)', text: SAMPLE_MESSY }
];

if (typeof globalThis !== 'undefined') {
  globalThis.GhostLabsSamples = { SAMPLES, SAMPLE_CLEAN, SAMPLE_ERROR, SAMPLE_MESSY };
}
export default SAMPLES;
