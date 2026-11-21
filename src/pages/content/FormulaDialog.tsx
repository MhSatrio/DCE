import { useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { FUNCTION_HELP, FormulaErr, numberText, syntaxProblem, type TableEvaluator, type Val } from '../../db/formula';
import type { FieldDef } from '../../db/schema';
import { copyText } from '../../ui/clipboard';
import { Dialog } from '../../ui/kit';

/**
 * The large formula editor: write a formula with the same syntax as a spreadsheet, see its result at once, and insert
 * columns and functions at the cursor. Opened from a formula cell or a currency cell (the expand button).
 */
export function FormulaDialog(props: {
  title: string;
  initial: string;
  currency?: string;
  recordId: string;
  evaluator: TableEvaluator;
  fields: FieldDef[];
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(props.initial);
  const ta = useRef<HTMLTextAreaElement>(null);
  const isFormula = text.trim().startsWith('=');
  const problem = isFormula ? syntaxProblem(text) : null;
  const result: Val = isFormula && !problem ? props.evaluator.evaluateFor(props.recordId, text) : null;

  /** Puts `snippet` where the cursor is (or at the end) and moves the cursor after it. */
  const insert = (snippet: string) => {
    const el = ta.current;
    const start = el?.selectionStart ?? text.length, end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + snippet + text.slice(end);
    setText(next.startsWith('=') || next.trim() === '' ? next : `=${next}`);
    setTimeout(() => { el?.focus(); el?.setSelectionRange(start + snippet.length, start + snippet.length); }, 0);
  };

  const shown = (v: Val): string => {
    if (v instanceof FormulaErr) return v.code;
    if (v === null) return '(empty)';
    if (typeof v === 'number') return props.currency ? `${props.currency}${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : numberText(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return Array.isArray(v) ? '(a range)' : String(v);
  };

  const save = () => { props.onSave(text.trim()); props.onClose(); };

  return (
    <Dialog title={props.title} onClose={props.onClose} size="wide" foot={<>
      <button className="btn" onClick={props.onClose}>Cancel</button>
      <button className="btn primary" onClick={save} disabled={!!problem}>Save</button>
    </>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 260px', gap: 14, alignItems: 'start' }}>
        <div className="col" style={{ gap: 10 }}>
          <label className="fld"><span>{props.currency !== undefined ? 'Amount (a number, or a formula that starts with =)' : 'Formula (starts with =)'}</span>
            <textarea ref={ta} aria-label="Formula" rows={8} value={text} autoFocus placeholder={props.currency !== undefined ? '1200  or  =[Qty]*1500' : '=[Price]*[Qty]'}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !problem) { e.preventDefault(); save(); } }}
              style={{ fontFamily: 'monospace', fontSize: 15, lineHeight: 1.5 }} />
          </label>
          <div className="row">
            <button className="btn sm" disabled={!isFormula} title={isFormula ? 'Copy the formula text, to paste it elsewhere' : 'Only a formula (starting with =) can be copied here'}
              onClick={() => void copyText(text.trim(), 'Formula copied.')}><Copy size={13} /> Copy formula</button>
          </div>
          <div className="panel" aria-label="Result" style={{ padding: '10px 12px' }}>
            <div className="small muted">Result for this row</div>
            {problem ? <div className="callout err" role="alert">{problem}</div>
              : <div style={{ fontSize: 20, fontWeight: 600, color: result instanceof FormulaErr ? 'var(--danger)' : undefined }} aria-label="Result value">{shown(result)}</div>}
          </div>
          <div className="small muted">
            <b>Cells.</b> <code>[Price]</code> is the value of the column Price in this row. <code>A1</code> is the first column (in field order) of the first row (in order of creation); <code>B3</code> the second column of the third row; <code>A1:A10</code> is a range. Text goes in <code>"double quotes"</code>; <code>&amp;</code> joins texts; <code>=</code>, <code>&lt;&gt;</code>, <code>&lt;</code>, <code>&gt;</code> compare.
          </div>
        </div>
        <div className="col" style={{ gap: 8, maxHeight: 420, overflow: 'auto' }}>
          <div className="small"><b>Insert a column</b></div>
          <div className="row wrap" style={{ gap: 4 }}>
            {props.fields.map((f) => (
              <button key={f.id} className="btn sm" aria-label={`Insert [${f.label}]`} onClick={() => insert(`[${f.label}]`)}>[{f.label}]</button>
            ))}
          </div>
          <div className="small"><b>Insert a function</b></div>
          <div className="col" style={{ gap: 3 }}>
            {FUNCTION_HELP.map((fn) => (
              <button key={fn.name} className="btn sm" style={{ justifyContent: 'flex-start', textAlign: 'left' }} title={fn.use} aria-label={`Insert ${fn.name}`} onClick={() => insert(`${fn.name}(`)}>
                <b>{fn.name}</b> <span className="muted small" style={{ marginLeft: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fn.use.split(' — ')[1] ?? fn.use}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
