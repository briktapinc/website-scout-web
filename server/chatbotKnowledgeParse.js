'use strict';

/**
 * Extract searchable text from chatbot knowledge uploads.
 * Prefer Node-only libs that work in Docker (no system LibreOffice).
 */

const path = require('path');

const MAX_TEXT = 200000;
const SUPPORTED_EXT = [
  '.pdf',
  '.doc', '.docx',
  '.xls', '.xlsx', '.csv',
  '.ppt', '.pptx',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff',
  '.txt', '.md', '.markdown', '.html', '.htm', '.json', '.rtf',
];

const SUPPORTED_LABEL = 'PDF, Word (.doc/.docx), Excel (.xls/.xlsx), PowerPoint (.ppt/.pptx), images (OCR), and text/Markdown/HTML';

function extOf(fileName = '') {
  const base = String(fileName || '').split(/[\\/]/).pop() || '';
  const i = base.lastIndexOf('.');
  return i >= 0 ? base.slice(i).toLowerCase() : '';
}

function isOcrInput(opts = {}) {
  const ext = extOf(opts.fileName), mime = String(opts.mimeType || '').toLowerCase();
  // Follow the same priority as extraction, so a spoofed image MIME cannot give
  // a document parser the OCR worker's network/native-module permissions.
  if (['.pdf','.doc','.docx','.xls','.xlsx','.csv','.ppt','.pptx'].includes(ext)
    || mime === 'application/pdf' || mime.includes('wordprocessingml') || mime === 'application/msword'
    || mime.includes('spreadsheet') || mime === 'text/csv' || mime === 'application/vnd.ms-excel'
    || mime.includes('presentationml') || mime === 'application/vnd.ms-powerpoint') return false;
  return /^image\//.test(mime) || ['.png','.jpg','.jpeg','.webp','.gif','.bmp','.tif','.tiff'].includes(ext);
}

function normalizeText(s) {
  return String(s || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT);
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n) || 32));
}

async function extractPdf(buf) {
  return extractViaOfficeParser(buf, 'application/pdf');
}

async function extractDocx(buf) {
  return extractViaOfficeParser(buf, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

async function extractDoc(buf) {
  try {
    const WordExtractor = require('word-extractor');
    const extractor = new WordExtractor();
    const doc = await extractor.extract(buf);
    const parts = [doc.getBody(), doc.getHeaders(), doc.getFooters(), doc.getFootnotes()]
      .filter(Boolean)
      .join('\n');
    return { text: normalizeText(parts), extractor: 'word-extractor' };
  } catch (err) {
    // Fallback: officeparser sometimes handles legacy Word.
    return extractViaOfficeParser(buf, 'application/msword');
  }
}

async function extractExcel(buf, fileName) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, dense: true, codepage: extOf(fileName) === '.csv' ? 65001 : undefined });
  const chunks = [];
  for (const name of wb.SheetNames || []) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet);
    if (csv && csv.trim()) chunks.push(`## Sheet: ${name}\n${csv}`);
  }
  return {
    text: normalizeText(chunks.join('\n\n')),
    extractor: 'xlsx',
    meta: { sheets: (wb.SheetNames || []).length, fileName },
  };
}

async function extractViaOfficeParser(buf, mimeHint) {
  const officeParser = require('officeparser');
  const ast = await officeParser.parseOffice(buf, {
    ignoreNotes: false,
    extractAttachments: false,
    ocr: false,
    includeRawContent: false,
    decompressionLimits: {
      maxUncompressedBytes: 32 * 1024 * 1024, maxZipEntries: 2000,
      maxTableCells: 100000, maxXmlElements: 200000, maxRepeatedContent: 4 * 1024 * 1024,
    },
  });
  const { value: text } = await ast.to('text', {
    includeImages: false, textConfig: { preserveLayout: false, renderNotes: true },
  });
  return {
    text: normalizeText(text),
    extractor: 'officeparser',
    meta: mimeHint ? { mimeHint } : undefined,
  };
}

async function extractPptx(buf) {
  return extractViaOfficeParser(
    buf,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  );
}

async function extractImageOcr(buf, mimeType) {
  let pngBuf = buf;
  let sharpUsed = false;
  try {
    const sharp = require('sharp');
    pngBuf = await sharp(buf, { limitInputPixels: 16000000 })
      .rotate()
      .grayscale()
      .normalize()
      .png()
      .toBuffer();
    sharpUsed = true;
  } catch (error) {
    if (/pixel limit|image dimensions|Input image exceeds/i.test(String(error.message || ''))) throw error;
    pngBuf = buf;
  }
  const Tesseract = require('tesseract.js');
  const result = await Tesseract.recognize(pngBuf, 'eng', {
    logger: () => {},
    cacheMethod: 'none',
  });
  const text = normalizeText(result && result.data && result.data.text);
  return {
    text,
    extractor: sharpUsed ? 'tesseract+sharp' : 'tesseract',
    meta: { mimeType: mimeType || '', confidence: result && result.data && result.data.confidence },
  };
}

async function extractPlain(buf, ext) {
  let raw = buf.toString('utf8');
  if (ext === '.html' || ext === '.htm') raw = stripHtml(raw);
  if (ext === '.rtf') {
    raw = raw
      .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
      .replace(/\\[a-zA-Z]+\d* ?/g, ' ')
      .replace(/[{}]/g, ' ');
  }
  return { text: normalizeText(raw), extractor: 'plain' };
}

/**
 * @param {Buffer} buf
 * @param {{ fileName?: string, mimeType?: string }} opts
 * @returns {Promise<{ text: string, extractor: string, supported: boolean, warning?: string, meta?: object }>}
 */
async function extractKnowledgeText(buf, opts = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) {
    return { text: '', extractor: 'none', supported: false, warning: 'empty file' };
  }
  const fileName = String(opts.fileName || 'upload.bin');
  const mime = String(opts.mimeType || '').toLowerCase();
  const ext = extOf(fileName);

  try {
    if (ext === '.pdf' || mime === 'application/pdf') {
      return { ...(await extractPdf(buf)), supported: true };
    }
    if (ext === '.docx'
      || mime.includes('wordprocessingml')
      || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      return { ...(await extractDocx(buf)), supported: true };
    }
    if (ext === '.doc' || mime === 'application/msword') {
      return { ...(await extractDoc(buf)), supported: true };
    }
    if (ext === '.xlsx' || ext === '.xls' || ext === '.csv'
      || mime.includes('spreadsheet') || mime === 'text/csv'
      || mime === 'application/vnd.ms-excel') {
      return { ...(await extractExcel(buf, fileName)), supported: true };
    }
    if (ext === '.pptx'
      || mime.includes('presentationml')
      || mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
      return { ...(await extractPptx(buf)), supported: true };
    }
    if (ext === '.ppt' || mime === 'application/vnd.ms-powerpoint') {
      return { ...(await extractViaOfficeParser(buf, mime || 'application/vnd.ms-powerpoint')), supported: true };
    }
    if (/^image\//.test(mime)
      || ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'].includes(ext)) {
      const out = await extractImageOcr(buf, mime || `image/${ext.replace('.', '')}`);
      return { ...out, supported: true };
    }
    if (['.txt', '.md', '.markdown', '.html', '.htm', '.json', '.rtf'].includes(ext)
      || mime.startsWith('text/') || mime === 'application/json' || mime === 'application/rtf') {
      return { ...(await extractPlain(buf, ext || '.txt')), supported: true };
    }

    // Last resort: try officeparser, then utf8.
    try {
      const via = await extractViaOfficeParser(buf, mime);
      if (via.text) return { ...via, supported: true };
    } catch { /* ignore */ }
    const plain = await extractPlain(buf, ext || '.txt');
    if (plain.text) {
      return {
        ...plain,
        supported: false,
        warning: `Unrecognized type ${ext || mime || 'unknown'}; stored raw text best-effort`,
      };
    }
    return {
      text: '',
      extractor: 'none',
      supported: false,
      warning: `Unsupported type ${ext || mime || 'unknown'}. Supported: ${SUPPORTED_LABEL}`,
    };
  } catch (err) {
    return {
      text: '',
      extractor: 'error',
      supported: false,
      warning: `Extraction failed: ${err && err.message ? err.message : String(err)}`,
    };
  }
}

/**
 * Pick query-relevant windows from a long document for agent context.
 */
function searchWindows(text, query, { maxChars = 2400, windowSize = 900 } = {}) {
  const body = String(text || '');
  if (!body) return '';
  const q = String(query || '').trim().toLowerCase();
  if (!q) return body.slice(0, maxChars);
  const terms = q.split(/[^a-z0-9]+/i).filter((t) => t.length > 2);
  if (!terms.length) return body.slice(0, maxChars);

  const lower = body.toLowerCase();
  const hits = [];
  for (const term of terms) {
    let from = 0;
    while (from < lower.length) {
      const i = lower.indexOf(term, from);
      if (i < 0) break;
      hits.push(i);
      from = i + term.length;
      if (hits.length > 40) break;
    }
    if (hits.length > 40) break;
  }
  if (!hits.length) return body.slice(0, maxChars);

  const windows = [];
  const used = [];
  for (const hit of hits) {
    const start = Math.max(0, hit - Math.floor(windowSize / 3));
    const end = Math.min(body.length, start + windowSize);
    const overlaps = used.some(([a, b]) => !(end < a || start > b));
    if (overlaps) continue;
    used.push([start, end]);
    windows.push(body.slice(start, end).trim());
    const joined = windows.join('\n…\n');
    if (joined.length >= maxChars) break;
  }
  return windows.join('\n…\n').slice(0, maxChars);
}

function scoreText(text, query) {
  const body = String(text || '').toLowerCase();
  const terms = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  if (!terms.length || !body) return 0;
  let score = 0;
  for (const t of terms) {
    if (body.includes(t)) score += 1 + Math.min(3, (body.split(t).length - 1));
  }
  return score;
}

module.exports = {
  MAX_TEXT,
  isOcrInput,
  SUPPORTED_EXT,
  SUPPORTED_LABEL,
  extractKnowledgeText,
  searchWindows,
  scoreText,
  extOf,
  normalizeText,
};
