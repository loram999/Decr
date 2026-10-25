export interface ParsedWaveReceipt {
  trx_id: string | null;
  last5_digits: string | null;
  extracted_amount: number | null;
}

const MYANMAR_DIGITS = '၀၁၂၃၄၅၆၇၈၉';

export function normalizeMyanmarDigits(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const idx = MYANMAR_DIGITS.indexOf(input[i]);
    out += idx !== -1 ? String(idx) : input[i];
  }
  return out;
}

function normalizeCoreMsisdn(phone: string): string {
  const digits = normalizeMyanmarDigits(String(phone || '')).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('959') && digits.length >= 10) return digits.slice(2);
  if (digits.startsWith('09') && digits.length >= 9) return digits.slice(1);
  if (digits.startsWith('9') && digits.length >= 8 && digits.length <= 10) return digits;
  return digits;
}

function isLikelyMyanmarPhone(candidate: string, excludedCorePhone: string): boolean {
  const clean = candidate.replace(/\D/g, '');
  if (!clean) return true;

  if (excludedCorePhone) {
    const candCore = normalizeCoreMsisdn(clean);
    if (candCore === excludedCorePhone || (clean.length <= 12 && clean.includes(excludedCorePhone))) {
      return true;
    }
  }

  // Standard Myanmar mobile formats: 09xxxxxxxxx (9-11 digits) or 959xxxxxxxxx (10-12 digits)
  if (clean.startsWith('09') && clean.length >= 9 && clean.length <= 11) {
    return true;
  }
  if (clean.startsWith('959') && clean.length >= 10 && clean.length <= 12) {
    return true;
  }
  return false;
}

function isLikelyDateCompact(candidate: string): boolean {
  // Exclude 8-digit YYYYMMDD dates like 20240101 - 20351231
  if (candidate.length === 8 && /^20[2-3]\d(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(candidate)) {
    return true;
  }
  return false;
}

const TRX_LABEL_REGEX =
  /(?:transaction\s*(?:id|no|number|code|#)?|trans(?:action)?\s*(?:id|no|code)?|order\s*(?:id|no|number|#)?|trx\s*(?:id|no)?|txn\s*(?:id|no)?|ref(?:erence)?\s*(?:id|no|number|code)?|လုပ်ဆောင်ချက်\s*အမှတ်စဉ်|လုပ်ငန်းစဉ်\s*အမှတ်|အော်ဒါ\s*အမှတ်|အမှတ်စဉ်)/i;

/**
 * Extracts WavePay (8-16 digits), KBZPay (16-22 digit Order No), and AYA Pay (10-16 digit Reference Code)
 * Transaction IDs and amounts from OCR text with strict phone/date filtering.
 */
export function extractWaveReceiptInfo(rawText: string, excludePhone?: string): ParsedWaveReceipt {
  const normalized = normalizeMyanmarDigits(String(rawText || ''));
  if (!normalized.trim()) {
    return { trx_id: null, last5_digits: null, extracted_amount: null };
  }

  const excludedCore = normalizeCoreMsisdn(excludePhone || '');
  const lines = normalized
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let trxId = '';

  // Pass 1: Look adjacent to explicit Transaction ID / Order No / Reference labels (same line or immediate next line)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!TRX_LABEL_REGEX.test(line)) continue;

    const afterLabel = line.replace(TRX_LABEL_REGEX, ' ');
    const windowLines = [afterLabel, lines[i + 1] || ''];

    for (const segment of windowLines) {
      if (!segment) continue;
      // Check contiguous 7-24 digit numbers (covers Wave 8-16, AYA 12, KBZPay 20 digits)
      const directMatches = segment.match(/\b\d{7,24}\b/g) || [];
      for (const cand of directMatches) {
        if (!isLikelyMyanmarPhone(cand, excludedCore) && !isLikelyDateCompact(cand)) {
          trxId = cand;
          break;
        }
      }
      if (trxId) break;

      // Also handle accidental single OCR space inside a long digit run on a Trx/Order ID line
      const collapsed = segment.replace(/(\d)[ \t]+(?=\d)/g, '$1');
      const collapsedMatches = collapsed.match(/\b\d{8,24}\b/g) || [];
      for (const cand of collapsedMatches) {
        if (!isLikelyMyanmarPhone(cand, excludedCore) && !isLikelyDateCompact(cand)) {
          trxId = cand;
          break;
        }
      }
      if (trxId) break;
    }

    if (trxId) break;
  }

  // Pass 2: Scan all standalone 8-24 digit sequences across the receipt (excluding phones, +959..., and dates)
  if (!trxId) {
    const scrubbed = normalized
      .replace(/(?:\+?95\s*9|09)[\s\-]*\d[\d\s\-]{6,11}/g, ' ')
      .replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?/g, ' ');

    const candidates = scrubbed.match(/\b\d{8,24}\b/g) || [];
    const validCandidates = candidates.filter(
      (c) => !isLikelyMyanmarPhone(c, excludedCore) && !isLikelyDateCompact(c)
    );

    // Prefer 9-22 digit IDs (Wave 9-16, AYA 12, KBZPay 20)
    const preferred = validCandidates.find((c) => c.length >= 9 && c.length <= 22);
    trxId = preferred || validCandidates[0] || '';
  }

  // Extract transfer amount if present (e.g. "15,000.00 Ks", "15,000 MMK", "- 5,000.00 Ks")
  const amountMatch = normalized.match(
    /(\d{1,3}(?:,\d{3})+|\d{3,9})(?:\.\d{1,2})?\s*(?:Ks|MMK|Kyat|ကျပ်)/i
  );
  const extractedAmount =
    amountMatch && amountMatch[1] ? parseFloat(amountMatch[1].replace(/,/g, '')) : null;

  return {
    trx_id: trxId || null,
    last5_digits: trxId ? trxId.slice(-5) : null,
    extracted_amount: Number.isFinite(extractedAmount) ? extractedAmount : null,
  };
}
