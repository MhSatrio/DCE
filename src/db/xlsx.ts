import { strToU8, zipSync } from 'fflate';

/** What a cell holds: text, a number, a date or a date and time (kept as such, so Excel sorts and calculates them). */
export type CellKind = 'text' | 'number' | 'date' | 'datetime';

const NUMBER = /^-?\d+(\.\d+)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const esc = (s: string) => s
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The column letters of a 1-based column number: 1 is A, 27 is AA. */
export function colName(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** The Excel serial number of a date (or a date and time) written as YYYY-MM-DD[THH:MM], or null when it is not one. */
export function excelSerial(text: string, kind: 'date' | 'datetime'): number | null {
  const m = DATE.exec(text.trim());
  if (!m) return null;
  const days = (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000;
  if (!Number.isFinite(days)) return null;
  if (kind === 'date') return days;
  return days + ((m[4] ? +m[4] : 0) * 60 + (m[5] ? +m[5] : 0)) / 1440;
}

const sheetName = (s: string): string => s.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet1';

const CONTENT_TYPES = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
const ROOT_RELS = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
const WORKBOOK_RELS = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
// cell styles: 0 plain, 1 bold header, 2 date, 3 date and time
const STYLES = '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/**
 * A workbook with one sheet. The first line is the header (bold, and it stays on screen while scrolling); the other lines
 * are the rows, in the order given. It is a plain .xlsx file (a zip of XML parts): Excel, LibreOffice and Google Sheets open it.
 */
export function toXlsx(lines: string[][], opts: { sheet: string; kinds?: CellKind[] }): Uint8Array {
  const rows: string[] = [];
  const widths: number[] = [];
  lines.forEach((line, r) => {
    const cells: string[] = [];
    line.forEach((text, c) => {
      const ref = `${colName(c + 1)}${r + 1}`;
      widths[c] = Math.max(widths[c] ?? 8, Math.min(60, text.length + 2));
      if (r === 0) { cells.push(`<c r="${ref}" s="1" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`); return; }
      if (text === '') return;
      const kind = opts.kinds?.[c] ?? 'text';
      if (kind === 'number' && NUMBER.test(text.trim())) { cells.push(`<c r="${ref}"><v>${Number(text.trim())}</v></c>`); return; }
      if (kind === 'date' || kind === 'datetime') {
        const v = excelSerial(text, kind);
        if (v !== null) { cells.push(`<c r="${ref}" s="${kind === 'date' ? 2 : 3}"><v>${v}</v></c>`); return; }
      }
      cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`);
    });
    rows.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  });
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const sheet = `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${rows.join('')}</sheetData></worksheet>`;
  const workbook = `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName(opts.sheet))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const parts: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(XML_HEAD + CONTENT_TYPES),
    '_rels/.rels': strToU8(XML_HEAD + ROOT_RELS),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(XML_HEAD + WORKBOOK_RELS),
    'xl/styles.xml': strToU8(XML_HEAD + STYLES),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  };
  return zipSync(parts, { level: 6 });
}
