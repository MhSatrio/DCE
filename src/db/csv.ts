/** RFC-4180 CSV parser/serialiser. Handles BOM, CRLF, quoted newlines, and ; or tab delimiters. */

export function detectDelimiter(text: string): string {
  const head = text.slice(0, 4000).split(/\r?\n/)[0] ?? '';
  const counts = [',', ';', '\t'].map((d) => ({ d, n: head.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ',';
}

export function parseCsv(input: string, delimiter?: string, keepEmptyRows = false): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const d = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === d) {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (keepEmptyRows || row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (keepEmptyRows || row.length > 1 || row[0] !== '') rows.push(row);
  }
  if (inQuotes) throw new Error('Unterminated quoted field — the file looks truncated or has a stray quote.');
  return rows;
}

const needsQuote = /[",\r\n]/;
export function toCsv(rows: unknown[][]): string {
  return rows
    .map((r) => r.map((v) => {
      let s = v === null || v === undefined ? '' : String(v);
      // neutralise the two unambiguous spreadsheet formula prefixes (a leading "-" is common in science: "-80 °C")
      if (/^[=@]/.test(s)) s = "'" + s;
      return needsQuote.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','))
    .join('\r\n');
}
