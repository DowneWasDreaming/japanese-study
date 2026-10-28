import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleHelp, Clipboard, Clock3, ExternalLink, History, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { RequestProgressSummary, requestTimeoutKind, requestTimeoutName, type ModelRequestProgress } from './AIRequestProgress';

type Operation = 'generate' | 'grade' | 'annotation' | 'review' | 'explain' | 'followup' | 'models' | 'connection' | 'auth';
type Category = 'network' | 'upstream' | 'validation' | 'permission' | 'quota' | 'interrupted' | 'local';
type ReviewEvidenceFailure = {
  version: 1; reason: 'quote_not_found' | 'missing_evidence' | 'ambiguous_match'; pointId: string;
  citationIndex: number | null; citationCount: number; sourceCount: number;
  quoteExcerpt: string; quoteLength: number; quoteTruncated: boolean;
  closestSource: { label: string; excerpt: string; length: number; truncated: boolean } | null;
  contextOnlyMatch?: 'explanation' | 'existing_knowledge' | 'existing_usages' | null;
};
export type AIDiagnostic = {
  id: string; createdAt: string; operation: Operation; category: Category; code: string; message: string;
  httpStatus: number | null; upstreamStatus: number | null; requestId: string | null; upstreamMessage: string | null;
  detail: string | null; examId: string | null; questionId: string | null; annotationIds: string[]; model: string | null;
  source: 'live' | 'legacy' | 'recovery'; stage: string | null; networkCode: string | null; responseId: string | null; reason?: string | null;
  progress?: ModelRequestProgress | null;
  evidenceFailure?: ReviewEvidenceFailure | null;
};
type DiagnosticList = { items: AIDiagnostic[]; total: number; page: number; pageSize: number };
const operationNames: Record<Operation, string> = { generate: 'AI 出题', grade: 'AI 评分', annotation: '标记词句解析', review: '复习知识点整理', explain: '词句与语法讲解', followup: 'AI 问答与追问', models: '获取模型', connection: '验证连接', auth: '账号授权' };
const categoryNames: Record<Category, string> = { network: '连接与超时', upstream: 'GPT 返回错误', validation: '结果校验', permission: '授权与权限', quota: '额度与限制', interrupted: '请求中断', local: '本地服务' };
const categoryDescriptions: Record<Category, string> = {
  network: '连接、传输或超时没有完成。查看网络错误码与阶段，确认是连接问题还是接收响应时中断。',
  upstream: '上游服务返回了错误。下方保留收到的状态码、错误消息与请求标识，便于核查。',
  validation: '模型响应未通过结构或内容校验。收到响应不代表结果已安全保存为完成，校验细节见下方。',
  permission: '账号登录或套餐权限未满足请求要求。查看错误码和上游消息，确认需要的授权。',
  quota: '记录涉及额度或使用限制。以具体错误码和上游消息为准；网站已取消本地请求次数限制。',
  interrupted: '请求在完成前中断。已有答案与完成的评分会保留，重新调用会另记一条失败记录。',
  local: '本地处理未完成。查看具体原因与处理阶段；网站已取消本地请求次数限制。',
};
const evidenceReasonNames: Record<ReviewEvidenceFailure['reason'], string> = {
  quote_not_found: '引文未在原文中找到', missing_evidence: '未提供原文依据', ambiguous_match: '格式对应存在歧义',
};
const evidenceReasonDescriptions: Record<ReviewEvidenceFailure['reason'], string> = {
  quote_not_found: '这段引文未能对应到允许使用的原文。格式兼容后仍无法匹配，不能将它保存为已核实的依据。',
  missing_evidence: 'AI 给出了明确核查结论，但没有提供可核对的原文依据，因此没有更新知识点。',
  ambiguous_match: '兼容格式差异后，引文对应到多种不同的原文片段，程序无法确定应保留哪一段，因此没有采用这次结果。',
};
const evidenceContextNames = { explanation: '题目解析', existing_knowledge: '已有知识点说明', existing_usages: '其他用法参考' };

function evidenceDiagnosticText(item: AIDiagnostic): string[] {
  if (item.code !== 'INVALID_REVIEW_EVIDENCE') return [];
  const failure = item.evidenceFailure;
  if (!failure) return ['原文引文校验：旧记录未保存未匹配引文，无法还原具体差异。'];
  return [
    '原文引文校验：' + evidenceReasonNames[failure.reason],
    '知识点 ID：' + failure.pointId,
    '引用条目：' + (failure.citationIndex === null ? '未提供' : '第 ' + failure.citationIndex + ' 条') + ' / 共 ' + failure.citationCount + ' 条',
    '匹配范围：' + failure.sourceCount + ' 处原文',
    ...(failure.quoteExcerpt ? ['未匹配引文' + (failure.quoteTruncated ? '（节选）' : '') + '：', failure.quoteExcerpt, '完整引文长度：' + failure.quoteLength] : []),
    ...(failure.closestSource ? ['原文对照片段：' + failure.closestSource.label + (failure.closestSource.truncated ? '（节选）' : ''), failure.closestSource.excerpt, '原文完整长度：' + failure.closestSource.length] : []),
    ...(failure.contextOnlyMatch ? ['引文仅在以下参考内容中找到：' + evidenceContextNames[failure.contextOnlyMatch]] : []),
  ];
}

function EvidenceFailureDetails({ item }: { item: AIDiagnostic }) {
  const failure = item.evidenceFailure;
  return <section className="diagnostic-evidence" aria-label="原文引文校验详情">
    <h3><ShieldCheck size={15} />原文引文校验</h3>
    <p className="diagnostic-evidence-intro">模型已返回核查内容，这次结果在本机检查引用时被拦住。原文、已有知识点及复习进度保留。</p>
    {failure ? <>
      <div className="diagnostic-evidence-status"><strong>{evidenceReasonNames[failure.reason]}</strong><span>{failure.citationIndex === null ? '未提供可核对的引文' : '第 ' + failure.citationIndex + ' 条引文'} · 共 {failure.citationCount} 条 · 检索 {failure.sourceCount} 处原文</span></div>
      <p className="diagnostic-evidence-reason">{evidenceReasonDescriptions[failure.reason]}</p>
      {failure.contextOnlyMatch && <p className="diagnostic-evidence-context">这段文字只在“{evidenceContextNames[failure.contextOnlyMatch]}”中找到。该参考内容不能代替题干、阅读材料或选项中的原文证据。</p>}
      {(failure.quoteExcerpt || failure.closestSource) && <div className="diagnostic-evidence-grid">
        {failure.quoteExcerpt && <div><h4>AI 引用的文字</h4><pre lang="ja">{failure.quoteExcerpt}</pre><p>{failure.quoteTruncated ? '此处为节选；完整引文长度 ' : '引文长度 '}{failure.quoteLength}</p></div>}
        {failure.closestSource && <div><h4>原文对照片段 · {failure.closestSource.label}</h4><pre lang="ja">{failure.closestSource.excerpt}</pre><p>{failure.closestSource.truncated ? '此处为节选；原文完整长度 ' : '原文长度 '}{failure.closestSource.length}。对照片段用于定位，不表示引文已匹配。</p></div>}
      </div>}
      <p className="diagnostic-evidence-note">引号、空白等可还原的格式差异会先兼容。补上填空答案、改写词形、拼接句子或新写例句，仍不能当作原文引用；此说明不代表已确认本次具体属于其中哪一种。</p>
    </> : <p className="diagnostic-evidence-legacy">旧记录未保存未匹配引文，无法还原具体差异。这里不会补造当时的 AI 返回文字；后续失败会保留可查看的引文与对照片段。</p>}
  </section>;
}

export function diagnosticsHref(examId?: string, operation?: string) {
  const params = new URLSearchParams({ ...(examId ? { examId } : {}), ...(operation ? { operation } : {}) });
  return '#diagnostics' + (params.size ? '?' + params.toString() : '');
}

export function DiagnosticsLink({ examId, operation, children }: { examId?: string; operation?: string; children?: ReactNode }) {
  return <a className="text-button diagnostics-link" href={diagnosticsHref(examId, operation)}><History size={13} />{children || '查看失败详情与历史'}<ArrowRight size={12} /></a>;
}

function localTime(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short' }).format(parsed);
}

function diagnosticText(item: AIDiagnostic) {
  return [
    '木漏日 AI 失败诊断（已脱敏）',
    '记录 ID：' + item.id, '时间：' + localTime(item.createdAt) + ' (' + item.createdAt + ')',
    '操作：' + (operationNames[item.operation] || item.operation), '分类：' + (categoryNames[item.category] || item.category),
    '错误码：' + item.code, '具体原因：' + item.message,
    ...evidenceDiagnosticText(item),
    ...(item.code === 'MODEL_REQUEST_TIMEOUT' ? ['超时类型：' + requestTimeoutName(item.progress)] : []),
    '处理阶段：' + (item.stage || '未记录'), '本地错误状态（内部状态码）：' + (item.httpStatus ?? '未记录'),
    'GPT / 上游 HTTP 状态：' + (item.upstreamStatus ?? '未记录'), '网络错误码：' + (item.networkCode || '未记录'),
    'GPT / 上游错误消息（已脱敏）：' + (item.upstreamMessage || '未记录到上游错误消息'),
    '详细原因：' + (item.detail || item.reason || '未记录'), 'Request ID：' + (item.requestId || '未返回或未记录'),
    'Response ID：' + (item.responseId || '未返回或未记录'), '模型：' + (item.model || '未记录'),
    '关联试卷：' + (item.examId || '无'), '关联题目：' + (item.questionId || '无'),
    '关联标记：' + (item.annotationIds.length ? item.annotationIds.join(', ') : '无'),
    '记录来源：' + (item.source === 'legacy' ? '升级前最后一次错误，完整历史不可追溯' : item.source === 'recovery' ? '启动时发现未完成请求并恢复记录' : '本次调用失败记录'),
    ...(item.progress ? ['接收进度快照（时间、数量与状态，不含正文）：', JSON.stringify(item.progress, null, 2)] : []),
  ].join('\n');
}

function DiagnosticCard({ item, notify }: { item: AIDiagnostic; notify: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  const timeout = item.code === 'MODEL_REQUEST_TIMEOUT', legacyTimeout = !item.progress && item.code === 'MODEL_STREAM_INTERRUPTED' && item.networkCode === 'TimeoutError';
  const timeoutKind = requestTimeoutKind(item.progress);
  const evidenceError = item.code === 'INVALID_REVIEW_EVIDENCE';
  const categoryLabel = evidenceError ? '原文引用校验' : timeout ? requestTimeoutName(item.progress) : legacyTimeout ? '等待超时 · 旧记录' : categoryNames[item.category] || item.category;
  const timeoutExplanation = timeoutKind === 'response_timeout' ? '达到本次首次服务响应等待上限，尚未收到 HTTP 响应。此阶段无法确定远端是否开始处理。' : timeoutKind === 'stream_idle_timeout' ? '接收过程中连续没有新的网络数据，达到当时的无数据等待上限。请结合最后收到数据与正文的时间核查；正文停更本身不等于断网。' : '本次达到请求当时的总等待上限。结合最后一段正文的接收时间，判断结束前是否仍在收到内容；超时本身不代表断网。';
  async function copy() {
    try { await navigator.clipboard.writeText(diagnosticText(item)); setCopied(true); window.setTimeout(() => setCopied(false), 2500); notify('已复制脱敏诊断文本。'); }
    catch { notify('浏览器没有允许复制。可以展开详情，手动选择并复制内容。'); }
  }
  return <article className={'panel diagnostic-card category-' + item.category}>
    <div className="diagnostic-card-meta"><span className="pill">{operationNames[item.operation] || item.operation}</span><span className="pill diagnostic-category">{categoryLabel}</span><time dateTime={item.createdAt}><Clock3 size={12} />{localTime(item.createdAt)}</time></div>
    <h2>{item.message}</h2><div className="diagnostic-code"><span>错误码</span><code>{item.code}</code>{item.upstreamStatus != null && <span>上游 HTTP {item.upstreamStatus}</span>}</div>
    {evidenceError && <EvidenceFailureDetails item={item} />}
    {item.progress ? <section className="diagnostic-progress" aria-label="失败时的请求接收进度"><h3>失败时的请求接收进度</h3><RequestProgressSummary item={item.progress} frozen /></section> : /MODEL_(?:STREAM|REQUEST|RESPONSE)|OPENAI_(?:NETWORK|RESPONSE)/.test(item.code) && <p className="diagnostic-legacy">旧记录未采集接收进度，无法回溯是否持续输出。保留的超时原因仍可在详情中查看。</p>}
    {item.code === 'LOCAL_REQUEST_LIMIT' && <p className="diagnostic-explanation"><strong>旧版本地次数限制（现已取消）。</strong>这条错误由网站本地产生，不是 GPT 返回的额度错误，也不能据此判断官方额度已用完。</p>}
    {!evidenceError && (item.source === 'legacy' ? <p className="diagnostic-legacy"><CircleHelp size={14} />升级前最后一次错误，完整历史不可追溯。这条记录只能反映当时最后保存的原因，无法补出此前每次重试的详情。</p> : <p className="diagnostic-explanation">{timeout ? timeoutExplanation : legacyTimeout ? '本次记录为等待超时，超时本身不代表断网。旧记录没有接收时间线，无法判断结束前是否仍在收到内容。' : categoryDescriptions[item.category] || '展开详情查看此调用保存的具体原因。'}</p>)}
    <details className="diagnostic-details"><summary>查看具体错误与 GPT 返回信息</summary><div className="diagnostic-detail-body">
      <dl className="diagnostic-facts"><div><dt>发生时间</dt><dd>{localTime(item.createdAt)}<small>{item.createdAt}</small></dd></div><div><dt>处理阶段</dt><dd>{item.stage || '未记录'}</dd></div><div><dt>本地错误状态（内部状态码）</dt><dd>{item.httpStatus ?? '未记录'}</dd></div><div><dt>GPT / 上游 HTTP 状态</dt><dd>{item.upstreamStatus ?? '未返回或未记录'}</dd></div><div><dt>网络错误码</dt><dd><code>{item.networkCode || '未记录'}</code></dd></div><div><dt>使用模型</dt><dd>{item.model || '未记录'}</dd></div><div><dt>Request ID</dt><dd><code>{item.requestId || '未返回或未记录'}</code></dd></div><div><dt>Response ID</dt><dd><code>{item.responseId || '未返回或未记录'}</code></dd></div></dl>
      <section className="diagnostic-message"><h3>GPT / 上游错误消息（已脱敏）</h3>{item.upstreamMessage ? <pre>{item.upstreamMessage}</pre> : evidenceError ? <p>这次错误发生在模型返回核查内容之后，由网站的原文引用校验产生。本地错误状态描述网站拒绝采用结果，不能当作 GPT / 上游 HTTP 错误。</p> : item.upstreamStatus !== null && item.upstreamStatus >= 200 && item.upstreamStatus < 300 ? <p>未收到明确上游错误消息。HTTP {item.upstreamStatus} 仅表示响应开始，不代表生成完成；以本地原因和接收记录判断。</p> : <p>未记录到上游错误消息，不能据此推断 GPT 已收到请求。请结合分类、处理阶段和本地原因查看。</p>}</section>
      {(item.detail || item.reason) && <section className="diagnostic-message"><h3>详细原因 / 校验信息</h3><pre>{[item.detail, item.reason && item.reason !== item.detail ? item.reason : null].filter(Boolean).join('\n')}</pre></section>}
      <dl className="diagnostic-facts diagnostic-identifiers"><div><dt>记录 ID</dt><dd><code>{item.id}</code></dd></div>{item.examId && <div><dt>关联试卷 ID</dt><dd><code>{item.examId}</code></dd></div>}{item.questionId && <div><dt>关联题目 ID</dt><dd><code>{item.questionId}</code></dd></div>}{item.annotationIds.length > 0 && <div><dt>关联标记 ID</dt><dd>{item.annotationIds.map(id => <code key={id}>{id}</code>)}</dd></div>}</dl>
      {item.source === 'recovery' && <p className="small-muted">这条记录由服务启动恢复产生：上次请求未留下完成结果，无法补造未收到的 GPT 错误消息。</p>}
    </div></details>
    <div className="diagnostic-card-actions"><button className="button secondary small" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Clipboard size={14} />}{copied ? '已复制' : '复制脱敏诊断'}</button>{item.examId && <a className="text-button" href={'#exam/' + encodeURIComponent(item.examId)}>打开相关试卷<ArrowRight size={13} /></a>}</div>
  </article>;
}

export function AIDiagnosticsPage({ route, notify }: { route: string; notify: (text: string) => void }) {
  const initial = new URLSearchParams(route.split('?')[1] || '');
  const [examId, setExamId] = useState(initial.get('examId') || '');
  const [operation, setOperation] = useState(initial.get('operation') || '');
  const [category, setCategory] = useState(initial.get('category') || '');
  const [page, setPage] = useState(1), [revision, setRevision] = useState(0);
  const [data, setData] = useState<DiagnosticList | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setData(null);
    const query = new URLSearchParams({ page: String(page), pageSize: '20', ...(examId ? { examId } : {}), ...(operation ? { operation } : {}), ...(category ? { category } : {}) });
    void fetch('/api/diagnostics?' + query, { signal: controller.signal }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || '读取 AI 失败记录没有完成。');
      if (!controller.signal.aborted) setData(result as DiagnosticList);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取失败记录没有完成。'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [examId, operation, category, page, revision]);
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : page;
  return <><a className="back-link" href={examId ? '#exam/' + encodeURIComponent(examId) : '#settings'}><ArrowLeft size={15} />{examId ? '返回相关试卷' : '返回连接与设置'}</a>
    <div className="page-heading"><div><div className="eyebrow">EVERY ATTEMPT HAS A RECORD</div><h1>AI 失败记录<span className="heading-dot">。</span></h1><p>查看每次失败的原因、时间、网络状态与 GPT 返回信息。重试会新增记录，不会覆盖之前的失败。</p></div><button className="button secondary small" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} className={loading ? 'spin' : ''} />刷新记录</button></div>
    <div className="notice-box diagnostics-intro"><ShieldCheck size={18} /><div><strong>本地请求次数限制已取消</strong><p>调用次数仅作统计；OpenAI 官方额度、权限和速率限制仍然适用。错误消息会脱敏保存，不包含登录凭据。升级前只能保留当时最后一次错误，不能还原此前的完整历史。</p></div></div>
    <section className="panel diagnostics-filters" aria-label="失败记录筛选"><label className="form-field">操作类型<select value={operation} onChange={event => { setOperation(event.target.value); setPage(1); }}><option value="">全部操作</option>{Object.entries(operationNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="form-field">错误分类<select value={category} onChange={event => { setCategory(event.target.value); setPage(1); }}><option value="">全部分类</option>{Object.entries(categoryNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className="diagnostics-scope"><span>{examId ? '仅显示这份试卷的记录' : '显示全部 AI 失败记录'}</span>{examId && <button className="text-button" onClick={() => { setExamId(''); setPage(1); }}>查看全部试卷与操作<ArrowRight size={12} /></button>}<small>时间按本机时区显示：{timezone}</small></div></section>
    {error && <div className="error-box" role="alert"><CircleHelp size={19} /><div><strong>失败记录暂时无法读取</strong><p>{error}</p><button className="text-button" onClick={() => setRevision(value => value + 1)}>重新读取<RefreshCw size={13} /></button></div></div>}
    {loading ? <div className="state-box" role="status"><LoaderCircle size={22} className="spin" /><p>正在读取 AI 失败记录…</p></div> : data && <><div className="diagnostics-total"><span>共 {data.total} 条失败记录 · 最新发生在前</span><span>第 {data.page} / {totalPages} 页</span></div>{data.items.length ? <div className="diagnostics-list">{data.items.map(item => <DiagnosticCard item={item} key={item.id} notify={notify} />)}</div> : <div className="panel state-box empty-state"><History size={28} /><h3>当前条件下没有失败记录</h3><p>新的 AI 调用若失败，会在这里留下独立记录。可以调整筛选条件或稍后刷新查看。</p></div>}<nav className="diagnostics-pagination" aria-label="失败记录分页"><button className="button secondary small" disabled={page <= 1} onClick={() => { setPage(value => Math.max(1, value - 1)); window.scrollTo({ top: 0 }); }}><ArrowLeft size={14} />上一页</button><span>每页 {data.pageSize} 条</span><button className="button secondary small" disabled={page >= totalPages} onClick={() => { setPage(value => value + 1); window.scrollTo({ top: 0 }); }}>下一页<ArrowRight size={14} /></button></nav></>}
    <p className="small-muted diagnostics-official">当前外部模型调用使用 Continue with ChatGPT 授权的 Codex / ChatGPT Work 额度，不能选择 ChatGPT 普通对话额度。官方用量与费用以账号页面为准。<a className="text-button" href="https://learn.chatgpt.com/docs/sign-in-with-chatgpt" target="_blank" rel="noreferrer">查看官方说明<ExternalLink size={12} /></a></p>
  </>;
}
