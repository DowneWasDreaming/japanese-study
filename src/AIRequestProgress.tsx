import { useEffect, useState } from 'react';
import { Activity, Clock3, LoaderCircle } from 'lucide-react';

export type ModelRequestProgress = {
  id: string; model: string; state: 'waiting_headers' | 'waiting_events' | 'processing' | 'receiving_text' | 'completed' | 'failed';
  startedAt: string; headersAt: string | null; firstByteAt: string | null; lastByteAt: string | null;
  firstEventAt: string | null; lastEventAt: string | null; firstTextAt: string | null; lastTextAt: string | null; endedAt: string | null;
  elapsedMs: number; sinceLastByteMs: number | null; sinceLastEventMs: number | null; sinceLastTextMs: number | null;
  timeoutMs: number; receivedBytes: number; eventCount: number; textCharacters: number;
  lastEventType: string | null; httpStatus: number | null; errorCode: string | null; reason: string | null;
};

const active = (item: ModelRequestProgress) => item.state !== 'completed' && item.state !== 'failed';
export function progressDuration(value: number) {
  const seconds = Math.max(0, value) / 1000;
  return seconds < 60 ? `${seconds < 10 ? seconds.toFixed(1) : Math.floor(seconds)} 秒` : `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`;
}
const afterStart = (value: string | null, item: ModelRequestProgress) => value ? '发起后 ' + progressDuration(Date.parse(value) - Date.parse(item.startedAt)) : '未收到';
const lastReceived = (value: number | null, frozen: boolean) => value === null ? '未收到' : progressDuration(value) + (frozen ? '前（截至结束时）' : '前');
const timestamp = (value: string | null) => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }).format(new Date(value)) : '未收到';

function progressHeading(item: ModelRequestProgress, frozen: boolean) {
  if (!item.headersAt) return frozen ? '结束前未收到 HTTP 响应' : '等待服务响应';
  if (!item.firstTextAt) {
    if (item.eventCount > 0) return '已收到处理进度，尚无答案正文';
    return '已连接，等待答案正文';
  }
  if (frozen) return '已收到部分答案，尚未完成';
  return item.sinceLastTextMs !== null && item.sinceLastTextMs <= 15_000 ? '正在接收答案' : '等待后续正文';
}

export function RequestProgressSummary({ item, frozen = false }: { item: ModelRequestProgress; frozen?: boolean }) {
  return <div className={'ai-request-progress-summary' + (frozen ? ' frozen' : '')}>
    <div className="ai-progress-title"><strong>{progressHeading(item, frozen)}</strong><span>{item.model}</span></div>
    <dl className="ai-progress-metrics">
      <div><dt>{frozen ? '结束时总耗时' : '已等待'}</dt><dd>{progressDuration(item.elapsedMs)}<small>总等待上限 {progressDuration(item.timeoutMs)}</small></dd></div>
      <div><dt>收到服务响应</dt><dd>{item.httpStatus !== null ? 'HTTP ' + item.httpStatus : '未收到 HTTP 响应'}<small>{item.headersAt ? afterStart(item.headersAt, item) : '尚不能判断远端是否开始处理'}</small></dd></div>
      <div><dt>第一段答案正文</dt><dd>{item.firstTextAt ? afterStart(item.firstTextAt, item) : '尚未收到答案正文'}<small>已收到 {item.textCharacters.toLocaleString('zh-CN')} 字符</small></dd></div>
      <div><dt>最近一段答案正文</dt><dd>{lastReceived(item.sinceLastTextMs, frozen)}<small>{item.sinceLastTextMs !== null && item.sinceLastTextMs > 15_000 ? '一段时间没有新正文，仍在等待' : frozen ? '这是本次结束时的接收记录' : '仅表示最近实际收到正文的时间'}</small></dd></div>
    </dl>
    <p className="ai-progress-last">最近服务进度：{lastReceived(item.sinceLastEventMs, frozen)}<span>最近网络数据：{lastReceived(item.sinceLastByteMs, frozen)}</span></p>
    <p className="ai-progress-caveat">网络数据或处理进度不代表答案在持续生成；暂时没有新内容，也不能断定远端已经停止。这里无法直接判断远端排队、模型计算或网络链路哪个环节较慢。</p>
    <details className="ai-progress-details"><summary>查看接收时间与事件详情</summary><dl>
      <div><dt>开始请求（北京时间）</dt><dd>{timestamp(item.startedAt)}</dd></div>
      <div><dt>收到 HTTP 响应</dt><dd>{timestamp(item.headersAt)}</dd></div>
      <div><dt>第一次 / 最近一次网络数据</dt><dd>{timestamp(item.firstByteAt)} / {timestamp(item.lastByteAt)}</dd></div>
      <div><dt>第一次 / 最近一次服务事件</dt><dd>{timestamp(item.firstEventAt)} / {timestamp(item.lastEventAt)}</dd></div>
      <div><dt>第一次 / 最近一次答案正文</dt><dd>{timestamp(item.firstTextAt)} / {timestamp(item.lastTextAt)}</dd></div>
      <div><dt>收到的数据 / 事件</dt><dd>{item.receivedBytes.toLocaleString('zh-CN')} 字节 / {item.eventCount.toLocaleString('zh-CN')} 个事件</dd></div>
      <div><dt>最近事件类型</dt><dd><code>{item.lastEventType || '未收到可识别事件'}</code></dd></div>
      {item.endedAt && <div><dt>结束时间</dt><dd>{timestamp(item.endedAt)}</dd></div>}
    </dl><p className="small-muted">仅记录时间和数量，不展示答案片段或推理内容。</p></details>
  </div>;
}

export function AIRequestProgress() {
  const [items, setItems] = useState<ModelRequestProgress[]>([]), [error, setError] = useState('');
  useEffect(() => {
    let disposed = false, inFlight = false;
    let timer: number | undefined, controller: AbortController | null = null;
    const schedule = () => { if (!disposed && !document.hidden) timer = window.setTimeout(() => void poll(), 1500); };
    async function poll() {
      if (disposed || document.hidden || inFlight) return;
      inFlight = true;
      controller = new AbortController(); const requestController = controller;
      let timedOut = false;
      const deadline = window.setTimeout(() => { timedOut = true; requestController.abort(); }, 8000);
      try {
        const response = await fetch('/api/ai/progress', { signal: requestController.signal });
        if (!response.ok) throw new Error('状态暂时无法刷新');
        const result = await response.json() as { items: ModelRequestProgress[] };
        if (!Array.isArray(result.items)) throw new Error('状态暂时无法刷新');
        if (!disposed && !requestController.signal.aborted) { setItems(result.items.filter(active)); setError(''); }
      } catch {
        if (!disposed && !document.hidden && (timedOut || !requestController.signal.aborted)) setError('状态暂时无法刷新，以下是上次收到的进度；不能据此判断模型连接已中断。');
      } finally {
        window.clearTimeout(deadline); inFlight = false; controller = null; schedule();
      }
    }
    const visibilityChanged = () => {
      window.clearTimeout(timer);
      if (document.hidden) controller?.abort(); else void poll();
    };
    document.addEventListener('visibilitychange', visibilityChanged); void poll();
    return () => { disposed = true; window.clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibilityChanged); };
  }, []);
  if (!items.length) return null;
  return <section className="panel ai-request-progress" aria-label="AI 请求接收进度">
    <div className="ai-progress-heading"><h2><Activity size={17} />AI 请求接收进度</h2><span><LoaderCircle size={13} className="spin" />正在等待完整结果</span></div>
    {error && <p className="ai-progress-refresh-error" role="status">{error}</p>}
    {items.map(item => <RequestProgressSummary key={item.id} item={item} />)}
    <p className="ai-progress-footnote"><Clock3 size={12} />状态约每 1.5 秒刷新，查看进度不会再次调用 AI，也不会重置等待上限。</p>
  </section>;
}
