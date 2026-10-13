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
