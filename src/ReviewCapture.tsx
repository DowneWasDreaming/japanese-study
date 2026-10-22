import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BookMarked, CheckCircle2, LoaderCircle, X } from 'lucide-react';

export type ReviewRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export type ReviewCaptureInput = { examId?: string; questionId?: string; source?: 'prompt' | 'passage' | 'option'; optionId?: string | null; start?: number; end?: number; text?: string; level?: string; submitted?: boolean };
const CaptureContext = createContext<{ openCapture: (input?: ReviewCaptureInput) => void }>({ openCapture: () => {} });
export const useReviewCapture = () => useContext(CaptureContext);
export const reviewChanged = () => window.dispatchEvent(new Event('review-points-changed'));

export function ReviewDialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null), closeRef = useRef(onClose), busyRef = useRef(busy); closeRef.current = onClose; busyRef.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; ref.current?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { event.stopPropagation(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const elements = ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]');
      if (!elements?.length) { event.preventDefault(); return; }
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handle);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', handle); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div className="modal review-dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}><div className="modal-header"><span>{title}</span><button className="icon-button" aria-label={'关闭' + title} disabled={busy} onClick={onClose}><X size={19} /></button></div><div className="modal-content">{children}</div></div></div>;
}

export function ReviewCaptureProvider({ children, request, notify }: { children: ReactNode; request: ReviewRequest; notify: (text: string) => void }) {
  const [input, setInput] = useState<ReviewCaptureInput | null>(null);
  return <CaptureContext.Provider value={{ openCapture: (value = {}) => { window.getSelection()?.removeAllRanges(); setInput(value); } }}>{children}{input && <CaptureDialog key={[input.examId, input.questionId, input.source, input.optionId, input.start, input.end].join(':')} input={input} request={request} notify={notify} onClose={() => setInput(null)} />}</CaptureContext.Provider>;
}

function CaptureDialog({ input, request, notify, onClose }: { input: ReviewCaptureInput; request: ReviewRequest; notify: (text: string) => void; onClose: () => void }) {
  const [text, setText] = useState(input.text || ''), [level, setLevel] = useState(input.level || 'N5');
  const [scope, setScope] = useState<'broad' | 'context'>('broad'), [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(true), sending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (sending.current || !text.trim()) return;
    sending.current = true; setBusy(true); setError('');
    try {
      await request('/review/points', 'POST', { ...(input.examId ? { examId: input.examId, questionId: input.questionId, source: input.source, ...(input.optionId ? { optionId: input.optionId } : {}), start: input.start, end: input.end } : { level }), text: input.examId ? input.text : text.trim(), scope, intent: intent.trim() });
      reviewChanged(); if (active.current) { notify('已保存到重点复习待整理，AI 整理成功后会直接加入复习安排。'); onClose(); }
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : '保存重点复习未完成，原文仍保留。'); }
    finally { sending.current = false; if (active.current) setBusy(false); }
  }
  return <ReviewDialog title="加入重点复习" busy={busy} onClose={onClose}><form onSubmit={event => void submit(event)}><div className="review-capture-intro"><BookMarked size={26} /><h2>记住一个知识点，不只记住题目</h2></div><p className="prose-text">先保存原文和想学的范围，之后再整理成可复习的单词、语法或表达。例如「済んで」可以整理为「済む」的整体用法。</p><label className="form-field">{input.examId ? '选中的原文' : '要复习的词句'}<textarea value={text} onChange={event => setText(event.target.value)} readOnly={Boolean(input.examId)} disabled={busy} rows={2} maxLength={500} required placeholder="例如：しまう、済んで…" lang="ja" /></label>{!input.examId && <label className="form-field">学习等级<select value={level} onChange={event => setLevel(event.target.value)} disabled={busy}>{['KANA', 'N5', 'N4', 'N3', 'N2', 'N1'].map(value => <option key={value} value={value}>{value === 'KANA' ? '五十音' : value}</option>)}</select></label>}<fieldset className="review-scope-choices"><legend>想复习的范围</legend><label><input type="radio" name="review-scope" value="broad" checked={scope === 'broad'} disabled={busy} onChange={() => setScope('broad')} /><span><strong>整体用法</strong><small>原形、含义、常用搭配及相关用法，默认推荐。</small></span></label><label><input type="radio" name="review-scope" value="context" checked={scope === 'context'} disabled={busy} onChange={() => setScope('context')} /><span><strong>只复习此处用法</strong><small>聚焦这句话中的形式、接续或语法意义。</small></span></label></fieldset><label className="form-field">补充想学什么 <span className="optional">可选</span><textarea value={intent} onChange={event => setIntent(event.target.value)} disabled={busy} rows={2} maxLength={1200} placeholder="例如：想了解这个动词的常用搭配，不只是这里的て形。" /></label><div className="notice-box"><CheckCircle2 size={16} /><span>这一步只保存在本机，不请求 AI。来自未交卷题目的内容，交卷后才能让 AI 整理。AI 整理成功后直接加入复习安排，以后可单独编辑。</span></div>{error && <div className="error-box" role="alert"><p>{error}</p></div>}<div className="detail-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={busy || !text.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <BookMarked size={15} />}{busy ? '正在保存…' : '保存到待整理'}</button></div></form></ReviewDialog>;
}
