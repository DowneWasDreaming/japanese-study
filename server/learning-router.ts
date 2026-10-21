import { Router, type Request } from 'express';
import { z } from 'zod';
import { LearningError, LearningService } from './learning.js';
import { DataManagementService, knowledgePoints } from './learning-management.js';
import type { DatabaseSync } from 'node:sqlite';

const text=z.string().min(1).max(20_000);const id=z.string().min(1).max(200);
const queryString=(req:Request,key:string)=>typeof req.query[key]==='string'?String(req.query[key]):undefined;
const routeId=(req:Request)=>String(req.params.id);
export function createLearningRouter(service:LearningService, db:DatabaseSync, additionalBusy:()=>boolean=()=>false):Router {
  const router=Router();
  const busy=()=>service.isBusy()||additionalBusy();
  const data=new DataManagementService(db,{isBusy:busy,backup:()=>service.createDeletionBackup()});
  router.get('/diagnostics',(req,res)=>res.json(service.diagnostics.list(req.query)));
  router.get('/review/points',(req,res)=>res.json(service.reviews.list(req.query)));
  router.get('/review/points/:pointId',(req,res)=>res.json({item:service.reviews.get(String(req.params.pointId))}));
  router.post('/review/points',(req,res)=>{
    if(additionalBusy())throw new LearningError('正在验证连接，请完成后再保存重点复习。','REVIEW_BUSY',409);
    res.json(service.reviews.add(req.body));
  });
  router.post('/review/points/:pointId/normalize',async(req,res)=>{
    z.object({}).strict().parse(req.body);
    if(additionalBusy())throw new LearningError('正在验证连接，请完成后再整理知识点。','REVIEW_BUSY',409);
    res.json(await service.reviews.normalize(String(req.params.pointId)));
  });
  router.post('/review/points/:pointId/confirm',(req,res)=>{
    if(additionalBusy())throw new LearningError('正在验证连接，请完成后再确认知识点。','REVIEW_BUSY',409);
    res.json(service.reviews.confirm(String(req.params.pointId),req.body));
  });
  router.put('/review/points/:pointId',(req,res)=>{
    if(additionalBusy())throw new LearningError('正在验证连接，请完成后再修改知识点。','REVIEW_BUSY',409);
    res.json(service.reviews.update(String(req.params.pointId),req.body));
  });
  router.post('/review/points/:pointId/rate',(req,res)=>{
    if(additionalBusy())throw new LearningError('正在验证连接，请完成后再记录复习反馈。','REVIEW_BUSY',409);
    res.json(service.reviews.rate(String(req.params.pointId),req.body));
  });
  router.delete('/review/points/:pointId',(req,res)=>{
    if(busy())throw new LearningError('有学习请求正在进行，请完成后再删除知识点。','REVIEW_BUSY',409);
    const pointId=String(req.params.pointId);service.reviews.get(pointId);
    const beforeDeleteBackup=service.createDeletionBackup();
    res.json({...service.reviews.remove(pointId),beforeDeleteBackup});
  });
  router.post('/review/exams',async(req,res)=>{
    if(additionalBusy())throw new LearningError('正在验证连接，请完成后再生成复习卷。','REVIEW_BUSY',409);
    res.json(await service.createReviewExam(req.body));
  });
  router.get('/dashboard',(_req,res)=>res.json(service.dashboard()));
  router.get('/knowledge',(req,res)=>res.json(knowledgePoints(db,{level:queryString(req,'level'),q:queryString(req,'q')})));
  router.get('/data/summary',(_req,res)=>res.json(data.summary()));
  router.post('/data/delete-preview',(req,res)=>res.json(data.preview(req.body)));
  router.delete('/data',(req,res)=>res.json(data.remove(req.body)));
  router.get('/content',(req,res)=>res.json(service.content({level:queryString(req,'level'),kind:queryString(req,'kind'),q:queryString(req,'q')})));
  router.get('/saved',(req,res)=>res.json(service.saved({type:queryString(req,'type'),level:queryString(req,'level'),q:queryString(req,'q')})));
  router.post('/saved',(req,res)=>{const body=z.object({contentId:id,type:z.enum(['word','grammar','favorite'])}).strict().parse(req.body);res.json(service.toggleSaved(body.contentId,body.type));});
  router.get('/mistakes',(req,res)=>res.json(service.mistakes({level:queryString(req,'level'),type:queryString(req,'type'),knowledgePoint:queryString(req,'knowledgePoint')||queryString(req,'focus'),q:queryString(req,'q')})));
  router.get('/exams',(_req,res)=>res.json(service.listExams()));
  router.post('/exams',async(req,res)=>res.json(await service.createExam(req.body)));
  router.get('/exams/:id',(req,res)=>res.json(service.getExam(routeId(req))));
  router.get('/exams/:id/discussion',(req,res)=>{
    const query=z.object({questionId:id}).strict().parse(req.query);
    res.json(service.discussions.list(routeId(req),query.questionId));
  });
  router.post('/exams/:id/discussion',async(req,res)=>{
    if(additionalBusy())throw new LearningError('正在验证连接，请完成后再提问。','EXAM_QA_BUSY',409);
    res.json(await service.discussions.ask(routeId(req),req.body));
  });
  router.post('/exams/:id/discussion/:turnId/reply',async(req,res)=>{
    z.object({}).strict().parse(req.body);
    if(additionalBusy())throw new LearningError('正在验证连接，请完成后再请求回答。','EXAM_QA_BUSY',409);
    res.json(await service.discussions.reply(routeId(req),String(req.params.turnId)));
  });
  router.delete('/exams/:id/discussion/:turnId',(req,res)=>{
    if(additionalBusy())throw new LearningError('正在验证连接，请完成后再调整本题问答。','EXAM_QA_BUSY',409);
    res.json(service.discussions.remove(routeId(req),String(req.params.turnId)));
  });
  router.get('/exams/:id/annotations',(req,res)=>res.json(service.annotations.list(routeId(req))));
  router.post('/exams/:id/annotations',(req,res)=>{
    if(additionalBusy())throw new LearningError('正在验证连接，请完成后再保存标记。','ANNOTATIONS_BUSY',409);
    res.json(service.annotations.add(routeId(req),req.body));
  });
  router.delete('/exams/:id/annotations/:annotationId',(req,res)=>{
    if(additionalBusy())throw new LearningError('正在验证连接，请完成后再调整标记。','ANNOTATIONS_BUSY',409);
    res.json(service.annotations.remove(routeId(req),String(req.params.annotationId)));
  });
  router.post('/exams/:id/annotations/explain',async(req,res)=>{
    const options=z.object({retryFailedOnly:z.boolean().optional()}).strict().parse(req.body);
    if(additionalBusy())throw new LearningError('正在验证连接，请完成后再解析标记。','ANNOTATIONS_BUSY',409);
    res.json(await service.annotations.explain(routeId(req),options));
  });
  router.put('/exams/:id/grading-mode',(req,res)=>{
    if(busy())throw new LearningError('有出题、学习或评分请求正在进行，请完成后再修改判卷方式。','GRADING_MODE_BUSY',409);
    res.json(service.setGradingMode(routeId(req),req.body));
  });
  router.put('/exams/:id/answers',(req,res)=>{const body=z.object({answers:z.record(z.string().max(20_000)).refine(v=>Object.keys(v).length<=50)}).strict().parse(req.body);res.json(service.saveAnswers(routeId(req),body.answers));});
  router.post('/exams/:id/feedback',async(req,res)=>{const body=z.object({questionId:id}).strict().parse(req.body);res.json(await service.feedback(routeId(req),body.questionId));});
  router.post('/exams/:id/submit',async(req,res)=>res.json(await service.submit(routeId(req))));
  router.post('/exams/:id/retry',async(req,res)=>res.json(await service.submit(routeId(req),true)));
  router.post('/exams/:id/repeat',(req,res)=>res.json(service.repeat(routeId(req))));
  router.post('/reports',(req,res)=>{const body=z.object({examId:id,questionId:id,note:text}).strict().parse(req.body);res.json(service.report(body.examId,body.questionId,body.note));});
  router.post('/explain',async(req,res)=>{const body=z.object({kind:z.enum(['word','grammar','sentence']),text,level:z.enum(['KANA','N5','N4','N3','N2','N1']).default('N5'),regenerate:z.boolean().optional(),conversationId:id.optional()}).strict().parse(req.body);res.json(await service.explain(body));});
  router.get('/conversations',(_req,res)=>res.json(service.conversations()));
  router.get('/conversations/:id',(req,res)=>res.json(service.conversation(routeId(req))));
  router.post('/conversations/:id/messages',async(req,res)=>{const body=z.object({text}).strict().parse(req.body);res.json(await service.followup(routeId(req),body.text));});
  router.get('/backup',(_req,res)=>{res.setHeader('Content-Disposition',`attachment; filename="komorebi-learning-${new Date().toISOString().slice(0,10)}.json"`);res.json(service.backup());});
  router.post('/restore',(req,res)=>{
    if(busy())throw new LearningError('有出题、学习或评分请求正在进行，请完成后再恢复数据。','RESTORE_BUSY',409);
    res.json(service.restore(req.body));
  });
  return router;
}
