// File storage for attachments and profile photos (kept next to the database in data/uploads).
//
// Browsers tell us a file's type, but a browser can be lied to, so after multer has written the file we read
// its first bytes and decide the type ourselves (checkUploads). The stored name never comes from the user,
// and the extension is the canonical one for the detected type, so a ".png" is always really a PNG.
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const uploadDir = process.env.UPLOAD_DIR
  ? path.resolve(process.cwd(), process.env.UPLOAD_DIR)
  : path.resolve(path.dirname(process.env.DB_FILE ? path.resolve(process.cwd(), process.env.DB_FILE) : path.resolve(__dirname, '../data/x')), 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

/** Types we accept, with the extension(s) they are allowed to carry and how the browser may show them. */
export const FILE_TYPES = {
  'image/jpeg': { ext: ['jpg', 'jpeg'], inline: true, image: true },
  'image/png': { ext: ['png'], inline: true, image: true },
  'image/gif': { ext: ['gif'], inline: true, image: true },
  'image/webp': { ext: ['webp'], inline: true, image: true },
  'application/pdf': { ext: ['pdf'], inline: true },
  'application/msword': { ext: ['doc'] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: ['docx'] },
  'application/vnd.ms-excel': { ext: ['xls'] },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: ['xlsx'] },
  'application/vnd.ms-powerpoint': { ext: ['ppt'] },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { ext: ['pptx'] },
  'text/plain': { ext: ['txt'], text: true },
  'text/csv': { ext: ['csv'], text: true },
};
const IMAGE_TYPES = new Set(Object.keys(FILE_TYPES).filter((t) => FILE_TYPES[t].image));

const startsWith = (buf, bytes, offset = 0) => bytes.every((b, i) => buf[offset + i] === b);

/**
 * Looks at the first bytes of a file and returns the type family it really is:
 * 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'application/pdf' | 'zip' (docx/xlsx/pptx) | 'ole' (doc/xls/ppt) | 'text' | null
 */
export function sniff(buf) {
  if (!buf || buf.length < 4) return buf && buf.length > 0 && looksLikeText(buf) ? 'text' : null;
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  return looksLikeText(buf) ? 'text' : null;
}

/** True when the bytes are plausible text: no NUL bytes and valid UTF-8 (a BOM is fine). */
export function looksLikeText(buf) {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decides the real type of an uploaded file from its bytes + the name it was given.
 * Returns { mime, ext } or null when the file is not one of the allowed types (or the name lies about it).
 */
export function detectType(buf, originalName, { imagesOnly = false } = {}) {
  const family = sniff(buf);
  if (!family) return null;
  const nameExt = path
    .extname(originalName || '')
    .toLowerCase()
    .replace('.', '');
  if (family.startsWith('image/')) return { mime: family, ext: FILE_TYPES[family].ext[0] };
  if (imagesOnly) return null;
  if (family === 'application/pdf') return { mime: family, ext: 'pdf' };
  // Office files and text: the container tells us the family, the extension tells us which member.
  const candidates = family === 'zip' ? ['docx', 'xlsx', 'pptx'] : family === 'ole' ? ['doc', 'xls', 'ppt'] : ['txt', 'csv'];
  // Text is only accepted when the file was named as text: a '.png' full of text is a lie, not a text file.
  const ext = candidates.includes(nameExt) ? nameExt : null;
  if (!ext) return null;
  const mime = Object.keys(FILE_TYPES).find((t) => FILE_TYPES[t].ext.includes(ext));
  return mime ? { mime, ext } : null;
}

const storage = multer.diskStorage({
  destination: uploadDir,
  // Temporary name; checkUploads renames it with the extension of the detected type.
  filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.upload`),
});

const ALLOWED_DECLARED = new Set([...Object.keys(FILE_TYPES), 'application/octet-stream']);

/** Attachments: up to 5 files, 15 MB each. */
export const attachmentUpload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 5, fields: 50, fieldSize: 64 * 1024 },
  fileFilter: (req, file, cb) => (ALLOWED_DECLARED.has(file.mimetype) ? cb(null, true) : cb(new UploadError('File type not allowed (images, PDF, Office and text files only)'))),
});

/** Profile photos: 1 image, 5 MB. */
export const avatarUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 },
  fileFilter: (req, file, cb) => (IMAGE_TYPES.has(file.mimetype) ? cb(null, true) : cb(new UploadError('Profile photo must be a JPG, PNG, GIF or WebP image'))),
});

/** Spreadsheet import: 1 file, 5 MB, kept in memory. */
export const sheetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 } });

export class UploadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UploadError';
    this.status = 400;
  }
}

/**
 * Express middleware for after multer: verifies every stored file's real type, renames it to the canonical
 * extension and overwrites file.mimetype with what we detected. Rejects (and deletes) anything else.
 */
export function checkUploads({ imagesOnly = false } = {}) {
  return (req, res, next) => {
    const files = [...(req.files || []), ...(req.file ? [req.file] : [])];
    try {
      for (const f of files) {
        const fd = fs.openSync(f.path, 'r');
        const head = Buffer.alloc(64);
        let n = 0;
        try {
          n = fs.readSync(fd, head, 0, 64, 0);
        } finally {
          fs.closeSync(fd);
        }
        const type = detectType(head.subarray(0, n), f.originalname, { imagesOnly });
        if (!type)
          throw new UploadError(
            imagesOnly ? 'That file is not a JPG, PNG, GIF or WebP image' : `"${f.originalname}" is not an allowed file type (images, PDF, Office and text files only)`
          );
        const finalName = f.filename.replace(/\.upload$/, `.${type.ext}`);
        fs.renameSync(f.path, path.join(uploadDir, finalName));
        f.filename = finalName;
        f.path = path.join(uploadDir, finalName);
        f.mimetype = type.mime;
        f.originalname = safeOriginalName(f.originalname, type.ext);
      }
      next();
    } catch (err) {
      for (const f of files) removeStored(f.filename);
      next(err);
    }
  };
}

/** A display name that is safe to echo back: no path parts, no control characters, sensible length. */
export function safeOriginalName(name, ext) {
  /* eslint-disable no-control-regex */
  let base = path
    .basename(String(name || 'file'))
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '')
    .trim();
  if (!base) base = 'file';
  if (base.length > 120) base = base.slice(0, 120);
  if (!base.toLowerCase().endsWith(`.${ext}`)) base = `${base.replace(/\.[^.]*$/, '')}.${ext}`;
  return base;
}

/** Content-Disposition + type headers for serving a stored file. `inline` only for types browsers render safely. */
export function fileHeaders(res, { mime, filename, download = false }) {
  const info = FILE_TYPES[mime];
  const inline = !download && info?.inline;
  res.setHeader('Content-Type', info ? mime : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Cache-Control', 'private, max-age=300');
}

export function removeStored(storedName) {
  if (!storedName) return;
  try {
    fs.unlinkSync(path.join(uploadDir, path.basename(storedName)));
  } catch {
    /* already gone */
  }
}
