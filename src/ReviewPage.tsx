import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, BookMarked, Check, CheckCircle2, Clock3, Edit3, LoaderCircle, Pause, Play, Plus, RefreshCw, Search, Sparkles, Trash2, X } from 'lucide-react';
import { DiagnosticsLink } from './AIDiagnostics';
import { ReviewBatch } from './ReviewBatch';
import { ReviewDialog, reviewChanged, useReviewCapture, type ReviewRequest } from './ReviewCapture';

export type ReviewFrozenPoint = { id: string; title: string; kind: string; scope: string; focus: string; reading?: string; meaning?: string };
type Candidate = { title: string; kind: 'word' | 'grammar' | 'expression'; reading: string; meaning: string; focus: string; note: string };
export type ReviewPoint = Candidate & {
  id: string; level: string; scope: 'broad' | 'context'; status: 'draft' | 'active' | 'mastered' | 'paused';
  stage: number; dueAt: string | null; lastReviewedAt: string | null; repetitions: number; lapses: number; weight: number;
  normalizationStatus: 'none' | 'pending' | 'completed' | 'failed'; candidate: Candidate | null; error: string | null; canNormalize: boolean;
  createdAt: string; updatedAt: string;
  sources: { id: string; examId: string | null; questionId: string; source: string; optionId: string; start: number; end: number; text: string; context: string; questionPrompt: string }[];
};
type List = { items: ReviewPoint[]; summary: { total: number; draft: number; active: number; mastered: number; paused: number; due: number }; total: number; page: number; pages: number; pageSize: number };
type Status = 'due' | 'draft' | 'active' | 'mastered' | 'paused' | 'all';
const statusChoices: { id: Status; name: string }[] = [{ id: 'due', name: '到期复习' }, { id: 'draft', name: '待整理' }, { id: 'active', name: '复习中' }, { id: 'mastered', name: '已掌握' }, { id: 'paused', name: '已暂停' }, { id: 'all', name: '全部' }];
const names = { word: '单词', grammar: '语法', expression: '表达' };
const types = { single: '单项选择', fill: '填写答案', reading: '阅读理解', 'zh-ja': '中译日', 'ja-zh': '日译中', sentence: '语法造句' };
const counts = [1, 3, 5, 10, 15, 20, 25, 30, 40];
const levels = ['KANA', 'N5', 'N4', 'N3', 'N2', 'N1'];
const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请查看具体原因。';
const levelName = (level: string) => level === 'KANA' ? '五十音' : level;
export function reviewTime(value: string | null) { return value ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }).format(new Date(value)) : '不自动安排'; }

export function ReviewReading({ reading, note, onEdit }: { reading?: string; note?: string; onEdit?: () => void }) {
  const [visible, setVisible] = useState(true);
  return <div className={'review-reading' + (reading ? '' : ' missing')}><div className="review-reading-line"><span className="review-reading-label">读法：</span>{reading ? <><span className="review-reading-value" lang="ja">{visible ? reading : '已遮住，试着自己读一遍'}</span><button type="button" className="text-button" aria-expanded={visible} onClick={() => setVisible(value => !value)}>{visible ? '遮住读法' : '显示读法'}</button></> : <><span className="small-muted">暂未填写</span>{onEdit && <button type="button" className="text-button" onClick={onEdit}>补充读法</button>}</>}</div>{note && reading && <small className="small-muted">{note}</small>}</div>;
}

export function ReviewRatingActions({ point, request, examId, disabled = false, onUpdated }: { point: ReviewPoint; request: ReviewRequest; examId?: string; disabled?: boolean; onUpdated: (point: ReviewPoint) => void }) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const pending = useRef<{ rating: string; id: string } | null>(null), sending = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function rate(rating: string) {
    if (sending.current || disabled) return;
    if (pending.current?.rating !== rating) pending.current = { rating, id: crypto.randomUUID() };
    sending.current = true; setBusy(rating); setError('');
    try {
      const response = await request<{ item: ReviewPoint }>('/review/points/' + encodeURIComponent(point.id) + '/rate', 'POST', { rating, requestId: pending.current!.id, ...(examId ? { examId } : {}) });
      pending.current = null; reviewChanged(); if (active.current) onUpdated(response.item);
    } catch (cause) { if (active.current) setError(message(cause)); }
    finally { sending.current = false; if (active.current) setBusy(''); }
  }
  return <div className="review-ratings"><div className="review-rating-buttons">{[{ id: 'again', name: '不会', help: '缩短间隔，稍后再复习' }, { id: 'hard', name: '模糊', help: '降低阶段，明天再看' }, { id: 'good', name: '会了', help: '逐步延长复习间隔' }, { id: 'mastered', name: '已掌握', help: '停止自动安排，仍可手动选择' }].map(choice => <button type="button" key={choice.id} className={'button secondary small rating-' + choice.id} title={choice.help} disabled={disabled || Boolean(busy) || point.status === 'draft' || point.status === 'paused'} onClick={() => void rate(choice.id)}>{busy === choice.id ? <LoaderCircle size={13} className="spin" /> : choice.id === 'mastered' ? <CheckCircle2 size={13} /> : null}{choice.name}</button>)}</div>{error && <p className="review-inline-error" role="alert">{error}</p>}</div>;
}

export function ReviewPage({ route, request, authorized, notify }: { route: string; request: ReviewRequest; authorized: boolean; notify: (text: string) => void }) {
  const query = new URLSearchParams(route.split('?')[1] || '');
  const [status, setStatus] = useState<Status>(statusChoices.some(item => item.id === query.get('status')) ? query.get('status') as Status : 'due');
  const [level, setLevel] = useState(levels.includes(query.get('level') || '') ? query.get('level')! : 'all'), [search, setSearch] = useState(''), [page, setPage] = useState(1), [revision, setRevision] = useState(0);
  const [data, setData] = useState<List | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const [editor, setEditor] = useState<ReviewPoint | null>(null), [selected, setSelected] = useState<Record<string, ReviewPoint>>({});
  const [receipt, setReceipt] = useState(''), [batchBusy, setBatchBusy] = useState(true);
  const locked = Boolean(busy) || batchBusy;
  const { openCapture } = useReviewCapture();
  const active = useRef(true), operation = useRef(false), polls = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => { const changed = () => reload(); window.addEventListener('review-points-changed', changed); return () => window.removeEventListener('review-points-changed', changed); }, [reload]);
  useEffect(() => {
    let current = true; setLoading(true); setError('');
    const params = new URLSearchParams({ status, page: String(page), pageSize: '50', ...(level === 'all' ? {} : { level }), ...(search.trim() ? { q: search.trim() } : {}) });
    void request<List>('/review/points?' + params).then(value => { if (current) setData(value); }).catch(cause => { if (current) setError(message(cause)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [status, level, search, page, revision, request]);
  useEffect(() => {
    if (busy || loading || !data?.items.some(item => item.normalizationStatus === 'pending') || polls.current >= 60) return;
    const timer = window.setTimeout(() => { polls.current++; reload(); }, 3000); return () => clearTimeout(timer);
  }, [data, busy, loading, reload]);
  async function act(point: ReviewPoint, action: 'normalize' | 'pause' | 'resume' | 'delete') {
    if (operation.current || batchBusy) return;
    if (action === 'delete' && !window.confirm('移除知识点「' + point.title + '」及它的来源和复习记录？已保存的试卷仍保留。')) return;
    operation.current = true; setBusy(point.id + ':' + action); setError('');
    try {
      const path = '/review/points/' + encodeURIComponent(point.id);
      if (action === 'delete') { const result = await request<{ beforeDeleteBackup?: string }>(path, 'DELETE'); if (active.current) { setSelected(value => { const next = { ...value }; delete next[point.id]; return next; }); setReceipt(result.beforeDeleteBackup || ''); notify('这个重点复习知识点已移除，删除前备份已保存。'); } }
      else if (action === 'normalize') {
        const result = await request<{ item: ReviewPoint; merged?: boolean }>(path + '/normalize', 'POST', {});
        if (active.current) {
          if (result.item.status !== 'draft') notify(result.merged ? '已合并到已有知识点，原有复习进度保留。' : '知识点已整理并加入复习安排，可以开始复习。');
          else if (result.item.normalizationStatus === 'failed') notify('AI 整理未完成，原文仍在，可查看失败原因后重试。');
        }
      } else { await request(path, 'PUT', { status: action === 'pause' ? 'paused' : 'active' }); if (active.current && action === 'pause') setSelected(value => { const next = { ...value }; delete next[point.id]; return next; }); }
      if (active.current) { polls.current = 0; reviewChanged(); }
    } catch (cause) { if (active.current) setError(message(cause)); }
    finally { operation.current = false; if (active.current) setBusy(''); }
  }
  function choose(point: ReviewPoint, checked: boolean) {
    if (locked) return;
    const chosen = Object.values(selected);
    if (checked && chosen.some(item => item.level !== point.level)) { notify('一份复习卷使用同一等级，请先取消其他等级的选择。'); return; }
    if (checked && chosen.length >= 40) { notify('每份复习卷最多选择 40 个知识点。'); return; }
    setSelected(value => { const next = { ...value }; if (checked) next[point.id] = point; else delete next[point.id]; return next; });
  }
  return <><div className="page-heading"><div><div className="eyebrow">KEEP WHAT YOU WANT TO REMEMBER</div><h1>重点复习<span className="heading-dot">。</span></h1><p>从题干、材料和选项中积累词句和读法，按掌握情况安排下一次复习。</p></div><button className="button secondary small" disabled={locked} onClick={() => openCapture({ level: level === 'all' ? 'N5' : level })}><Plus size={15} />手动添加知识点</button></div>
    <div className="notice-box review-how"><BookMarked size={20} /><div><strong>原文标记 → AI 整理并加入安排 → AI 复习卷 → 自评掌握情况</strong><p>「済んで」可以整理为「済む」的整体用法，也可以只学本句的形式。AI 整理成功后直接加入复习，发现需要调整时再编辑那一条。复习间隔按“不会／模糊／会了”调整，选择“已掌握”后停止自动安排。</p></div></div>
    <ReviewBatch request={request} authorized={authorized} disabled={Boolean(busy) || Boolean(editor)} onBusyChange={setBatchBusy} onProgress={reload} />
    {data && <div className="review-summary-tabs">{statusChoices.slice(0, 5).map(choice => <button type="button" key={choice.id} className={status === choice.id ? 'selected' : ''} onClick={() => { setStatus(choice.id); setPage(1); }}><span>{choice.name}</span><strong>{data.summary[choice.id as keyof List['summary']] ?? 0}</strong></button>)}</div>}
    <div className="review-layout"><section className="review-main"><div className="panel review-filter-panel"><div className="form-two-col"><label className="form-field">查看范围<select value={status} onChange={event => { setStatus(event.target.value as Status); setPage(1); }}>{statusChoices.map(choice => <option key={choice.id} value={choice.id}>{choice.name}</option>)}</select></label><label className="form-field">知识点等级<select value={level} onChange={event => { setLevel(event.target.value); setPage(1); }}><option value="all">全部等级</option>{levels.map(value => <option key={value} value={value}>{levelName(value)}</option>)}</select></label></div><label className="search-field"><Search size={16} /><input aria-label="搜索复习知识点" maxLength={200} value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="搜索知识点、含义或复习重点…" /></label><button type="button" className="text-button" disabled={loading || locked} onClick={() => { polls.current = 0; reload(); }}><RefreshCw size={13} />刷新知识点</button></div>
      {error && <div className="error-box" role="alert"><div><strong>操作没有完成</strong><p>{error}</p><DiagnosticsLink operation="review">查看 AI 整理失败记录</DiagnosticsLink></div></div>}
      {loading && !data ? <div className="state-box"><LoaderCircle size={23} className="spin" /><p>正在读取重点复习…</p></div> : data && <>{loading && <p className="small-muted review-loading">正在更新列表…</p>}{data.items.length ? <div className="review-point-list">{data.items.map(point => <article className={'panel review-point status-' + point.status} key={point.id}><div className="review-point-meta"><span className="pill">{levelName(point.level)}</span><span className="pill">{names[point.kind]}</span><span className="pill">{point.scope === 'broad' ? '整体用法' : '本处用法'}</span><span className="review-point-status">{point.status === 'draft' ? '待整理知识点' : point.status === 'mastered' ? '已掌握 · 不自动安排' : point.status === 'paused' ? '已暂停' : '复习阶段 ' + point.stage}</span></div><div className="review-point-heading"><h2 lang="ja">{point.title}</h2>{(point.status === 'active' || point.status === 'mastered') && <label className="review-select"><input type="checkbox" checked={Boolean(selected[point.id])} onChange={event => choose(point, event.target.checked)} disabled={locked} /><span>选入复习卷</span></label>}</div><ReviewReading reading={point.reading} onEdit={locked ? undefined : () => setEditor(point)} />{point.meaning && <p className="review-meaning">{point.meaning}</p>}{point.focus && <p className="review-focus"><strong>复习重点：</strong>{point.focus}</p>}{point.note && <details className="review-note"><summary>学习笔记</summary><p className="prose-text">{point.note}</p></details>}{point.sources?.length > 0 && <details className="review-source-list"><summary>原文与来源 · {point.sources.length} 处</summary>{point.sources.map(source => <div key={source.id}><blockquote lang="ja">{source.text}</blockquote><p className="prose-text" lang="ja">{source.context}</p>{source.examId ? <a className="text-button" href={'#exam/' + source.examId}>查看来源试卷<ArrowRight size={12} /></a> : <span className="small-muted">手动添加或原试卷已移除，原文仍保留</span>}</div>)}</details>}{point.status !== 'draft' && <div className="review-schedule"><span><Clock3 size={13} />下次：{reviewTime(point.dueAt)}</span><span>复习 {point.repetitions} 次 · 遗忘 {point.lapses} 次</span><span>优先权重 {Number.isFinite(point.weight) ? point.weight.toFixed(2) : '—'}</span></div>}
        {point.error && <div className="review-inline-error" role="alert"><p>{point.error}</p><DiagnosticsLink operation="review">每次失败的原因与时间</DiagnosticsLink></div>}{point.normalizationStatus === 'pending' && <p className="small-muted"><LoaderCircle size={13} className="spin" />AI 正在整理；可以离开，稍后回来查看。</p>}
        {point.status === 'draft' ? <><div className="review-point-actions"><button className="button primary small" disabled={locked || point.normalizationStatus === 'pending' || !point.canNormalize || (!authorized && !point.candidate)} onClick={() => void act(point, 'normalize')}>{busy === point.id + ':normalize' ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}{point.candidate ? '加入复习安排' : 'AI 整理并加入复习'}</button><button className="button secondary small" disabled={locked || point.normalizationStatus === 'pending'} onClick={() => setEditor(point)}><Edit3 size={13} />{point.candidate ? '自己编辑并加入' : '自己填写并加入'}</button></div>{!point.canNormalize && point.normalizationStatus !== 'pending' && <p className="small-muted">来自未交卷题目的标记，请先交卷，再让 AI 整理；也可以自己填写知识点。</p>}{!authorized && !point.candidate && <p className="small-muted">AI 整理需要连接并授权 ChatGPT。<a href="#settings">前往连接</a></p>}</> : <ReviewRatingActions point={point} request={request} disabled={locked} onUpdated={() => { notify('掌握情况已保存，下次复习时间已更新。'); reload(); }} />}
        <div className="review-point-actions secondary-actions">{point.status !== 'draft' && <><button className="text-button" disabled={locked} onClick={() => setEditor(point)}><Edit3 size={13} />编辑知识点</button><button className="text-button" disabled={locked} onClick={() => void act(point, point.status === 'paused' || point.status === 'mastered' ? 'resume' : 'pause')}>{point.status === 'paused' || point.status === 'mastered' ? <Play size={13} /> : <Pause size={13} />}{point.status === 'paused' || point.status === 'mastered' ? '重新加入复习' : '暂停自动复习'}</button></>}<button className="text-button review-delete" disabled={locked || point.normalizationStatus === 'pending'} onClick={() => void act(point, 'delete')}><Trash2 size={13} />移除知识点</button></div></article>)}</div> : <div className="panel state-box empty-state"><BookMarked size={27} /><h3>{status === 'due' ? '现在没有到期知识点' : '这个范围还没有知识点'}</h3><p>{status === 'due' ? '先在做题时标记词句，再到“待整理”一键整理，成功后会自动加入复习。也可以手动选择尚未到期或已掌握的知识点复习。' : '可以在题干、材料或选项中选中词句，点击“加入重点复习”。'}</p><button className="button secondary small" onClick={() => { setStatus(status === 'due' ? 'draft' : 'all'); setPage(1); }}>{status === 'due' ? '查看待整理' : '查看全部'}</button></div>}
        <nav className="diagnostics-pagination" aria-label="复习知识点分页"><button className="button secondary small" disabled={loading || data.page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}><ArrowLeft size={13} />上一页</button><span>共 {data.total} 个 · 第 {data.page} / {Math.max(1, data.pages)} 页</span><button className="button secondary small" disabled={loading || data.page >= data.pages} onClick={() => setPage(value => value + 1)}>下一页<ArrowRight size={13} /></button></nav></>}
      <details className="panel review-method"><summary>复习时间怎样安排？</summary><p className="prose-text">这是按自评推进的间隔复习安排，不是对个人记忆的精确预测。“不会”会回到较短间隔，“模糊”会降低阶段，“会了”逐步延长到 1、3、7、14、30、60 天，继续稳定掌握后退出自动安排；同一天多次点“会了”不会连续升级。“已掌握”可以手动停止自动复习。所有知识点仍保留，可随时重新加入或手动选入复习卷。AI 判分不会自动替你选择掌握程度。</p></details>
    </section><ReviewExamForm externalBusy={locked} request={request} authorized={authorized} selected={selected} onRemove={id => setSelected(value => { const next = { ...value }; delete next[id]; return next; })} /></div>
    {editor && <ReviewPointEditor externalBusy={batchBusy} point={editor} request={request} onClose={() => setEditor(null)} onSaved={(point, merged) => { setEditor(null); notify(merged ? '已合并到同名同范围知识点，原有掌握进度保留。' : '知识点已保存，可以开始重点复习。'); if (selected[point.id]) setSelected(value => { const next = { ...value }; if (Object.values(value).some(item => item.id !== point.id && item.level !== point.level)) delete next[point.id]; else next[point.id] = point; return next; }); reload(); reviewChanged(); }} />}
    {receipt && <ReviewDialog title="知识点已移除" onClose={() => setReceipt('')}><h2 className="confirm-title">删除前备份已保存</h2><p className="prose-text">需要撤销时，在“连接与设置 → 恢复已有记录”选择下面的 JSON 备份文件。恢复会替换当前学习记录，并先备份当前状态。</p><div className="deletion-receipt-path"><code>{receipt}</code></div><div className="detail-actions"><button className="button secondary" onClick={() => { setReceipt(''); window.location.hash = 'settings'; }}>前往恢复</button><button className="button primary" onClick={() => setReceipt('')}>完成</button></div></ReviewDialog>}
  </>;
}

function ReviewPointEditor({ point, request, onClose, onSaved, externalBusy }: { externalBusy: boolean; point: ReviewPoint; request: ReviewRequest; onClose: () => void; onSaved: (point: ReviewPoint, merged: boolean) => void }) {
  const initial = point.status === 'draft' && point.candidate ? point.candidate : point;
  const [fields, setFields] = useState<Candidate>({ title: initial.title, kind: initial.kind, reading: initial.reading || '', meaning: initial.meaning || '', focus: initial.focus || '', note: initial.note || '' });
  const [scope, setScope] = useState(point.scope), [level, setLevel] = useState(point.level), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const sending = useRef(false);
  const update = (key: keyof Candidate, value: string) => setFields(old => ({ ...old, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault(); if (sending.current || externalBusy || !fields.title.trim()) return;
    sending.current = true; setBusy(true); setError('');
    try {
      const result = await request<{ item: ReviewPoint; merged?: boolean }>('/review/points/' + encodeURIComponent(point.id) + (point.status === 'draft' ? '/confirm' : ''), point.status === 'draft' ? 'POST' : 'PUT', { ...fields, title: fields.title.trim(), scope, level });
      onSaved(result.item, Boolean(result.merged));
    } catch (cause) { setError(message(cause)); setBusy(false); }
    finally { sending.current = false; }
  }
  return <ReviewDialog title={point.status === 'draft' ? '填写复习知识点' : '编辑复习知识点'} busy={busy} onClose={onClose}><form onSubmit={event => void submit(event)}>{externalBusy && <p className="small-muted">批量整理正在进行，请稍后保存修改。</p>}<fieldset className="review-editor-fields" disabled={busy || externalBusy}><h2 className="confirm-title">填写自己想复习的内容</h2><p className="small-muted">可以自行填写或修改原形、知识点名称与复习范围。例如「済んで」可以记为「済む」的整体用法；保存后随时可以再编辑。</p>{point.sources?.length > 0 && <div className="review-editor-quotes">{point.sources.map(source => <blockquote key={source.id} lang="ja">{source.text}</blockquote>)}</div>}<label className="form-field">知识点名称／原形<input value={fields.title} required maxLength={200} disabled={busy} onChange={event => update('title', event.target.value)} placeholder="例如：済む、～てしまう" lang="ja" /></label><div className="form-two-col"><label className="form-field">知识点类型<select value={fields.kind} disabled={busy} onChange={event => update('kind', event.target.value)}>{Object.entries(names).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label className="form-field">复习范围<select value={scope} disabled={busy} onChange={event => setScope(event.target.value as typeof scope)}><option value="broad">整体用法</option><option value="context">只复习此处用法</option></select></label></div><label className="form-field">复习难度<select value={level} disabled={busy} onChange={event => setLevel(event.target.value)}>{levels.map(value => <option key={value} value={value}>{levelName(value)}</option>)}</select></label><label className="form-field">读法（假名） <span className="optional">可选</span><input placeholder="例如：済む → すむ" value={fields.reading} maxLength={200} disabled={busy} onChange={event => update('reading', event.target.value)} lang="ja" /></label><label className="form-field">含义说明 <span className="optional">可选</span><textarea value={fields.meaning} maxLength={2000} rows={2} disabled={busy} onChange={event => update('meaning', event.target.value)} /></label><label className="form-field">以后重点复习什么<textarea value={fields.focus} maxLength={1200} rows={3} disabled={busy} onChange={event => update('focus', event.target.value)} placeholder="例如：済む的基本含义、常见搭配、与終わる的区别，而不只考て形。" /></label><label className="form-field">学习笔记 <span className="optional">可选</span><textarea value={fields.note} maxLength={4000} rows={3} disabled={busy} onChange={event => update('note', event.target.value)} /></label>{error && <p className="review-inline-error" role="alert">{error}</p>}<div className="detail-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>稍后再看</button><button className="button primary" disabled={busy || !fields.title.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{point.status === 'draft' ? '保存并加入复习安排' : '保存修改'}</button></div></fieldset></form></ReviewDialog>;
}

function ReviewExamForm({ request, authorized, selected, onRemove, externalBusy }: { externalBusy: boolean; request: ReviewRequest; authorized: boolean; selected: Record<string, ReviewPoint>; onRemove: (id: string) => void }) {
  const points = Object.values(selected), selectedLevel = points[0]?.level;
  const [level, setLevel] = useState('N5'), [count, setCount] = useState(10), [questionTypes, setQuestionTypes] = useState(['single', 'fill']);
  const [reviewFocus, setReviewFocus] = useState<'general' | 'reading'>('general');
  const effectiveTypes = reviewFocus === 'reading' ? ['fill'] : questionTypes;
  const unsupportedReadingPoints = points.filter(point => point.kind === 'grammar' || !/\p{Script=Han}/u.test(point.title));
  const [mode, setMode] = useState('practice'), [gradingMode, setGradingMode] = useState('mixed'), [manual, setManual] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const sending = useRef(false);
  useEffect(() => { if (points.length) { setManual(true); if (selectedLevel) setLevel(selectedLevel); } }, [points.length, selectedLevel]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (sending.current || externalBusy || (reviewFocus === 'reading' && manual && unsupportedReadingPoints.length > 0)) return;
    sending.current = true; setBusy(true); setError('');
    try {
      const result = await request<{ id: string }>('/review/exams', 'POST', { level, count, types: effectiveTypes, reviewFocus, mode, gradingMode, ...(manual ? { pointIds: points.map(point => point.id) } : {}) });
      window.location.hash = 'exam/' + result.id;
    } catch (cause) { setError(message(cause)); }
    finally { sending.current = false; setBusy(false); }
  }
  return <aside className="review-exam-sidebar"><form className="panel review-exam-form" onSubmit={event => void submit(event)}><div className="summary-icon"><BookMarked size={23} /></div><h2>给知识点一份复习卷</h2><p className="small-muted">可以综合练习词义、用法，也可以专门练汉字读音。</p><label className="form-field">复习重点<select value={reviewFocus} disabled={busy || externalBusy} onChange={event => setReviewFocus(event.target.value as typeof reviewFocus)}><option value="general">综合复习 · 词义、用法与读音</option><option value="reading">汉字读音 · 看汉字填写假名</option></select></label><label className="form-field">选取方式<select value={manual ? 'manual' : 'due'} disabled={busy || externalBusy} onChange={event => setManual(event.target.value === 'manual')}><option value="due">自动选择到期知识点</option><option value="manual">使用我勾选的知识点</option></select></label>{manual && <div className="review-selected-points">{points.length ? points.map(point => <span key={point.id}>{point.title}<button type="button" aria-label={'取消选择' + point.title} disabled={busy || externalBusy} onClick={() => onRemove(point.id)}><X size={12} /></button></span>) : <p className="small-muted">在列表中勾选已加入安排的知识点。</p>}</div>}<div className="form-two-col"><label className="form-field">复习等级<select value={level} disabled={busy || externalBusy || (manual && points.length > 0)} onChange={event => setLevel(event.target.value)}>{levels.map(value => <option value={value} key={value}>{levelName(value)}</option>)}</select></label><label className="form-field">题目数量<select value={count} disabled={busy || externalBusy} onChange={event => setCount(Number(event.target.value))}>{counts.map(value => <option value={value} key={value}>{value} 题</option>)}</select></label></div>{reviewFocus === 'reading' ? <div className="review-reading-mode"><strong>看汉字，填写假名读法</strong><p>只选择名称含汉字的单词或表达，自动选取时会跳过语法和纯假名知识点。AI 结合语境出读音填空题，作答时先自己回想，查看反馈后再核对。</p>{manual && unsupportedReadingPoints.length > 0 && <p className="review-inline-error" role="status">已选的「{unsupportedReadingPoints.map(point => point.title).join('」、「')}」不适合汉字读音专练。请在上方取消这些知识点，或切回“综合复习”；其余选择会保留。</p>}</div> : <fieldset className="review-exam-types"><legend>题型</legend>{Object.entries(types).map(([id, name]) => <label key={id}><input type="checkbox" checked={questionTypes.includes(id)} disabled={busy || externalBusy} onChange={event => setQuestionTypes(current => event.target.checked ? [...current, id] : current.filter(value => value !== id))} />{name}</label>)}</fieldset>}<label className="form-field">练习方式<select value={mode} disabled={busy || externalBusy} onChange={event => setMode(event.target.value)}><option value="practice">练习模式 · 逐题反馈</option><option value="exam">考试模式 · 交卷后解析</option></select></label><label className="form-field">判卷方式<select value={gradingMode} disabled={busy || externalBusy} onChange={event => setGradingMode(event.target.value)}><option value="mixed">常规判卷</option><option value="ai">全部由 AI 判卷</option></select></label>{manual && points.length > count && <p className="review-inline-error">选择了 {points.length} 个知识点，请把题量调整到至少 {points.length} 题，让每个知识点都能覆盖。</p>}{!authorized && <p className="small-muted">AI 复习卷需要先授权 ChatGPT。<a href="#settings">前往连接</a></p>}{error && <div className="review-inline-error" role="alert"><p>{error}</p><DiagnosticsLink operation="generate">查看出题失败详情</DiagnosticsLink></div>}<button className="button primary full-width" disabled={busy || externalBusy || !authorized || !effectiveTypes.length || (manual && (!points.length || points.length > count || (reviewFocus === 'reading' && unsupportedReadingPoints.length > 0)))}>{busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{busy ? '正在生成复习卷…' : '生成 AI 复习卷'}</button><p className="summary-note">{externalBusy && <>批量整理或其他知识点操作完成后可出卷。<br /></>}自动选择只使用已到期、未暂停的知识点。<br />手动选择可包含尚未到期和已掌握的内容。<br />生成与 AI 判卷会使用套餐额度。</p></form></aside>;
}
