import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleHelp, LoaderCircle, RefreshCw, ShieldCheck, Sparkles, Square } from 'lucide-react';
import { DiagnosticsLink } from './AIDiagnostics';
import { reviewChanged, type ReviewRequest } from './ReviewCapture';

type Batch = {
  id: string; kind?: 'normalize' | 'audit'; status: 'running' | 'stopping' | 'completed' | 'stopped'; startedAt: string; finishedAt: string | null;
  total: number; processed: number; succeeded: number; failed: number; uncertain?: number;
  current: { id: string; title: string } | null; stopReason: string | null;
  items: { id: string; title: string; status: 'queued' | 'running' | 'completed' | 'uncertain' | 'failed' | 'skipped'; error: string | null }[];
};
type NormalizeOverview = { batch: Batch | null; totalDraftCount: number; eligibleCount: number; completedCount: number; blockedCount: number };
type AuditOverview = { batch: Batch | null; totalCount: number; eligibleCount: number; checkedCount: number; blockedCount: number };
type Overview = { normalize: NormalizeOverview; audit: AuditOverview };
const isRunning = (batch: Batch | null | undefined) => batch?.status === 'running' || batch?.status === 'stopping';
const reason = (cause: unknown) => cause instanceof Error ? cause.message : '读取批量状态未完成，请刷新状态后继续。';
const currentBatch = (value: Overview | null) => [value?.normalize.batch, value?.audit.batch].filter((batch): batch is Batch => Boolean(batch)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] || null;

export function ReviewBatch({ request, authorized, disabled, onBusyChange, onProgress, onViewUncertain }: {
  request: ReviewRequest; authorized: boolean; disabled: boolean; onBusyChange: (value: boolean) => void; onProgress: () => void; onViewUncertain: () => void;
}) {
  const [overview, setOverview] = useState<Overview | null>(null), [loading, setLoading] = useState(true), [action, setAction] = useState(''), [error, setError] = useState('');
  const [tick, setTick] = useState(0), [reading, setReading] = useState(false);
  const active = useRef(true), sending = useRef(false), lastProgress = useRef('');
  const callbacks = useRef({ onBusyChange, onProgress }); callbacks.current = { onBusyChange, onProgress };
  const batch = currentBatch(overview), running = isRunning(batch), auditing = batch?.kind === 'audit';
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const apply = useCallback((value: Overview) => {
    setOverview(value);
    const batch = currentBatch(value), progress = batch ? [batch.id, batch.processed, batch.status].join(':') : '';
    if (progress !== lastProgress.current) {
      const previous = lastProgress.current; lastProgress.current = progress;
      if (previous) callbacks.current.onProgress();
      if (previous && batch && !isRunning(batch)) reviewChanged();
    }
  }, []);
  useEffect(() => {
    let current = true; setReading(true);
    void Promise.all([request<NormalizeOverview>('/review/normalize-batch'), request<AuditOverview>('/review/audit-batch')]).then(([normalize, audit]) => {
      if (current && active.current) { apply({ normalize, audit }); setError(''); }
    }).catch(cause => { if (current && active.current) setError(reason(cause)); }).finally(() => { if (current && active.current) { setLoading(false); setReading(false); } });
    return () => { current = false; };
  }, [request, tick, apply]);
  useEffect(() => {
    const changed = () => setTick(value => value + 1);
    window.addEventListener('review-points-changed', changed); return () => window.removeEventListener('review-points-changed', changed);
  }, []);
  useEffect(() => {
    if (!running || action || reading) return;
    const timer = window.setTimeout(() => setTick(value => value + 1), 1500); return () => clearTimeout(timer);
  }, [running, action, reading, tick, overview, error]);
  useEffect(() => { callbacks.current.onBusyChange(loading || running || Boolean(action)); }, [loading, running, action]);

  async function perform(kind: 'normalize' | 'audit' | 'stop') {
    const eligible = kind === 'audit' ? overview?.audit.eligibleCount : overview?.normalize.eligibleCount;
    const needsAuthorization = !authorized && (kind === 'audit' || !overview || overview.normalize.eligibleCount > overview.normalize.completedCount);
    if (sending.current || (kind !== 'stop' && (disabled || running || needsAuthorization || !eligible))) return;
    sending.current = true; setAction(kind); setError('');
    try {
      const endpoint = kind === 'stop' ? '/review/' + (auditing ? 'audit' : 'normalize') + '-batch/' + encodeURIComponent(batch!.id) + '/stop' : '/review/' + kind + '-batch';
      const result = await request<{ batch: Batch }>(endpoint, 'POST', {});
      if (active.current) setOverview(value => value ? { normalize: { ...value.normalize, batch: result.batch }, audit: { ...value.audit, batch: result.batch } } : value);
    } catch (cause) { if (active.current) setError(reason(cause)); }
    finally { sending.current = false; if (active.current) { setAction(''); setTick(value => value + 1); } }
  }
  const failures = batch?.items.filter(item => item.status === 'failed') || [];
  const uncertain = batch?.uncertain ?? batch?.items.filter(item => item.status === 'uncertain').length ?? 0;
  const remaining = batch ? Math.max(0, batch.total - batch.processed) : 0;
  const progress = batch?.total ? Math.min(100, Math.round(batch.processed / batch.total * 100)) : 0;
  return <section className="panel review-batch" aria-label="AI 整理与核查知识点">
    <div className="review-batch-tools">
      <div className="review-batch-tool">
        <div><h2><Sparkles size={18} />整理新标记</h2><p>结合原文核对你的理解。明确的误解会纠正后加入复习；拿不准的放入“待核实”，无需逐条确认。</p></div>
        <button className="button primary small" disabled={loading || Boolean(action) || disabled || running || (!authorized && (!overview || overview.normalize.eligibleCount > overview.normalize.completedCount)) || !overview?.normalize.eligibleCount} onClick={() => void perform('normalize')}>{action === 'normalize' ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}一键 AI 整理全部{overview && overview.normalize.eligibleCount > 0 && <span>（{overview.normalize.eligibleCount} 个）</span>}</button>
        {overview && <p className="review-batch-counts">待整理 {overview.normalize.totalDraftCount} · 可处理 {overview.normalize.eligibleCount} · 待交卷 {overview.normalize.blockedCount}</p>}
      </div>
      <div className="review-batch-tool">
        <div><h2><ShieldCheck size={18} />核查已有知识点</h2><p>检查已有含义与用法，自动纠正、区分不同用法，合并真正重复项并保留相关进度。已核查且内容未变的会跳过。</p></div>
        <button className="button secondary small" disabled={loading || Boolean(action) || disabled || running || !authorized || !overview?.audit.eligibleCount} onClick={() => void perform('audit')}>{action === 'audit' ? <LoaderCircle size={14} className="spin" /> : <ShieldCheck size={14} />}一键 AI 核查已有知识点{overview && overview.audit.eligibleCount > 0 && <span>（{overview.audit.eligibleCount} 个）</span>}</button>
        {overview && <p className="review-batch-counts">已有 {overview.audit.totalCount} · 待核查 {overview.audit.eligibleCount} · 内容未变跳过 {overview.audit.checkedCount} · 暂不可处理 {overview.audit.blockedCount}</p>}
      </div>
    </div>
    <div className="review-batch-actions">{running && <button className="button secondary small" disabled={Boolean(action) || batch?.status === 'stopping'} onClick={() => void perform('stop')}><Square size={13} />{action === 'stop' || batch?.status === 'stopping' ? '当前项完成后停止…' : '停止后续' + (auditing ? '核查' : '整理')}</button>}<button type="button" className="text-button" disabled={Boolean(action)} onClick={() => { setLoading(true); setTick(value => value + 1); }}><RefreshCw size={13} />刷新状态</button></div>
    {loading && !overview && <p className="small-muted"><LoaderCircle size={13} className="spin" />正在读取全部知识点状态…</p>}
    {batch && <div className={'review-batch-progress status-' + batch.status}>
      <div className="review-batch-status" role="status" aria-live="polite"><strong>{running ? <LoaderCircle size={15} className="spin" /> : batch.status === 'completed' ? <CheckCircle2 size={15} /> : <CircleHelp size={15} />}{batch.status === 'running' ? '正在批量' + (auditing ? '核查' : '整理') : batch.status === 'stopping' ? '当前项完成后停止' : batch.status === 'completed' ? '本次批量' + (auditing ? '核查' : '整理') + '已完成' : '本次任务已停止'}</strong><span>已处理 {batch.processed} / {batch.total} · 已处理完成 {batch.succeeded} · 待核实 {uncertain} · 失败 {batch.failed} · {running ? '剩余' : '未处理'} {remaining}</span></div>
      <div className="progress-track" role="progressbar" aria-label="批量知识点处理进度" aria-valuemin={0} aria-valuemax={batch.total} aria-valuenow={batch.processed}><span style={{ width: progress + '%' }} /></div>
      {batch.current && <p className="review-batch-current">当前：<span lang="ja">{batch.current.title}</span></p>}
      {batch.stopReason && <p className="review-inline-error">停止原因：{batch.stopReason}</p>}
      <p className="small-muted">{running ? '任务在本机后台继续，切换页面或刷新不影响进度。停止会等待当前项完成。' : '明确的内容已保存；证据不足的保留在“待核实”，不用于复习出题。后续重开任务会跳过内容未变的核查结果。'}</p>
      {uncertain > 0 && <button type="button" className="text-button" onClick={onViewUncertain}>查看待核实知识点<CircleHelp size={13} /></button>}
      {failures.length > 0 && <details className="review-batch-failures"><summary>查看 {failures.length} 个失败知识点的具体原因</summary><ul>{failures.map(item => <li key={item.id}><strong lang="ja">{item.title}</strong><p>{item.error || '本次处理未完成，原文及已有进度保留。'}</p></li>)}</ul><DiagnosticsLink operation="review">查看每次失败的原因与时间</DiagnosticsLink></details>}
    </div>}
    <p className="review-batch-note">两项任务都处理全部符合条件的知识点，不限当前页或筛选。只在你点击时请求 AI，每次实际请求使用套餐额度并计入 Token 统计。</p>
    {!authorized && <p className="small-muted">请先<a href="#settings">连接并授权 ChatGPT</a>，再使用 AI 核查。</p>}
    {error && <div className="review-inline-error" role="alert"><p>{error}</p><p>页面未确认任务是否结束时，请刷新状态；无需重复点击开始。</p><DiagnosticsLink operation="review">查看 AI 处理失败记录</DiagnosticsLink></div>}
  </section>;
}
