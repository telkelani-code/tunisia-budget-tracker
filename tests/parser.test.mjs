// Unit tests for the receipt total finder. Usage: node tests/parser.test.mjs
import { readFileSync } from 'node:fs';
import { findTotals, parseAmount, amountsIn, guessShop } from '../js/receipt-parser.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
}

eq('parse 3dp', parseAmount('23.450'), 23.45);
eq('parse comma', parseAmount('87,320'), 87.32);
eq('parse thousands', parseAmount('1 245,800'), 1245.8);
eq('parse mixed', parseAmount('1.234,500'), 1234.5);
eq('amounts DT', amountsIn('A PAYER 7.500 DT'), [7.5]);
eq('amounts skip dates/times', amountsIn('10/11/2026 18:42'), []);
eq('amounts O→0', amountsIn('TOTAL TTC 23.45O'), [23.45]);
eq('amounts split dot', amountsIn('TOTAL 12 .500'), [12.5]);

// Clean text of every fixture receipt
const receipts = JSON.parse(readFileSync(new URL('./fixtures/receipts.json', import.meta.url), 'utf8'));
for (const r of receipts) eq('fixture ' + r.name, findTotals(r.lines.join('\n'))[0], r.expected);

// Typical OCR output with misreads
const noisy = [
  ['ttc with junk', 'CARREFOUR\nArticles: 6\nTOTAL TTC . 23,45O\nESPECES 50.000\nRENDU 26.550', 23.45],
  ['net a payer lowercase', 'monoprix\nsous-total 87.320\nnet a payer 87.320d\nespeces 100.000\nmonnaie 12.680', 87.32],
  ['no keyword, cash minus change', 'BOUTIQUE\n12.000\n8.500\nESPECES 30.000\nRENDU 9.500', 20.5],
  ['total on next line', 'NET A PAYER\n156.900\nESPECES 160.000', 156.9],
  ['subtotal lower than total', 'SOUS TOTAL 40.000\nTIMBRE 1.000\nTOTAL 41.000', 41],
  ['english', 'Subtotal 41.20\nTax 3.30\nTotal 44.50\nCash 50.00\nChange 5.50', 44.5],
  ['montant ttc', 'Montant TTC : 64,250 DT\nTVA 7% 4,203', 64.25],
];
for (const [n, text, want] of noisy) eq('noisy ' + n, findTotals(text)[0], want);

eq('shop carrefour', guessShop('CARREFOUR MARKET\nLa Marsa').shop, 'Carrefour');
eq('shop pharmacie cat', guessShop('PHARMACIE EL AMEN\nTunis').cat, 'health');
eq('shop generic', guessShop('SUPERETTE EL AMEN\n12.000').shop, 'Superette El Amen');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
