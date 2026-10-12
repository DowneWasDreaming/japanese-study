import { getConfig } from '../server/config.js';
import { openDatabase } from '../server/db.js';
import { seedDatabase } from '../server/seed.js';
const config = getConfig();
const db = openDatabase(config.dbPath);
seedDatabase(db); db.close();
console.log(`SQLite 迁移与原创内容初始化完成：${config.dbPath}。已有学习记录保留。`);
