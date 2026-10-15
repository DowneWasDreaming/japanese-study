import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, CircleHelp, Clock3, LoaderCircle, MessageCircle, RefreshCw, Send, Sparkles, Trash2 } from 'lucide-react';
import { DiagnosticsLink } from './AIDiagnostics';

type Turn = {
  id: string; questionId: string; text: string; answer: string | null;
  status: 'queued' | 'pending' | 'completed' | 'failed'; error: string | null;
  clientRequestId: string; createdAt: string; updatedAt: string;
};
type Snapshot = { items: Turn[]; questionId: string; canAsk: boolean; limits: { maxText: number } };
type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Props = {
  examId: string; questionId: string; questionNumber: number; submitted: boolean;
  authorized: boolean; externalBusy: boolean; visible?: boolean; request: Request;
  onBusy: (questionId: string, busy: boolean) => void;
};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作没有完成，请查看错误详情后再试。';
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** Each question owns its state; mounted hidden panels keep requests and drafts attached to their original question. */
export function ExamDiscussion(props: Props) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [pollRevision, setPollRevision] = useState(0);
  const [pollPaused, setPollPaused] = useState(false);
  const active = useRef(true), sequence = useRef(0), polls = useRef(0);
  const operationRef = useRef<string | null>(null);
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const propsRef = useRef(props); propsRef.current = props;
  const draftRequest = useRef<{ text: string; id: string } | null>(null);
  const panelId = useId(), inputId = useId();
  const path = '/exams/' + encodeURIComponent(props.examId) + '/discussion';
  const items = snapshot?.items.filter(item => item.questionId === props.questionId) || [];
  const pending = items.some(item => item.status === 'pending');
  const locked = Boolean(operation) || pending;
  const maxText = snapshot?.limits.maxText || 4000;
  const canAsk = props.submitted || Boolean(snapshot?.canAsk);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; sequence.current++; propsRef.current.onBusy(propsRef.current.questionId, false); };
  }, []);
  useEffect(() => { props.onBusy(props.questionId, locked); }, [locked, props.onBusy, props.questionId]);

  const apply = useCallback((result: Snapshot) => {
    if (result.questionId !== propsRef.current.questionId) throw new Error('返回的问题与当前题目不一致，请刷新问答记录。');
    const current = { ...result, items: result.items.filter(item => item.questionId === propsRef.current.questionId) };
    snapshotRef.current = current; setSnapshot(current);
  }, []);
  const refresh = useCallback(async (restartPolling = false, preserveError = false) => {
    if (operationRef.current) return;
    if (restartPolling) { polls.current = 0; setPollPaused(false); }
    const version = ++sequence.current;
    setLoading(true);
    try {
      const result = await propsRef.current.request<Snapshot>(path + '?questionId=' + encodeURIComponent(propsRef.current.questionId));
      if (active.current && version === sequence.current) { apply(result); if (!preserveError) setError(''); }
    } catch (e) { if (active.current && version === sequence.current) setError(errorMessage(e)); }
    finally { if (active.current && version === sequence.current) { setLoading(false); setPollRevision(value => value + 1); } }
  }, [path, apply]);
  useEffect(() => { if (open) void refresh(true); }, [open, props.submitted, refresh]);
  useEffect(() => {
    if (!pending || operation || loading || pollPaused) return;
    if (polls.current >= 60) { setPollPaused(true); return; }
    const timer = window.setTimeout(() => { polls.current++; void refresh(); }, 2500);
    return () => clearTimeout(timer);
  }, [pending, operation, loading, pollPaused, pollRevision, refresh]);

  async function mutate(kind: 'send' | 'reply' | 'remove', turnId?: string) {
    if (operationRef.current || snapshotRef.current?.items.some(item => item.status === 'pending') || propsRef.current.externalBusy) return;
    const question = text.trim();
    if (kind === 'send' && (!question || question.length > maxText)) return;
    if (kind === 'send' && draftRequest.current?.text !== question) draftRequest.current = { text: question, id: crypto.randomUUID() };
    operationRef.current = kind === 'send' ? 'send' : kind + ':' + turnId;
    setOperation(operationRef.current); setError(''); sequence.current++;
    propsRef.current.onBusy(propsRef.current.questionId, true);
    polls.current = 0; setPollPaused(false);
    try {
      const result = await propsRef.current.request<Snapshot>(kind === 'send' ? path : path + '/' + encodeURIComponent(turnId || '') + (kind === 'reply' ? '/reply' : ''), kind === 'remove' ? 'DELETE' : 'POST', kind === 'send' ? { questionId: propsRef.current.questionId, text: question, clientRequestId: draftRequest.current!.id } : kind === 'reply' ? {} : undefined);
      if (!active.current) return;
      apply(result);
      if (kind === 'send') { setText(''); draftRequest.current = null; }
    } catch (e) {
      if (active.current) setError(errorMessage(e) + (kind === 'send' ? ' 输入已保留；再次发送同一问题会沿用原请求编号，避免重复保存。' : ''));
    } finally {
      operationRef.current = null;
      if (active.current) {
        setOperation(null); setLoading(false);
        propsRef.current.onBusy(propsRef.current.questionId, Boolean(snapshotRef.current?.items.some(item => item.status === 'pending')));
        // A disconnected POST may still be running on the server. Read its saved state; never repeat it automatically.
        void refresh(false, true);
      }
    }
  }
  function submit(event: FormEvent) { event.preventDefault(); void mutate('send'); }

  return <section className={'exam-discussion' + (open ? ' expanded' : '')} hidden={props.visible === false}>
    <button type="button" className="discussion-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
      <MessageCircle size={17} /><span><strong>直接提问 · 问 AI</strong><small>第 {props.questionNumber} 题 · {pending ? 'AI 正在回答' : items.length ? items.length + ' 条问答已保存' : '用自己的话描述疑问，也可以连续追问'}</small></span><ChevronDown size={16} />
    </button>
    {open && <div className="discussion-body" id={panelId}>
      <p className="discussion-context">当前讨论：第 {props.questionNumber} 题。AI 会结合本题题干、选项、材料及最近的同题问答，不必重新粘贴整道题。</p>
      {!canAsk && <div className="notice-box"><Clock3 size={16} /><span>先把疑问记下来。交卷前只保存问题，交卷后再手动请 AI 回答；练习中查看过反馈也需要先交卷。</span></div>}
      {canAsk && !props.authorized && <div className="notice-box"><CircleHelp size={16} /><span>需要先连接并授权 ChatGPT 才能回答，已保存的问题会保留。<a href="#settings">前往连接</a></span></div>}
      <div className="discussion-toolbar"><span>{loading ? <><LoaderCircle size={12} className="spin" />正在读取保存的问答…</> : '问题与回答随试卷保存在本机'}</span><button type="button" className="text-button" disabled={loading || Boolean(operation)} onClick={() => void refresh(true)}><RefreshCw size={12} />刷新记录</button></div>
      {error && <div className="discussion-error" role="alert"><strong>本次操作没有完成</strong><p>{error}</p><DiagnosticsLink examId={props.examId} operation="followup">查看问答失败的具体原因与时间</DiagnosticsLink></div>}
      <div className="discussion-turns">{items.map((turn, index) => <article className="discussion-turn" key={turn.id}>
        <div className="discussion-turn-meta"><span>我的提问 {index + 1}</span><time dateTime={turn.createdAt}>{time(turn.createdAt)}</time><button type="button" className="icon-button" disabled={locked || props.externalBusy} aria-label={'移除第 ' + (index + 1) + ' 条问答'} title="移除这条提问及回答" onClick={() => { if (window.confirm('移除这条提问和对应回答？其他问答保留。')) void mutate('remove', turn.id); }}><Trash2 size={13} /></button></div>
        <p className="discussion-question">{turn.text}</p>
        {turn.status === 'completed' && turn.answer && <div className="discussion-answer"><div><Sparkles size={14} /><strong>AI 回答</strong><time dateTime={turn.updatedAt}>{time(turn.updatedAt)}</time></div><div className="prose-text">{turn.answer}</div></div>}
        {turn.status === 'queued' && operation !== 'reply:' + turn.id && <div className="discussion-status"><Clock3 size={14} /><span>{canAsk ? '问题已保存，等待你请求回答。' : '问题已保存，交卷后可以请求回答。'}</span>{canAsk && <button type="button" className="button secondary small" disabled={locked || props.externalBusy} onClick={() => void mutate('reply', turn.id)}><Sparkles size={13} />请 AI 回答</button>}</div>}
        {(turn.status === 'pending' || operation === 'reply:' + turn.id) && <div className="discussion-status" role="status"><LoaderCircle size={14} className="spin" /><span>AI 正在回答。可以切题或离开页面，稍后返回查看。</span></div>}
        {turn.status === 'failed' && operation !== 'reply:' + turn.id && <div className="discussion-failure"><strong>回答未完成</strong><p>{turn.error || '未取得有效回答，请查看本卷 AI 失败记录。'}</p><small>发生时间：{time(turn.updatedAt)}</small><div><button type="button" className="button secondary small" disabled={locked || props.externalBusy || !canAsk} onClick={() => void mutate('reply', turn.id)}><RefreshCw size={13} />重试回答</button><DiagnosticsLink examId={props.examId} operation="followup">具体错误与每次失败记录</DiagnosticsLink></div></div>}
      </article>)}</div>
      {pollPaused && pending && <p className="small-muted" role="status">已暂停自动刷新。回答仍保存在后台，点击“刷新记录”查看进度；不会自动重复请求 AI。</p>}
      <form className="discussion-form" onSubmit={submit}>
        <label className="form-field" htmlFor={inputId}>{items.length ? '继续追问这道题' : '你想问什么？'}<textarea id={inputId} rows={3} value={text} onChange={event => setText(event.target.value)} maxLength={maxText} disabled={Boolean(operation)} placeholder="例如：为什么选项 B 在这里不合适？如果改成过去时，意思会怎样变化？" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void mutate('send'); } }} /></label>
        <div className="discussion-send"><span>{text.length} / {maxText} 字 · Ctrl / ⌘ + Enter</span><button type="submit" className="button primary small" disabled={locked || props.externalBusy || !text.trim() || text.trim().length > maxText}>{operation === 'send' ? <LoaderCircle size={14} className="spin" /> : canAsk ? <Send size={14} /> : <Clock3 size={14} />}{operation === 'send' ? canAsk ? '正在保存并回答…' : '正在保存…' : canAsk ? '发送问题' : '保存问题，交卷后回答'}</button></div>
        <p className="small-muted">{canAsk ? '每次发送或重试会请求 AI，使用当前授权的套餐额度。已有问题逐条手动回答。' : '保存问题不请求 AI，不消耗模型额度。交卷后不会自动批量回答。'}</p>
      </form>
    </div>}
  </section>;
}
