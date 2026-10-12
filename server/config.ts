import { isAbsolute, relative, resolve, sep } from 'node:path';
export function getConfig() {
  const port = Number(process.env.PORT || 3210);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 应为 1024 至 65535 的整数');
  const dataDir = resolve(process.env.STUDY_DATA_DIR || '.local/data');
  const credentialDir = resolve(process.env.STUDY_CREDENTIAL_DIR || '.local/credentials');
  const dataComparison = process.platform === 'win32' ? dataDir.toLowerCase() : dataDir;
  const credentialComparison = process.platform === 'win32' ? credentialDir.toLowerCase() : credentialDir;
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
  };
  if (contains(dataComparison, credentialComparison) || contains(credentialComparison, dataComparison)) {
    throw new Error('凭据目录必须与学习数据目录分开');
  }
  return { port, host: '127.0.0.1', dataDir, credentialDir, dbPath: resolve(dataDir, 'study.sqlite'), origin: `http://127.0.0.1:${port}` };
}
