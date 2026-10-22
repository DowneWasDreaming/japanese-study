import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleHelp, LoaderCircle, RefreshCw, Sparkles, Square } from 'lucide-react';
import { DiagnosticsLink } from './AIDiagnostics';
import { reviewChanged, type ReviewRequest } from './ReviewCapture';

type Batch = {
  id: string; status: 'running' | 'stopping' | 'completed' | 'stopped'; startedAt: string; finishedAt: string | null;
  total: number; processed: number; succeeded: number; failed: number;
  current: { id: string; title: string } | null; stopReason: string | null;
  items: { id: string; title: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped'; error: string | null }[];
};
type Overview = { batch: Batch | null; totalDraftCount: number; eligibleCount: number; completedCount: number; blockedCount: number };
const isRunning = (batch: Batch | null | undefined) => batch?.status === 'running' || batch?.status === 'stopping';
const reason = (cause: unknown) => cause instanceof Error ? cause.message : '读取批量整理状态未完成，请刷新状态后继续。';

export function ReviewBatch({ request, authorized, disabled, onBusyChange, onProgress }: {
  request: ReviewRequest; authorized: boolean; disabled: boolean; onBusyChange: (value: boolean) => void; onProgress: () => void;
}) {
  const [overview, setOverview] = useState<Overview | null>(null), [loading, setLoading] = useState(true), [action, setAction] = useState(''), [error, setError] = useState('');
  const [tick, setTick] = useState(0), [reading, setReading] = useState(false);
  const active = useRef(true), sending = useRef(false), lastProgress = useRef(''), snapshot = useRef<Overview | null>(null);
  const callbacks = useRef({ onBusyChange, onProgress }); callbacks.current = { onBusyChange, onProgress };
  const batch = overview?.batch, running = isRunning(batch);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const apply = useCallback((value: Overview) => {
    snapshot.current = value; setOverview(value);
    const progress = value.batch ? [value.batch.id, value.batch.processed, value.batch.status].join(':') : '';
    if (progress !== lastProgress.current) {
      const previous = lastProgress.current; lastProgress.current = progress;
      if (previous) callbacks.current.onProgress();
      if (previous && value.batch && !isRunning(value.batch)) reviewChanged();
    }
  }, []);
  useEffect(() => {
    let current = true; setReading(true);
    void request<Overview>('/review/normalize-batch').then(value => {
      if (current && active.current) { apply(value); setError(''); }
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

  async function perform(kind: 'start' | 'stop') {
    if (sending.current || (kind === 'start' && (disabled || running || !authorized || !overview?.eligibleCount))) return;
    sending.current = true; setAction(kind); setLoading(true); setError('');
    try {
      const result = await request<{ batch: Batch }>(kind === 'start' ? '/review/normalize-batch' : '/review/normalize-batch/' + encodeURIComponent(batch!.id) + '/stop', 'POST', {});
      if (active.current) {
        const value = snapshot.current;
        apply({ totalDraftCount: value?.totalDraftCount || 0, eligibleCount: value?.eligibleCount || 0, completedCount: value?.completedCount || 0, blockedCount: value?.blockedCount || 0, batch: result.batch });
      }
    } catch (cause) { if (active.current) setError(reason(cause)); }
    finally {
      sending.current = false;
      if (active.current) { setAction(''); setTick(value => value + 1); }
    }
  }
  const failures = batch?.items.filter(item => item.status === 'failed') || [];
  const remaining = batch ? Math.max(0, batch.total - batch.processed) : 0;
  const progress = batch?.total ? Math.min(100, Math.round(batch.processed / batch.total * 100)) : 0;
  return <section className="panel review-batch" aria-label="一键 AI 整理知识点">
    <div className="review-batch-heading"><div><h2><Sparkles size={18} />一键 AI 整理知识点</h2><p>自动逐个整理全部待整理标记，不限当前页或筛选。AI 建议仍由你检查并确认。</p></div><div className="review-batch-actions">{running ? <button className="button secondary small" disabled={Boolean(action) || batch?.status === 'stopping'} onClick={() => void perform('stop')}><Square size={13} />{action === 'stop' || batch?.status === 'stopping' ? '当前项完成后停止…' : '停止后续整理'}</button> : <button className="button primary small" disabled={loading || Boolean(action) || disabled || !authorized || !overview?.eligibleCount} onClick={() => void perform('start')}>{action === 'start' ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}{action === 'start' ? '正在开始…' : '一键 AI 整理全部'}{overview && overview.eligibleCount > 0 && !action && <span>（{overview.eligibleCount} 个）</span>}</button>}<button type="button" className="text-button" disabled={Boolean(action)} onClick={() => { setLoading(true); setTick(value => value + 1); }}><RefreshCw size={13} />刷新状态</button></div></div>
    {overview ? <p className="review-batch-counts">共 {overview.totalDraftCount} 个待确认 · {overview.eligibleCount} 个可整理 · {overview.completedCount} 个已有 AI 建议 · {overview.blockedCount} 个待交卷后整理</p> : loading && <p className="small-muted"><LoaderCircle size={13} className="spin" />正在读取全部待整理知识点…</p>}
    {batch && <div className={'review-batch-progress status-' + batch.status}>
      <div className="review-batch-status" role="status" aria-live="polite"><strong>{running ? <LoaderCircle size={15} className="spin" /> : batch.status === 'completed' ? <CheckCircle2 size={15} /> : <CircleHelp size={15} />}{batch.status === 'running' ? '正在批量整理' : batch.status === 'stopping' ? '正在停止后续整理' : batch.status === 'completed' ? '本次批量整理已完成' : '本次批量整理已停止'}</strong><span>已处理 {batch.processed} / {batch.total} · 成功 {batch.succeeded} · 失败 {batch.failed} · {running ? '剩余' : '未处理'} {remaining}</span></div>
      <div className="progress-track" role="progressbar" aria-label="批量整理进度" aria-valuemin={0} aria-valuemax={batch.total} aria-valuenow={batch.processed}><span style={{ width: progress + '%' }} /></div>
      {batch.current && <p className="review-batch-current">当前：<span lang="ja">{batch.current.title}</span></p>}
      {batch.stopReason && <p className="review-inline-error">停止原因：{batch.stopReason}</p>}
      <p className="small-muted">{running ? '任务在本机后台继续，切换页面或刷新不影响进度。停止会等待当前项完成。' : '已完成的建议已保存；再次一键整理只处理尚未成功的项目。重启应用后也不会重复请求已有建议。'}</p>
      {failures.length > 0 && <details className="review-batch-failures"><summary>查看 {failures.length} 个失败知识点的具体原因</summary><ul>{failures.map(item => <li key={item.id}><strong lang="ja">{item.title}</strong><p>{item.error || '未取得完整整理结果，请查看失败记录。'}</p></li>)}</ul><DiagnosticsLink operation="review">查看每次失败的原因与时间</DiagnosticsLink></details>}
    </div>}
    <p className="review-batch-note">已整理过的建议不会重复调用；未交卷来源会跳过。每个实际整理请求使用套餐额度，用量记入 Token 统计。</p>
    {!authorized && <p className="small-muted">请先<a href="#settings">连接并授权 ChatGPT</a>，再使用 AI 整理。</p>}
    {error && <div className="review-inline-error" role="alert"><p>{error}</p><p>页面未确认任务是否结束时，请刷新状态；无需重复点击开始。</p><DiagnosticsLink operation="review">查看 AI 整理失败记录</DiagnosticsLink></div>}
  </section>;
}
