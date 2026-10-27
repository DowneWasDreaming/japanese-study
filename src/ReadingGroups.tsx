import { BookOpen } from 'lucide-react';
import { AnnotationQuickAdd, MarkableText } from './ExamAnnotations';

export type ReadingGroup = { id: string; title: string; kind: 'short' | 'medium' | 'long' | 'integrated' | 'information' };
export type GroupableQuestion = { id: string; passage?: string; readingGroup?: ReadingGroup };
export const readingKindNames: Record<ReadingGroup['kind'], string> = { short: '短篇理解', medium: '中篇理解', long: '长篇理解', integrated: '综合阅读', information: '信息检索' };

/** Keep ordinary questions and legacy papers unchanged; a group is one reading unit. */
export function questionUnits<T extends GroupableQuestion>(questions: T[]) {
  const units: { key: string; questions: T[]; indexes: number[]; readingGroup?: ReadingGroup }[] = [];
  questions.forEach((question, index) => {
    const previous = units.at(-1);
    if (question.readingGroup && previous?.readingGroup?.id === question.readingGroup.id) {
      previous.questions.push(question); previous.indexes.push(index);
    } else units.push({ key: question.readingGroup?.id || question.id, questions: [question], indexes: [index], ...(question.readingGroup ? { readingGroup: question.readingGroup } : {}) });
  });
  return units;
}

export function ReadingGroupMaterial({ question, count }: { question: GroupableQuestion; count: number }) {
  const group = question.readingGroup;
  if (!group) return null;
  return <section id={'reading-material-' + group.id} className="reading-group-material" aria-label={'共享阅读材料：' + group.title} data-reading-group={group.id}>
    <div className="reading-group-heading"><span className="pill green"><BookOpen size={13} />{readingKindNames[group.kind]}</span><span>共 {count} 道小题 · 共用一份材料</span></div>
    <h2 lang="ja">{group.title}</h2>
    <p className="small-muted">阅读材料后完成下面的小题。材料中的标记会保留在本题组，题干和选项也可以分别标记、解析或加入重点复习。</p>
    <AnnotationQuickAdd questionId={question.id} />
    <div className="passage reading-group-passage" lang="ja"><MarkableText questionId={question.id} source="passage" text={question.passage || ''} /></div>
  </section>;
}
