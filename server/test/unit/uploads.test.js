import { describe, it, expect, beforeAll } from 'vitest';

// uploads.js creates the upload folder on import: point it at a temp dir first.
process.env.UPLOAD_DIR = `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/upnotice-test-uploads-${process.pid}`;
let mod;
beforeAll(async () => {
  mod = await import('../../src/uploads.js');
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const GIF = Buffer.from('GIF89a', 'ascii');
const WEBP = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'ascii')]);
const PDF = Buffer.from('%PDF-1.7\n', 'ascii');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const TEXT = Buffer.from('Name,Email\nJuan,juan@x.com\n', 'utf8');
const SVG = Buffer.from('<svg onload="alert(1)"></svg>', 'utf8');
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

describe('sniff', () => {
  it('recognises image, pdf and office containers by their bytes', () => {
    expect(mod.sniff(PNG)).toBe('image/png');
    expect(mod.sniff(JPEG)).toBe('image/jpeg');
    expect(mod.sniff(GIF)).toBe('image/gif');
    expect(mod.sniff(WEBP)).toBe('image/webp');
    expect(mod.sniff(PDF)).toBe('application/pdf');
    expect(mod.sniff(ZIP)).toBe('zip');
    expect(mod.sniff(OLE)).toBe('ole');
  });
  it('treats valid UTF-8 without NUL bytes as text, anything else as unknown', () => {
    expect(mod.sniff(TEXT)).toBe('text');
    expect(mod.sniff(SVG)).toBe('text');
    expect(mod.sniff(EXE)).toBeNull();
    expect(mod.sniff(Buffer.from([0xff, 0xfe, 0x00, 0x41]))).toBeNull();
  });
});

describe('detectType', () => {
  it('uses the bytes, not the declared name, for images', () => {
    expect(mod.detectType(PNG, 'photo.jpg')).toEqual({ mime: 'image/png', ext: 'png' });
    expect(mod.detectType(JPEG, 'whatever.bin')).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
  });
  it('rejects text pretending to be an image, and SVG everywhere', () => {
    expect(mod.detectType(SVG, 'evil.png')).toBeNull();
    expect(mod.detectType(SVG, 'evil.svg')).toBeNull();
    expect(mod.detectType(SVG, 'evil.svg', { imagesOnly: true })).toBeNull();
    expect(mod.detectType(TEXT, 'notes.png')).toBeNull();
  });
  it('only accepts images when imagesOnly is set', () => {
    expect(mod.detectType(PDF, 'a.pdf', { imagesOnly: true })).toBeNull();
    expect(mod.detectType(PNG, 'a.png', { imagesOnly: true })).toEqual({ mime: 'image/png', ext: 'png' });
  });
  it('resolves office containers by extension and rejects mismatches', () => {
    expect(mod.detectType(ZIP, 'report.xlsx')).toEqual({ mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' });
    expect(mod.detectType(ZIP, 'memo.docx').ext).toBe('docx');
    expect(mod.detectType(OLE, 'old.doc').ext).toBe('doc');
    expect(mod.detectType(ZIP, 'archive.zip')).toBeNull(); // a plain zip is not allowed
    expect(mod.detectType(ZIP, 'old.doc')).toBeNull(); // wrong container for the extension
  });
  it('accepts text only under a text extension', () => {
    expect(mod.detectType(TEXT, 'people.csv')).toEqual({ mime: 'text/csv', ext: 'csv' });
    expect(mod.detectType(TEXT, 'notes.txt').mime).toBe('text/plain');
    expect(mod.detectType(TEXT, 'script.html')).toBeNull();
    expect(mod.detectType(EXE, 'setup.exe')).toBeNull();
  });
});

describe('safeOriginalName', () => {
  it('strips paths and control characters and forces the real extension', () => {
    expect(mod.safeOriginalName('../../etc/passwd', 'txt')).toBe('passwd.txt');
    expect(mod.safeOriginalName('C:\\Users\\x\\memo.docx', 'docx')).toBe('memo.docx');
    expect(mod.safeOriginalName('bad\u0000name\u001f.png', 'png')).toBe('badname.png');
    expect(mod.safeOriginalName('photo.jpg', 'png')).toBe('photo.png');
    expect(mod.safeOriginalName('', 'pdf')).toBe('file.pdf');
    expect(mod.safeOriginalName('x'.repeat(300) + '.pdf', 'pdf').length).toBeLessThanOrEqual(124);
  });
});
