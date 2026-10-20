import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, BarChart3, CircleHelp, Clock3, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';

type Period = 'day' | 'week' | 'all';
type Counts = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cachedTokens: number | null; reasoningTokens: number | null };
type UsageItem = Counts & { id: string; createdAt: string; model: string; responseId: string | null; status: 'completed' | 'failed'; usageState: 'reported' | 'unavailable' };
type UsageSnapshot = {
  period: Period; timezone: string; range: { start: string | null; end: string | null }; collectionStartedAt: string;
  summary: Counts & { requests: number; reportedRequests: number; unavailableRequests: number; completedRequests: number; failedRequests: number };
  items: UsageItem[]; page: number; pageSize: number; total: number; pages: number;
};
const periods: { id: Period; label: string }[] = [{ id: 'day', label: '今天' }, { id: 'week', label: '近 7 天' }, { id: 'all', label: '全部记录' }];
const numberFormat = new Intl.NumberFormat('zh-CN');
function count(value: number | null) { return value == null ? '—' : numberFormat.format(value); }
function time(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }).format(parsed);
}
function UsageMetrics({ values, compact = false }: { values: Counts; compact?: boolean }) {
  return <dl className={`token-metrics ${compact ? 'compact' : ''}`}>
    <div><dt>输入 Token</dt><dd>{count(values.inputTokens)}</dd></div><div><dt>输出 Token</dt><dd>{count(values.outputTokens)}</dd></div><div className="token-total"><dt>总 Token</dt><dd>{count(values.totalTokens)}</dd></div>
    <div className="token-subset"><dt>其中：缓存输入</dt><dd>{count(values.cachedTokens)}</dd></div><div className="token-subset"><dt>其中：推理输出</dt><dd>{count(values.reasoningTokens)}</dd></div>
  </dl>;
}

export function TokenUsagePage() {
  const [period, setPeriod] = useState<Period>('day'), [page, setPage] = useState(1), [revision, setRevision] = useState(0);
  const [data, setData] = useState<UsageSnapshot | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setData(null);
    const query = new URLSearchParams({ period, page: String(page) });
    void fetch('/api/token-usage?' + query, { signal: controller.signal }).then(async response => {
      let result: UsageSnapshot & { error?: { message?: string } };
      try { result = await response.json(); } catch { throw new Error('本地服务没有返回有效用量数据，请确认服务正在运行。'); }
      if (!response.ok) throw new Error(result.error?.message || '读取 Token 用量没有完成。');
      if (!controller.signal.aborted) setData(result);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取 Token 用量没有完成。'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [period, page, revision]);
  const totalPages = Math.max(1, data?.pages || 1);
  return <><a className="back-link" href="#settings"><ArrowLeft size={15} />返回连接与设置</a>
    <div className="page-heading token-page-heading"><div><div className="eyebrow">MAKE EVERY QUESTION COUNT</div><h1>Token 用量<span className="heading-dot">。</span></h1><p>查看本网站的模型调用，以及 GPT 实际返回的 Token 计数。读取和刷新此页不会调用 AI。</p></div><button className="button secondary small" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} className={loading ? 'spin' : ''} />刷新用量</button></div>
    <div className="notice-box token-intro"><ShieldCheck size={18} /><div><strong>按实际返回值记录，缺失的用量显示为「—」</strong><p>统计只覆盖本网站开始记录后的调用；无法补回升级前的 Token 用量。失败的请求也会留下记录，GPT 未返回计数时不会估算为零。这里的 Token 合计不代表官方套餐剩余额度或费用。</p></div></div>
    <div className="token-period-bar"><div className="level-filter" aria-label="Token 用量时间范围">{periods.map(item => <button key={item.id} aria-pressed={period === item.id} className={period === item.id ? 'selected' : ''} onClick={() => { setPeriod(item.id); setPage(1); }}>{item.label}</button>)}</div><span>按北京时间（UTC+8）统计 · 近 7 天含今天</span></div>
    {error && <div className="error-box" role="alert"><CircleHelp size={19} /><div><strong>Token 用量暂时无法读取</strong><p>{error}</p><button className="text-button" onClick={() => setRevision(value => value + 1)}>重新读取<RefreshCw size={13} /></button></div></div>}
    {loading ? <div className="state-box" role="status"><LoaderCircle size={22} className="spin" /><p>正在读取 Token 用量…</p></div> : data && <>
      <section className="panel token-summary" aria-label="所选范围 Token 用量汇总"><div className="section-heading"><div><h2>{periods.find(item => item.id === data.period)?.label || '当前范围'}的已知用量</h2><p>只累加 GPT 已返回的计数；未返回部分不包含在合计中。</p></div><BarChart3 size={22} /></div><UsageMetrics values={data.summary} /><div className="token-coverage"><strong>共 {count(data.summary.requests)} 次模型调用</strong><span>已返回用量 {count(data.summary.reportedRequests)} 次</span><span>用量未知 {count(data.summary.unavailableRequests)} 次</span><span>响应完成 {count(data.summary.completedRequests)} 次 · 调用失败 {count(data.summary.failedRequests)} 次</span></div><p className="small-muted token-subset-note">缓存输入已包含在输入 Token 中，推理输出已包含在输出 Token 中，请勿再次相加。两项细分可能不返回；「—」表示未返回，0 表示 GPT 明确返回零。</p></section>
      <div className="token-records-heading"><div><h2>逐次调用记录</h2><p>最新调用在前 · 共 {count(data.total)} 条 · 第 {data.page} / {totalPages} 页</p></div><span>仅记录用量元数据</span></div>
      {data.items.length ? <div className="token-records">{data.items.map(item => <article className="panel token-record" key={item.id}><div className="token-record-meta"><span className={`pill ${item.status === 'completed' ? 'green' : 'token-failed'}`}>{item.status === 'completed' ? '响应完成' : '调用失败'}</span><span className="pill">{item.usageState === 'reported' ? '已返回用量' : '用量未知'}</span><time dateTime={item.createdAt}><Clock3 size={12} />{time(item.createdAt)}</time></div><h3>{item.model || '模型未记录'}</h3><UsageMetrics values={item} compact /><details className="token-record-details"><summary>查看调用标识</summary><dl><div><dt>记录 ID</dt><dd>{item.id}</dd></div><div><dt>Response ID</dt><dd>{item.responseId || '未返回或未记录'}</dd></div></dl></details>{item.status === 'failed' && <a className="text-button" href="#diagnostics">查看 AI 失败记录<ArrowRight size={12} /></a>}</article>)}</div> : <div className="panel state-box empty-state"><BarChart3 size={28} /><h3>这个时间范围还没有模型调用记录</h3><p>以后出题、解析、追问或 AI 判卷时，会在这里记录调用和已返回的 Token 用量。</p></div>}
      <nav className="diagnostics-pagination" aria-label="Token 用量记录分页"><button className="button secondary small" disabled={page <= 1} onClick={() => { setPage(value => Math.max(1, value - 1)); window.scrollTo({ top: 0 }); }}><ArrowLeft size={14} />上一页</button><span>每页 {data.pageSize} 条</span><button className="button secondary small" disabled={page >= totalPages} onClick={() => { setPage(value => value + 1); window.scrollTo({ top: 0 }); }}>下一页<ArrowRight size={14} /></button></nav>
      <p className="small-muted token-started">本机开始记录时间：{time(data.collectionStartedAt)}（北京时间）。响应完成表示模型请求已完成，后续的题目或评分校验若失败，请查看 AI 失败记录。用量记录不包含提示词、回答正文或登录凭据。</p>
    </>}
  </>;
}
