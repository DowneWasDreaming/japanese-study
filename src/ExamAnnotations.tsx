import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { BookMarked, Check, CheckCircle2, CircleHelp, Clock3, Highlighter, LoaderCircle, Plus, RefreshCw, Sparkles, Trash2, X } from 'lucide-react';
import { findTextOccurrences, highlightTextSegments, validTextAnchor, type TextAnchor } from './annotation-ranges';
import { DiagnosticsLink } from './AIDiagnostics';
import { useReviewCapture } from './ReviewCapture';

export type AnnotationSource = 'prompt' | 'passage' | 'option';
export type AnnotationQuestion = { id: string; prompt: string; passage?: string; options?: { id: string; text: string }[] };
export type ExamAnnotation = {
  id: string; questionId: string; source: AnnotationSource; optionId?: string | null;
  start: number; end: number; text: string; status: 'marked' | 'pending' | 'completed' | 'failed';
  explanation: null | { reading: string; meaning: string; analysis: string; examples: { ja: string; zh: string }[]; tip: string };
  error?: string | null; createdAt: string; updatedAt: string;
};
type AnchorInput = TextAnchor & { questionId: string; source: AnnotationSource; optionId?: string };
type AnnotationSnapshot = { items: ExamAnnotation[]; canExplain: boolean; limits: { perExam: number; perQuestion: number; maxText: number }; created?: boolean };
type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Options = { examId: string; enabled: boolean; questions: AnnotationQuestion[]; submitted: boolean; authorized: boolean; externalBusy: boolean; request: Request; notify: (text: string) => void };
const defaults = { perExam: 40, perQuestion: 8, maxText: 500 };
const sourceNames: Record<AnnotationSource, string> = { prompt: '题干', passage: '阅读材料', option: '选项' };
const statusNames = { marked: '待解析', pending: '正在解析', completed: '已解析', failed: '解析未完成 · 可查看原因' };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '这次操作没有完成，请稍后重试。';

function questionSource(question: AnnotationQuestion | undefined, source: AnnotationSource, optionId?: string | null) {
  if (!question) return '';
  if (source === 'prompt') return question.prompt;
  if (source === 'passage') return question.passage || '';
  return question.options?.find(option => option.id === optionId)?.text || '';
}

function nearestSource(node: Node | null): HTMLElement | null {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement;
  return element?.closest<HTMLElement>('[data-mark-source]') || null;
}

export function useExamAnnotations(options: Options) {
  const optionsRef = useRef(options); optionsRef.current = options;
  const [snapshot, setSnapshot] = useState<AnnotationSnapshot>({ items: [], canExplain: false, limits: defaults });
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [operation, setOperation] = useState<'add' | 'remove' | 'explain' | null>(null);
  const operationRef = useRef<typeof operation>(null);
  const active = useRef(true), sequence = useRef(0), polls = useRef(0);
  const [pollRevision, setPollRevision] = useState(0);
  const [pollPaused, setPollPaused] = useState(false);
  const [selection, setSelection] = useState<AnchorInput | null>(null);
  const [selectionIssue, setSelectionIssue] = useState('');
  const [dialogQuestion, setDialogQuestion] = useState<string | null>(null);
  const pending = snapshot.items.some(item => item.status === 'pending');
  const explaining = operation === 'explain' || pending;
  const locked = operation !== null || pending;
  const path = '/exams/' + encodeURIComponent(options.examId) + '/annotations';
  const pendingNow = () => snapshotRef.current.items.some(item => item.status === 'pending');
  const isLocked = () => operationRef.current !== null || pendingNow();

  useEffect(() => { active.current = true; return () => { active.current = false; sequence.current++; }; }, []);
  const apply = useCallback((value: AnnotationSnapshot) => { snapshotRef.current = value; setSnapshot(value); }, []);
  const refresh = useCallback(async (restartPolling = false) => {
    if (operationRef.current || !optionsRef.current.enabled) return;
    if (restartPolling) { polls.current = 0; setPollPaused(false); }
    const version = ++sequence.current;
    setLoading(true);
    try {
      const result = await optionsRef.current.request<AnnotationSnapshot>(path);
      if (active.current && version === sequence.current) { apply(result); setError(''); }
    } catch (e) { if (active.current && version === sequence.current) setError(errorMessage(e)); }
    finally { if (active.current && version === sequence.current) { setLoading(false); setPollRevision(value => value + 1); } }
  }, [path, apply]);
  useEffect(() => { if (options.enabled) void refresh(); }, [options.enabled, refresh]);
  useEffect(() => {
    if (!pending || operation || loading || pollPaused) return;
    if (polls.current >= 60) { setPollPaused(true); return; }
    const timer = window.setTimeout(() => { polls.current++; void refresh(); }, 2500);
    return () => clearTimeout(timer);
  }, [pending, operation, loading, pollPaused, pollRevision, refresh]);

  useEffect(() => {
    const inspect = () => {
      if (operationRef.current || pendingNow() || optionsRef.current.externalBusy || dialogQuestion) { setSelection(null); return; }
      const selected = window.getSelection();
      if (!selected || selected.isCollapsed || selected.rangeCount !== 1) { setSelection(null); setSelectionIssue(''); return; }
      const range = selected.getRangeAt(0);
      const root = nearestSource(range.startContainer);
      if (!root || root !== nearestSource(range.endContainer) || root.dataset.markExam !== optionsRef.current.examId) { setSelection(null); return; }
      const source = root.dataset.markSource as AnnotationSource;
      const questionId = root.dataset.markQuestion || '';
      const optionId = root.dataset.markOption || undefined;
      const question = optionsRef.current.questions.find(item => item.id === questionId);
      const original = questionSource(question, source, optionId);
      if (root.textContent !== original) { setSelection(null); return; }
      try {
        const prefix = range.cloneRange(); prefix.selectNodeContents(root); prefix.setEnd(range.startContainer, range.startOffset);
        const start = prefix.toString().length;
        prefix.setEnd(range.endContainer, range.endOffset);
        const end = prefix.toString().length;
        const text = original.slice(start, end);
        const anchor = { questionId, source, ...(optionId ? { optionId } : {}), start, end, text };
        if (!validTextAnchor(original, anchor, snapshotRef.current.limits.maxText)) {
          setSelection(null); setSelectionIssue(text.length > snapshotRef.current.limits.maxText ? '每处最多标记 ' + snapshotRef.current.limits.maxText + ' 个字，请缩短选中的词句。' : '请选中同一段原文里的完整词句。'); return;
        }
        setSelection(anchor); setSelectionIssue('');
      } catch { setSelection(null); }
    };
    document.addEventListener('selectionchange', inspect);
    return () => document.removeEventListener('selectionchange', inspect);
  }, [dialogQuestion]);

  function syncSubmitted(items?: ExamAnnotation[]) {
    if (!active.current) return;
    sequence.current++;
    apply({ ...snapshotRef.current, ...(items ? { items } : {}), canExplain: true });
    setLoading(false);
  }

  async function add(anchor: AnchorInput) {
    if (isLocked() || optionsRef.current.externalBusy) return false;
    const question = optionsRef.current.questions.find(item => item.id === anchor.questionId);
    if (!validTextAnchor(questionSource(question, anchor.source, anchor.optionId), anchor, snapshotRef.current.limits.maxText)) { setError('请从这道题的原文中选择完整词句。'); return false; }
    operationRef.current = 'add'; setOperation('add'); setError(''); sequence.current++;
    try {
      const result = await optionsRef.current.request<AnnotationSnapshot>(path, 'POST', anchor);
      if (!active.current) return false;
      apply(result); setSelection(null); window.getSelection()?.removeAllRanges();
      optionsRef.current.notify(result.created === false ? '这一处已经在标记中。' : '已标记，交卷后可以一起解析。');
      return true;
    } catch (e) { if (active.current) setError(errorMessage(e)); return false; }
    finally { operationRef.current = null; if (active.current) { setOperation(null); setLoading(false); } }
  }
  async function remove(id: string) {
    if (isLocked() || optionsRef.current.externalBusy) return;
    operationRef.current = 'remove'; setOperation('remove'); setError(''); sequence.current++;
    try {
      const result = await optionsRef.current.request<AnnotationSnapshot>(path + '/' + encodeURIComponent(id), 'DELETE');
      if (active.current) { apply(result); optionsRef.current.notify('这一处标记已移除。'); }
    } catch (e) { if (active.current) setError(errorMessage(e)); }
    finally { operationRef.current = null; if (active.current) { setOperation(null); setLoading(false); } }
  }
  async function explain(retryFailedOnly = false, afterSubmit = false) {
    if (isLocked() || (!afterSubmit && optionsRef.current.externalBusy)) return false;
    if (!afterSubmit && !snapshotRef.current.canExplain) { setError('请先交卷，之后再解析标记的词句。'); return false; }
    if (!snapshotRef.current.items.some(item => retryFailedOnly ? item.status === 'failed' : item.status !== 'completed')) return true;
    if (!optionsRef.current.authorized) {
      if (active.current) { setError('标记已保留。请在连接与设置中授权 ChatGPT 套餐，再回来解析；试卷成绩不受影响。'); optionsRef.current.notify('标记已保留，授权 ChatGPT 后可以继续解析。'); }
      if (afterSubmit) await refresh();
      return false;
    }
    operationRef.current = 'explain'; setOperation('explain'); setError(''); setSelection(null); sequence.current++; polls.current = 0; setPollPaused(false);
    try {
      const result = await optionsRef.current.request<AnnotationSnapshot>(path + '/explain', 'POST', retryFailedOnly ? { retryFailedOnly: true } : {});
      if (!active.current) return false;
      apply(result);
      const failed = result.items.filter(item => item.status === 'failed').length;
      optionsRef.current.notify(failed ? '成绩已保存；有 ' + failed + ' 处词句解析待重试。' : '标记词句的解析已保存。');
      return !failed;
    } catch (e) { if (active.current) setError('词句解析未完成，成绩不受影响。' + errorMessage(e)); return false; }
    finally {
      operationRef.current = null;
      if (active.current) { setOperation(null); setLoading(false); void refresh(); }
    }
  }
  function openDialog(questionId?: string) { if (isLocked() || optionsRef.current.externalBusy) return; setSelection(null); setDialogQuestion(questionId || optionsRef.current.questions[0]?.id || ''); }
  return { ...snapshot, questions: options.questions, submitted: options.submitted, authorized: options.authorized, examId: options.examId,
    loading, error, operation, locked, explaining, pollPaused, selection, selectionIssue, dialogQuestion,
    disabled: locked || options.externalBusy, isLocked, add, remove, explain, refresh, syncSubmitted, openDialog, closeDialog: () => setDialogQuestion(null),
    dismissSelection: () => { setSelection(null); window.getSelection()?.removeAllRanges(); },
  };
}

type Controller = ReturnType<typeof useExamAnnotations>;
const AnnotationsContext = createContext<Controller | null>(null);
function useAnnotations() { const value = useContext(AnnotationsContext); if (!value) throw new Error('Missing annotations provider'); return value; }
export function AnnotationsProvider({ value, children }: { value: Controller; children: ReactNode }) {
  return <AnnotationsContext.Provider value={value}>{children}<SelectionToolbar />{value.dialogQuestion !== null && <AddAnnotationDialog />}</AnnotationsContext.Provider>;
}

/** A drag inside an option label must not activate its radio button. */
export function protectOptionTextSelection(event: MouseEvent<HTMLElement>) {
  if (event.target instanceof HTMLInputElement) return;
  const selected = window.getSelection();
  if (selected && !selected.isCollapsed && event.currentTarget.contains(selected.anchorNode) && event.currentTarget.contains(selected.focusNode)) {
    event.preventDefault(); event.stopPropagation();
  }
}

export function MarkableText({ questionId, source, optionId, text }: { questionId: string; source: AnnotationSource; optionId?: string; text: string }) {
  const context = useAnnotations();
  const items = context.items.filter(item => item.questionId === questionId && item.source === source && (item.optionId || undefined) === optionId);
  const segments = highlightTextSegments(text, items);
  return <span className="markable-text" data-mark-exam={context.examId} data-mark-question={questionId} data-mark-source={source} {...(optionId ? { 'data-mark-option': optionId } : {})}>{segments.map(segment => segment.ids.length ? <mark key={segment.start} className={'annotation-highlight' + (segment.ids.length > 1 ? ' overlapping' : '')} title={segment.ids.length > 1 ? '这里有 ' + segment.ids.length + ' 处标记' : '已标记，交卷后解析'}>{segment.text}</mark> : segment.text)}</span>;
}

function SelectionToolbar() {
  const context = useAnnotations();
  const { openCapture } = useReviewCapture();
  if (!context.selection || context.disabled || context.dialogQuestion !== null) return null;
  const count = context.items.filter(item => item.questionId === context.selection!.questionId).length;
  const full = context.items.length >= context.limits.perExam || count >= context.limits.perQuestion;
  return <div className="annotation-selection-toolbar" role="region" aria-label="标记选中的词句"><div><Highlighter size={17} /><span lang="ja">{context.selection.text}</span></div><button type="button" className="button primary small" onPointerDown={event => event.preventDefault()} disabled={full} onClick={() => void context.add(context.selection!)}><Plus size={14} />{full ? '标记数量已满' : '标记待解析'}</button><button type="button" className="button secondary small" onPointerDown={event => event.preventDefault()} onClick={() => { const anchor = context.selection!; context.dismissSelection(); openCapture({ examId: context.examId, ...anchor, submitted: context.submitted }); }}><BookMarked size={14} />加入重点复习</button><button className="icon-button" aria-label="取消选区" onPointerDown={event => event.preventDefault()} onClick={context.dismissSelection}><X size={17} /></button></div>;
}

export function AnnotationQuickAdd({ questionId }: { questionId: string }) {
  const context = useAnnotations();
  const count = context.items.filter(item => item.questionId === questionId).length;
  return <div className="annotation-quick-add"><span><Highlighter size={13} />选中词句，可解析或加入重点复习{count ? ' · 本题 ' + count + ' 处' : ''}</span><button type="button" className="text-button" disabled={context.disabled} onClick={() => context.openDialog(questionId)}><Plus size={13} />添加标记</button></div>;
}

export function ExamAnnotationsPanel({ currentQuestionId }: { currentQuestionId?: string }) {
  const context = useAnnotations();
  const unfinished = context.items.filter(item => item.status !== 'completed').length;
  const failed = context.items.filter(item => item.status === 'failed').length;
  const submitted = context.submitted && context.canExplain;
  return <section className="panel annotations-panel" aria-label="标记词句解析"><div className="section-heading"><div><h2><Highlighter size={17} />{submitted ? '标记词句解析' : '待解析词句'}<span className="annotation-count">{context.items.length} / {context.limits.perExam}</span></h2><p>{submitted ? '同一道题的多处标记一起解析，已完成的内容会保留。' : '先把没弄懂的词句记下来。交卷前只保存标记，不请求 AI。'}</p></div><button type="button" className="button secondary small" disabled={context.disabled || context.items.length >= context.limits.perExam} onClick={() => context.openDialog(currentQuestionId)}><Plus size={14} />添加标记</button></div><p className="small-muted">可标记题干、阅读材料与选项；每题最多 {context.limits.perQuestion} 处，每处最多 {context.limits.maxText} 字。手机或键盘可使用“添加标记”。</p>{context.selectionIssue && <p className="annotation-inline-warning" role="status">{context.selectionIssue}</p>}{context.loading && !context.items.length && <p className="small-muted annotation-loading"><LoaderCircle size={14} className="spin" />正在读取已保存的标记…</p>}{context.error && <div className="annotation-error" role="alert"><CircleHelp size={17} /><div><p>{context.error}</p><DiagnosticsLink examId={context.examId} operation="annotation" /><button className="text-button" disabled={context.locked} onClick={() => void context.refresh(true)}><RefreshCw size={12} />刷新标记</button>{!context.authorized && <a href="#settings" className="text-button">前往连接 ChatGPT</a>}</div></div>}{context.explaining && <div className="notice-box annotation-progress" role="status"><LoaderCircle size={16} className="spin" /><span>词句正在后台解析，成绩已保存。你可以先去其他页面，稍后回来查看；本次解析完成前暂时不能修改这些标记。{context.pollPaused && <>自动刷新已暂歇，可手动查看最新进度。<button className="text-button" disabled={context.operation !== null} onClick={() => void context.refresh(true)}>刷新进度</button></>}</span></div>}{submitted && unfinished > 0 && !context.explaining && <div className="annotation-actions"><button type="button" className="button primary small" disabled={context.disabled || !context.authorized} onClick={() => void context.explain()}><Sparkles size={14} />解析未完成的 {unfinished} 处</button>{failed > 0 && <button type="button" className="button secondary small" disabled={context.disabled || !context.authorized} onClick={() => void context.explain(true)}><RefreshCw size={14} />仅重试失败 {failed} 处</button>}{failed > 0 && <DiagnosticsLink examId={context.examId} operation="annotation">查看解析失败的原因与时间</DiagnosticsLink>}<p className="small-muted">会按题目请求 AI，使用已授权套餐额度。{!context.authorized && <a href="#settings">连接 ChatGPT 后继续解析</a>}</p></div>}{context.items.length > 0 && <details className="annotation-list-container" open={submitted || undefined}><summary>{submitted ? '查看词句与解析' : '查看已保存的标记'} · {context.items.length} 处</summary><div className="annotation-list">{context.items.map(item => <AnnotationCard key={item.id} item={item} showExplanation={submitted} />)}</div></details>}{!context.items.length && !context.loading && <p className="annotation-empty"><BookMarked size={17} />还没有标记。选中原文后点击“标记待解析”，或使用“添加标记”。</p>}</section>;
}

function AnnotationCard({ item, showExplanation }: { item: ExamAnnotation; showExplanation: boolean }) {
  const context = useAnnotations();
  const { openCapture } = useReviewCapture();
  const number = context.questions.findIndex(question => question.id === item.questionId) + 1;
  const explanation = showExplanation && item.status === 'completed' ? item.explanation : null;
  return <article className={'annotation-card status-' + item.status}><div className="annotation-card-top"><span>第 {number} 题 · {sourceNames[item.source]}{item.source === 'option' ? ' ' + (item.optionId || '').toUpperCase() : ''}</span><span>{showExplanation ? statusNames[item.status] : '交卷后解析'}</span><button type="button" className="icon-button delete-button" disabled={context.disabled} aria-label={'移除标记：' + item.text} onClick={() => void context.remove(item.id)}><Trash2 size={15} /></button></div><blockquote lang="ja">{item.text}</blockquote><button type="button" className="text-button annotation-to-review" disabled={context.disabled} onClick={() => openCapture({ examId: context.examId, questionId: item.questionId, source: item.source, optionId: item.optionId, start: item.start, end: item.end, text: item.text, submitted: context.submitted })}><BookMarked size={13} />加入重点复习</button>{explanation && <div className="annotation-explanation">{explanation.reading && <div><h4>读音</h4><p lang="ja">{explanation.reading}</p></div>}<div><h4>这里的意思</h4><p>{explanation.meaning}</p></div><div><h4>结合题目理解</h4><p>{explanation.analysis}</p></div>{explanation.examples.length > 0 && <div><h4>再看一个例子</h4>{explanation.examples.map((example, index) => <div className="annotation-example" key={index}><p lang="ja">{example.ja}</p><p>{example.zh}</p></div>)}</div>}{explanation.tip && <div><h4>记忆提示</h4><p>{explanation.tip}</p></div>}<span className="annotation-completed"><CheckCircle2 size={13} />AI 解析已保存在本机</span></div>}{showExplanation && item.status === 'failed' && <div className="annotation-failure-detail"><p className="annotation-inline-warning">{item.error || '这处解析没有完成，具体原因见失败记录。'} 成绩不受影响。</p><DiagnosticsLink examId={context.examId} operation="annotation">查看每次解析失败的详细记录</DiagnosticsLink></div>}{showExplanation && item.status === 'pending' && <p className="small-muted"><Clock3 size={13} />解析尚未完成，稍后可刷新查看。</p>}</article>;
}

export function SubmitAnnotationChoice({ checked, onChange, disabled }: { checked: boolean; onChange: (value: boolean) => void; disabled: boolean }) {
  const context = useAnnotations();
  if (!context.items.length) return null;
  const questions = new Set(context.items.filter(item => item.status !== 'completed').map(item => item.questionId)).size;
  return <div className="submit-annotation-choice"><label><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} disabled={disabled} /><span>交卷后解析标记的 {context.items.length} 处词句</span></label><p className="small-muted">评分结束后单独解析；同一道题的多处标记合并请求 AI，当前涉及 {questions} 道题，会使用套餐额度。解析失败不影响成绩。{!context.authorized && '尚未授权时先保留标记，连接后可再解析。'}</p></div>;
}

function AnnotationDialog({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null), closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; ref.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const nodes = ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]');
      if (!nodes?.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className="modal annotation-add-dialog" role="dialog" aria-modal="true" aria-label="添加词句标记" ref={ref} tabIndex={-1}><div className="modal-header"><span>添加词句标记</span><button className="icon-button" aria-label="关闭添加标记" onClick={onClose}><X size={19} /></button></div><div className="modal-content">{children}</div></div></div>;
}

function AddAnnotationDialog() {
  const context = useAnnotations();
  const { openCapture } = useReviewCapture();
  const [questionId, setQuestionId] = useState(context.dialogQuestion || context.questions[0]?.id || '');
  const [sourceKey, setSourceKey] = useState('prompt');
  const [text, setText] = useState('');
  const [selectedStart, setSelectedStart] = useState<number | null>(null);
  const question = context.questions.find(item => item.id === questionId);
  const source: AnnotationSource = sourceKey.startsWith('option:') ? 'option' : sourceKey === 'passage' ? 'passage' : 'prompt';
  const optionId = source === 'option' ? sourceKey.slice(7) : undefined;
  const original = questionSource(question, source, optionId);
  const matches = useMemo(() => findTextOccurrences(original, text), [original, text]);
  useEffect(() => { setSelectedStart(matches.length === 1 ? matches[0].start : null); }, [matches]);
  const chosen = matches.find(match => match.start === selectedStart);
  const full = context.items.length >= context.limits.perExam || context.items.filter(item => item.questionId === questionId).length >= context.limits.perQuestion;
  const preview = highlightTextSegments(original, chosen ? [{ id: 'preview', ...chosen }] : []);
  async function submit() {
    if (!chosen || context.disabled || full) return;
    const saved = await context.add({ questionId, source, ...(optionId ? { optionId } : {}), ...chosen });
    if (saved) context.closeDialog();
  }
  return <AnnotationDialog onClose={() => { if (!context.operation) context.closeDialog(); }}><h2 className="confirm-title">把想弄懂的原文记下来</h2><p className="small-muted annotation-dialog-intro">选择题目和原文位置，再输入或粘贴需要解析的词句。出现多次时，请选择你想标记的具体一处。</p><label className="form-field">题目<select value={questionId} disabled={context.disabled} onChange={event => { setQuestionId(event.target.value); setSourceKey('prompt'); setText(''); }}>{context.questions.map((item, index) => <option value={item.id} key={item.id}>第 {index + 1} 题 · {item.prompt.slice(0, 45)}</option>)}</select></label><label className="form-field">原文位置<select value={sourceKey} disabled={context.disabled} onChange={event => { setSourceKey(event.target.value); setText(''); }}><option value="prompt">题干</option>{question?.passage && <option value="passage">阅读材料</option>}{question?.options?.map(option => <option value={'option:' + option.id} key={option.id}>选项 {option.id.toUpperCase()} · {option.text.slice(0, 40)}</option>)}</select></label><div className="annotation-source-preview" lang="ja" aria-label="原文预览">{preview.map(segment => segment.ids.length ? <mark className="annotation-highlight" key={segment.start}>{segment.text}</mark> : segment.text)}</div><label className="form-field">要标记的原文片段<textarea value={text} onChange={event => setText(event.target.value)} maxLength={context.limits.maxText} rows={2} placeholder="请输入原文中的词或句子…" disabled={context.disabled} /></label>{text && !matches.length && <p className="annotation-inline-warning" role="status">没有在这段原文中找到完全相同的片段，请核对文字与空格。</p>}{matches.length > 1 && <label className="form-field">找到 {matches.length} 处相同片段，请选择具体位置<select value={selectedStart === null ? '' : String(selectedStart)} disabled={context.disabled} onChange={event => setSelectedStart(event.target.value === '' ? null : Number(event.target.value))}><option value="">请选择要标记的那一处</option>{matches.map((match, index) => <option key={match.start} value={match.start}>第 {index + 1} 处：{original.slice(Math.max(0, match.start - 12), match.start)}【{match.text.slice(0, 50)}】{original.slice(match.end, match.end + 12)}</option>)}</select></label>}{matches.length === 1 && <p className="small-muted"><Check size={13} />已找到这一处原文，保存后会在题目中高亮。</p>}{full && <p className="annotation-inline-warning">本题或本卷的标记数量已满，请先移除不需要的标记。</p>}{context.error && <p className="annotation-inline-warning" role="alert">{context.error}</p>}<div className="detail-actions"><button type="button" className="button secondary" disabled={context.operation !== null} onClick={context.closeDialog}>取消</button><button type="button" className="button secondary" disabled={!chosen || context.disabled} onClick={() => { const anchor = chosen!; context.closeDialog(); openCapture({ examId: context.examId, questionId, source, ...(optionId ? { optionId } : {}), ...anchor, submitted: context.submitted }); }}><BookMarked size={15} />加入重点复习</button><button type="button" className="button primary" disabled={!chosen || context.disabled || full} onClick={() => void submit()}>{context.operation === 'add' ? <LoaderCircle size={15} className="spin" /> : <Highlighter size={15} />}保存标记</button></div></AnnotationDialog>;
}
