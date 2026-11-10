// Finds the amount paid in text read from a receipt photo.
// Tuned for Tunisian receipts (dinars with 3 decimals, French/English/Arabic labels)
// but works for 2-decimal receipts too. Pure functions, no DOM: unit-tested in Node.

export function parseAmount(str) {
  if (str == null) return NaN;
  let s = String(str).trim().replace(/\s/g, '').replace(/[^\d.,-]/g, '');
  if (!s) return NaN;
  // "1.234,500" or "1,234.500": the last separator is the decimal point
  const dec = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  if (dec > -1) s = s.slice(0, dec).replace(/[.,]/g, '') + '.' + s.slice(dec + 1);
  return parseFloat(s);
}

const round3 = v => Math.round(v * 1000) / 1000;

// Lines that name the amount to pay. Strong = almost certainly the final total.
const STRONG_TOTAL = /(net\s*[aà]\s*pay[eé]r|total\s*t\.?t\.?c|montant\s*t\.?t\.?c|[aà]\s*payer|grand\s*total|amount\s*due|total\s*due|total\s*[aà]\s*payer|الصافي|المبلغ\s*الجملي|للدفع)/i;
const TOTAL_WORDS = /(net\s*[aà]\s*pay[eé]r|total|montant|[aà]\s*payer|amount\s*due|\bttc\b|somme|\bnet\b|الجملة|المجموع|المبلغ)/i;
// Lines whose numbers are NOT the total
const EXCLUDE_WORDS = /(esp[eè]ces|rendu|monnaie|\bchange\b|\bcash\b|re[çc]u|carte|\bcb\b|tva|t\.v\.a|\bht\b|sous[\s-]*total|subtotal|remise|discount|[ée]conomie|fid[ée]lit[ée]|points?|timbre|articles?|qt[ée]|quantit|nombre|\btel\b|t[ée]l[ée]phone|\bfax\b|\bmf\b|matricule|code|ticket|caisse|n[°o]\s|\bdate\b|heure|\d{1,2}[:h]\d{2})/i;
const CASH_GIVEN = /(esp[eè]ces|\bcash\b|re[çc]u|vers[ée])/i;
const CHANGE_GIVEN = /(rendu|monnaie|\bchange\b)/i;

const NUM_RE = /(\d{1,3}(?:[ .]\d{3})+[.,]\d{2,3}|\d+[.,]\d{2,3}|\d+)(?!\d)/g;

// Fix common OCR slips inside numbers: O→0, l/I→1, "8 . 210" → "8.210"
export function cleanLine(line) {
  return (line || '')
    .replace(/[|]/g, ' ')
    .replace(/(\d)[oO](?=[\d.,oO])/g, '$10').replace(/(\d)[oO](?=[\d.,oO])/g, '$10')
    .replace(/([.,])[oO](?=\d)/g, '$10').replace(/(\d[.,]\d*)[oO]/g, '$10')
    .replace(/(\d)[lI](?=[\d.,])/g, '$11')
    .replace(/(\d)\s*([.,])\s+(\d{3})(?!\d)/g, '$1$2$3')
    .replace(/(\d)\s+([.,])(\d{2,3})(?!\d)/g, '$1$2$3')
    .trim();
}

export function amountsIn(line) {
  const out = [];
  line = cleanLine(line);
  // Tunisian receipts print "8.210d" / "8.210 DT"; the "d" is often misread as 4, 0 or ¢
  line = line.replace(/(\d[.,]\d{3})[d¢](?![a-z\d])/gi, '$1 d');
  const mentionsDinar = /\b(dt|tnd|dinars?|d)\b|د\.?ت/i.test(line);
  let m;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(line))) {
    const raw = m[1];
    // Skip parts of dates / times / phone numbers
    const before = line.slice(Math.max(0, m.index - 1), m.index), after = line.charAt(m.index + raw.length);
    if (/[\/:]/.test(before) || /[\/:]/.test(after)) continue;
    if (/[.,]\d{2,3}$/.test(raw)) {
      const v = parseAmount(raw);
      if (v > 0 && v < 100000) out.push(round3(v));
    } else if (mentionsDinar && raw.length <= 5) {
      const v = parseFloat(raw);
      if (v > 0 && v < 100000) out.push(v);
    }
  }
  return out;
}

/**
 * Returns candidate totals, best first (max 5).
 */
export function findTotals(text) {
  const lines = String(text || '').split(/\n/).map(l => l.trim()).filter(Boolean);
  const scored = new Map();
  const add = (v, s) => { v = round3(v); scored.set(v, Math.max(scored.get(v) ?? -Infinity, s)); };
  let cashGiven = null, changeGiven = null;

  lines.forEach((l, i) => {
    const strong = STRONG_TOTAL.test(l);
    const hasTotal = strong || TOTAL_WORDS.test(l);
    const hasEx = EXCLUDE_WORDS.test(l) && !strong;
    const nums = amountsIn(l);
    const next = lines[i + 1] || '';

    if (CASH_GIVEN.test(l) && !strong) { const n = nums.length ? nums : amountsIn(next); if (n.length) cashGiven = n[n.length - 1]; }
    if (CHANGE_GIVEN.test(l) && !strong) { const n = nums.length ? nums : amountsIn(next); if (n.length) changeGiven = n[n.length - 1]; }

    if (hasTotal && !hasEx) {
      let s = strong ? 100 : 80;
      s += (i / lines.length) * 10; // totals sit lower on the receipt
      if (nums.length) {
        // On a total line the right-most number is the amount; others are often counts
        nums.forEach((v, k) => add(v, k === nums.length - 1 ? s : s - 30));
      } else {
        // Amount printed on the next line
        amountsIn(next).forEach(v => add(v, EXCLUDE_WORDS.test(next) ? s - 40 : s - 10));
      }
    } else if (!hasEx) {
      nums.forEach(v => add(v, 10));
    } else {
      nums.forEach(v => add(v, 0));
    }
  });

  // Cash handed over minus change returned should equal the total
  if (cashGiven != null && changeGiven != null && cashGiven > changeGiven) {
    const paid = round3(cashGiven - changeGiven);
    if (scored.has(paid)) add(paid, scored.get(paid) + 25);
    else add(paid, 70);
  }

  // The biggest amount that isn't cash handed over is a reasonable backup
  const all = [...scored.keys()].filter(v => v !== cashGiven);
  if (all.length) {
    const maxV = Math.max(...all);
    add(maxV, (scored.get(maxV) ?? 0) + 15);
  }
  return [...scored.entries()]
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])
    .map(a => a[0])
    .slice(0, 5);
}

const SHOPS = [
  [/carr?e?four|arrefour|pfour\b|efour\b/i, 'Carrefour', 'groceries'],
  [/monoprix|onoprix/i, 'Monoprix', 'groceries'],
  [/magasin\s*g[ée]n[ée]ral/i, 'Magasin Général', 'groceries'],
  [/aziza/i, 'Aziza', 'groceries'],
  [/g[ée]ant/i, 'Géant', 'groceries'],
  [/mg\s*maxi/i, 'MG Maxi', 'groceries'],
  [/bonprix/i, 'Bonprix', 'shopping'],
  [/pharmacie/i, 'Pharmacie', 'health'],
  [/boulangerie|p[âa]tisserie/i, 'Boulangerie', 'food'],
  [/restaurant|resto\b|pizz/i, null, 'food'],
  [/caf[ée]\b|coffee/i, null, 'coffee'],
  [/taxi|louage|station|agil|shell|total\s*energies|essence/i, null, 'transport'],
  [/steg|sonede|ooredoo|orange|tunisie\s*telecom|facture/i, null, 'bills']
];

/** Returns {shop, cat} guessed from the top of the receipt. */
export function guessShop(text) {
  const lines = String(text || '').split('\n');
  const top = lines.slice(0, 15).join('\n');
  let cat = null;
  for (const [re, name, c] of SHOPS) {
    if (re.test(top)) {
      cat = cat || c;
      if (name) return { shop: name, cat: c };
    }
  }
  for (const raw of lines.slice(0, 8)) {
    const l = raw.replace(/[^A-Za-zÀ-ÿ0-9&' .-]/g, ' ').replace(/\s+/g, ' ').trim();
    const letters = (l.match(/[A-Za-zÀ-ÿ]/g) || []).length;
    if (l.length >= 5 && l.length < 32 && letters / l.length > 0.8 && /[A-Za-zÀ-ÿ]{4,}/.test(l) &&
        !/^(tel|mf|ticket|date|bienvenue|welcome|facture|re[çc]u)/i.test(l)) {
      return { shop: l.replace(/\b\w/g, ch => ch.toUpperCase()).replace(/\B\w+/g, w => w.toLowerCase()), cat };
    }
  }
  return { shop: '', cat };
}
