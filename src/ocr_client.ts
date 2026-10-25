import type { Worker } from 'tesseract.js';
import { apiFetch } from './api';
import { extractWaveReceiptInfo, ParsedWaveReceipt } from './receipt_parser';

export interface FastOcrScanResult extends ParsedWaveReceipt {
  elapsedMs: number;
  engine: 'native' | 'wasm' | 'server';
}

interface PreparedFrames {
  primaryCanvas: HTMLCanvasElement;
  fallbackCanvas: HTMLCanvasElement | null;
}

// Singleton pre-warmed browser Tesseract worker + serial execution lock
let browserWorkerPromise: Promise<Worker> | null = null;
let workerQueue: Promise<unknown> = Promise.resolve();

function getBrowserOcrWorker(): Promise<Worker> {
  if (!browserWorkerPromise) {
    browserWorkerPromise = (async () => {
      try {
        const mod: any = await import('tesseract.js');
        const createWorkerFn = mod.createWorker || mod.default?.createWorker;
        const singleBlockPsm = mod.PSM?.SINGLE_BLOCK || mod.default?.PSM?.SINGLE_BLOCK || '6';
        const worker: Worker = await createWorkerFn(
          'eng',
          1,
          {
            cacheMethod: 'write',
          },
          {
            // Skip English dictionary DAWGs so digits aren't coerced into letters and init is faster
            load_system_dawg: '0',
            load_freq_dawg: '0',
          }
        );
        await worker.setParameters({
          tessedit_pageseg_mode: singleBlockPsm,
          preserve_interword_spaces: '1',
        });
        return worker;
      } catch (err) {
        browserWorkerPromise = null;
        throw err;
      }
    })();
  }
  return browserWorkerPromise;
}

/**
 * Pre-warms the WebAssembly OCR worker in the background while the user is on the Deposit tab
 * so that when they select a screenshot, cold-start latency is 0ms.
 */
export function preloadReceiptOcr(): void {
  if (typeof window === 'undefined') return;
  // If browser supports instant hardware TextDetector, pre-warm WASM worker gently during idle time
  const hasNative = 'TextDetector' in window;
  if (hasNative) {
    const idle = (window as any).requestIdleCallback || ((cb: () => void) => setTimeout(cb, 1200));
    idle(() => {
      getBrowserOcrWorker().catch(() => {});
    });
  } else {
    getBrowserOcrWorker().catch(() => {});
  }
}

async function runWithBrowserWorker(canvas: HTMLCanvasElement): Promise<string> {
  const run = async () => {
    const worker = await getBrowserOcrWorker();
    const res = await worker.recognize(
      canvas,
      {},
      {
        text: true,
        blocks: false,
        hocr: false,
        tsv: false,
      }
    );
    return res.data.text || '';
  };

  const next = workerQueue.then(run, run);
  workerQueue = next.catch(() => {});
  return next;
}

async function decodeImageSource(
  file: Blob
): Promise<{ source: CanvasImageSource; width: number; height: number; cleanup: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => bitmap.close(),
      };
    } catch {
      // Fallback to HTMLImageElement below
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('ပြေစာပုံ ဖွင့်၍မရပါ။'));
      el.src = objectUrl;
    });
    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      cleanup: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
}

/**
 * Renders a cropped/scaled region onto an offscreen-sized HTMLCanvasElement and applies
 * fast single-pass luminance contrast normalization so grey receipt digits become crisp black-on-white.
 */
function renderContrastCanvas(
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  maxWidth = 720
): HTMLCanvasElement {
  const scale = sw > maxWidth ? maxWidth / sw : 1;
  const targetW = Math.max(1, Math.round(sw * scale));
  const targetH = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return canvas;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, targetW, targetH);
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, targetW, targetH);

  // Fast linear contrast stretch in grayscale (takes < 3ms for ~720x1100px)
  const imgData = ctx.getImageData(0, 0, targetW, targetH);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    // Rec.601 luma
    const lum = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    // Stretch mid-tones: push light receipt backgrounds (>= 212) to pure white and darken text
    let v: number;
    if (lum >= 212) {
      v = 255;
    } else if (lum <= 75) {
      v = 0;
    } else {
      v = Math.round(((lum - 75) * 255) / (212 - 75));
    }
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

async function prepareReceiptFrames(file: Blob): Promise<PreparedFrames> {
  const { source, width, height, cleanup } = await decodeImageSource(file);
  try {
    const aspect = height / Math.max(1, width);
    // Tall mobile phone screenshot (e.g. 1080x2400): crop out top 9% status bar & bottom 8% nav buttons first
    if (aspect > 1.45 && height >= 700) {
      const cropTop = Math.round(height * 0.09);
      const cropBottom = Math.round(height * 0.08);
      const cropHeight = Math.max(100, height - cropTop - cropBottom);

      const primaryCanvas = renderContrastCanvas(source, 0, cropTop, width, cropHeight, 720);
      const fallbackCanvas = renderContrastCanvas(source, 0, 0, width, height, 720);
      return { primaryCanvas, fallbackCanvas };
    }

    // Already cropped receipt image
    const primaryCanvas = renderContrastCanvas(source, 0, 0, width, height, 760);
    return { primaryCanvas, fallbackCanvas: null };
  } finally {
    cleanup();
  }
}

async function tryNativeTextDetector(
  canvas: HTMLCanvasElement,
  excludePhone?: string
): Promise<ParsedWaveReceipt | null> {
  if (typeof window === 'undefined' || !('TextDetector' in window)) {
    return null;
  }
  try {
    const DetectorClass = (window as any).TextDetector;
    const detector = new DetectorClass();
    const blocks: Array<{ rawValue?: string }> = await detector.detect(canvas);
    if (!Array.isArray(blocks) || blocks.length === 0) return null;
    const combinedText = blocks.map((b) => b.rawValue || '').join('\n');
    const parsed = extractWaveReceiptInfo(combinedText, excludePhone);
    return parsed.trx_id ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 3-Tier Ultra-Fast WavePay Receipt Scanner:
 * 1. Hardware ML Kit TextDetector (~80-150ms on Android/macOS Chrome)
 * 2. Pre-warmed in-browser WASM LSTM worker (~400-900ms, zero upload wait)
 * 3. Compressed ~40KB JPEG fallback to warm server worker (/api/ocr/receipt)
 */
export async function scanWaveReceiptFast(
  file: Blob,
  excludePhone?: string
): Promise<FastOcrScanResult> {
  const t0 = performance.now();
  const { primaryCanvas, fallbackCanvas } = await prepareReceiptFrames(file);

  // Tier 1: Hardware-accelerated Native TextDetector
  const nativePrimary = await tryNativeTextDetector(primaryCanvas, excludePhone);
  if (nativePrimary?.trx_id) {
    return {
      ...nativePrimary,
      elapsedMs: Math.round(performance.now() - t0),
      engine: 'native',
    };
  }
  if (fallbackCanvas) {
    const nativeFallback = await tryNativeTextDetector(fallbackCanvas, excludePhone);
    if (nativeFallback?.trx_id) {
      return {
        ...nativeFallback,
        elapsedMs: Math.round(performance.now() - t0),
        engine: 'native',
      };
    }
  }

  // Tier 2: Pre-warmed Local WASM Worker (zero network upload)
  try {
    const primaryText = await runWithBrowserWorker(primaryCanvas);
    const parsedPrimary = extractWaveReceiptInfo(primaryText, excludePhone);
    if (parsedPrimary.trx_id) {
      return {
        ...parsedPrimary,
        elapsedMs: Math.round(performance.now() - t0),
        engine: 'wasm',
      };
    }

    if (fallbackCanvas) {
      const fullText = await runWithBrowserWorker(fallbackCanvas);
      const parsedFull = extractWaveReceiptInfo(fullText, excludePhone);
      if (parsedFull.trx_id) {
        return {
          ...parsedFull,
          elapsedMs: Math.round(performance.now() - t0),
          engine: 'wasm',
        };
      }
    }
  } catch {
    // Fall through to lightweight compressed server fallback
  }

  // Tier 3: Server fallback using ~40KB compressed JPEG instead of 5MB raw PNG
  const targetCanvas = fallbackCanvas || primaryCanvas;
  const compressedJpegBase64 = targetCanvas.toDataURL('image/jpeg', 0.82);

  const res = await apiFetch('/api/ocr/receipt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_base64: compressedJpegBase64,
      exclude_phone: excludePhone || '',
    }),
  });
  const data = await res.json();

  return {
    trx_id: data.trx_id || null,
    last5_digits: data.last5_digits || null,
    extracted_amount: data.extracted_amount ?? null,
    elapsedMs: Math.round(performance.now() - t0),
    engine: 'server',
  };
}
