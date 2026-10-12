import type { RequestHandler, ErrorRequestHandler } from 'express';
export function localBoundary(origin: string): RequestHandler {
  const expected = new URL(origin).host;
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers.host !== expected) {
      res.status(403).json({ error: { code: 'INVALID_HOST', message: '请通过本机 127.0.0.1 地址访问。' } }); return;
    }
    if (req.path.startsWith('/api') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers.origin !== origin || req.headers['x-study-client'] !== 'local-web') {
        res.status(403).json({ error: { code: 'INVALID_ORIGIN', message: '此操作只允许来自本机学习页面。' } }); return;
      }
    }
    next();
  };
}
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const status = Number(error.status || error.statusCode || (error.name === 'ZodError' ? 400 : 500));
  const safe = error.publicMessage || error.message;
  // 仅返回已明确标记的业务错误；不暴露堆栈、上游响应或认证凭据。
  res.status(status >= 400 && status <= 599 ? status : 500).json({ error: {
    code: typeof error.code === 'string' ? error.code : 'REQUEST_FAILED',
    message: error.name === 'ZodError' ? '请求数据格式不正确，请检查输入。' : (safe && !/Bearer |access_token|refresh_token|id_token|eyJ[A-Za-z0-9_-]{20}/.test(safe) ? safe : '请求失败，请检查输入或服务状态。')
  } });
};
