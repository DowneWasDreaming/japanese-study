import { useEffect, useState } from 'react';
import { BookMarked, LoaderCircle, RefreshCw } from 'lucide-react';
import { ReviewRatingActions, ReviewReading, reviewTime, reviewUncertain, type ReviewFrozenPoint, type ReviewPoint } from './ReviewPage';
import type { ReviewRequest } from './ReviewCapture';

export function ReviewExamFeedback({ examId, points, request, disabled }: { examId: string; points: ReviewFrozenPoint[]; request: ReviewRequest; disabled: boolean }) {
  const [items, setItems] = useState<Record<string, ReviewPoint | null>>({}), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true; setLoading(true);
    void Promise.all(points.map(async point => {
      try { const result = await request<{ item: ReviewPoint }>('/review/points/' + encodeURIComponent(point.id)); return [point.id, result.item] as const; }
      catch { return [point.id, null] as const; }
    })).then(result => { if (current) setItems(Object.fromEntries(result)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [points, request, revision]);
  if (!points.length) return null;
  return <section className="panel review-exam-feedback" aria-label="复习知识点掌握反馈"><div className="section-heading"><div><h2><BookMarked size={18} />这次复习，记住了多少？</h2><p>按知识点选择自己的掌握情况，独立于试卷分数。AI 判分不会自动改变你的复习安排。</p></div><button className="text-button" disabled={loading || disabled} onClick={() => setRevision(value => value + 1)}><RefreshCw size={13} />刷新进度</button></div>{loading ? <p className="small-muted"><LoaderCircle size={14} className="spin" />正在读取知识点进度…</p> : <div className="review-exam-feedback-list">{points.map(point => { const current = items[point.id]; return <article key={point.id}><div><h3 lang="ja">{point.title}</h3><ReviewReading reading={point.reading ?? current?.reading} note={point.reading === undefined && current?.reading ? '当前读法 · 旧试卷未保存读法' : undefined} />{point.meaning && <p>{point.meaning}</p>}<p>{point.focus}</p>{current?.verification && (reviewUncertain(current) || current.verification.outcome === 'corrected') && <div className="review-exam-current-warning"><p>以上为本卷生成时的知识点记录。{reviewUncertain(current) ? '该知识点现为待核实，暂不用于新复习或掌握自评。' : '该知识点之后已由 AI 核查纠正，后续复习使用更正后的内容。'}</p><a href={reviewUncertain(current) ? '#review?status=uncertain' : '#review?status=all'}>查看当前核查结果</a></div>}{current ? <small>{reviewUncertain(current) ? '待核实 · 不自动安排' : current.status === 'mastered' ? '已掌握，不自动安排' : current.status === 'paused' ? '当前已暂停，可在重点复习中重新加入' : '阶段 ' + current.stage + ' · 下次 ' + reviewTime(current.dueAt)}</small> : <small>这个知识点已移除，或暂时无法读取。原卷的知识点记录仍保留。</small>}</div>{current && <ReviewRatingActions point={current} request={request} examId={examId} disabled={disabled} onUpdated={value => setItems(existing => ({ ...existing, [point.id]: value }))} />}</article>; })}</div>}<a className="text-button" href="#review">管理重点复习知识点</a></section>;
}
