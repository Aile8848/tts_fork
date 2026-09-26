#!/usr/bin/env node
/**
 * 汉字拼音音频批量生成脚本
 * ------------------------------------------------------------------
 * 读取 zku-data.js 全部汉字 → 调用 Edge TTS Worker → 生成 audio/<汉字>.mp3
 *
 * 用法：
 *   node tools/gen-audio.js --dry          # 试运行，看会生成多少个
 *   node tools/gen-audio.js --grade 1      # 只生成一年级（先测这个）
 *   node tools/gen-audio.js                # 全量生成（自动跳过已存在）
 *   node tools/gen-audio.js --force        # 强制全部重新生成
 * ------------------------------------------------------------------
 */

'use strict';

const fs   = require('fs');
const path = require('path');

/* ============ ① 配置区 ============ */
const CONFIG = {
  /* Worker 地址：部署后填你的自定义域名（大陆可访问，别用 *.workers.dev） */
  WORKER_URL: 'https://tts.leci04.top',
  /* 若你的 Worker 加了鉴权，填上；官方原版无需鉴权则留空字符串 */
  GAME_KEY: '',
  /* 鉴权头名称（配合 GAME_KEY 用） */
  KEY_HEADER: 'X-Game-Key',

  /* 音色：晓晓（温柔女声）*/
  VOICE: 'zh-CN-XiaoxiaoNeural',
  /* 语速：0.5–2.0。0.9 稍慢，适合小学生 */
  SPEED: 0.9,
  /* 音调：字符串 "-50" ~ "50" */
  PITCH: '0',
  /* 风格 */
  STYLE: 'general',

  /* 输出目录（相对脚本运行目录） */
  OUT_DIR: 'audio',
  /* 字库文件（相对脚本运行目录，即项目根） */
  ZKU_PATH: 'zku-data.js',

  /* 并发数：官方 Worker 无速率限制，但微软端可能限流，建议 3~6 */
  CONCURRENCY: 4,
  /* 单请求超时（毫秒） */
  TIMEOUT: 25000,
  /* 失败重试次数 */
  RETRY: 3,
  /* 重试基础间隔（毫秒，会递增） */
  RETRY_DELAY: 1200
};

/* ============ ② 命令行参数 ============ */
const ARGV = process.argv.slice(2);
const OPT = {
  force: ARGV.includes('--force'),
  dry:   ARGV.includes('--dry'),
  grade: (() => {
    const i = ARGV.indexOf('--grade');
    return i >= 0 ? ARGV[i + 1] : null;
  })()
};

/* ============ ③ 控制台着色 ============ */
const C = { r:'\x1b[0m', red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m',
            blue:'\x1b[34m', gray:'\x1b[90m', bold:'\x1b[1m' };
const log = (...a) => console.log(...a);
const ok   = m => log(C.green + '  ✓ ' + C.r + m);
const warn = m => log(C.yellow + '  ⚠ ' + C.r + m);
const err  = m => log(C.red + '  ✗ ' + C.r + m);
const info = m => log(C.blue + '  ℹ ' + C.r + m);
const dim  = m => log(C.gray + '    ' + m + C.r);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============ ④ 解析字库 ============ */
function loadZKU(file){
  const code = fs.readFileSync(file, 'utf8');
  let ZKU;
  try{
    /* zku-data.js 里通常是 `var ZKU = {...}` 或 `const ZKU = {...}` */
    const fn = new Function('window', 'globalThis', code + '\n;return ZKU;');
    ZKU = fn({}, {});
  }catch(e){
    throw new Error('解析 zku-data.js 失败：' + e.message);
  }
  if(!ZKU || typeof ZKU !== 'object'){
    throw new Error('zku-data.js 中未找到 ZKU 对象');
  }
  return ZKU;
}

/* 合法汉字：基本区 + 扩展A区 */
function isSafeChar(ch){
  const cps = Array.from(ch || '');
  if(cps.length !== 1) return false;
  const cp = ch.codePointAt(0);
  return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF);
}

function collectChars(ZKU){
  const map = new Map();       /* 字 → {pinyin, word, grades:Set} */
  const unsafe = [];
  for(const g of Object.keys(ZKU)){
    if(OPT.grade && g !== OPT.grade) continue;
    for(const row of (ZKU[g] || [])){
      if(!Array.isArray(row) || !row[0]) continue;
      const [ch, py, wd] = row;
      for(const one of Array.from(String(ch))){
        if(!isSafeChar(one)){
          unsafe.push({ ch: one, grade: g });
          continue;
        }
        if(!map.has(one)) map.set(one, { pinyin: py || '', word: wd || '', grades: new Set() });
        map.get(one).grades.add(g);
      }
    }
  }
  return { map, unsafe };
}

/* ============ ⑤ 调 Worker ============ */
async function fetchAudio(text){
  const url = CONFIG.WORKER_URL.replace(/\/+$/, '') + '/v1/audio/speech';
  const headers = { 'Content-Type': 'application/json' };
  if(CONFIG.GAME_KEY) headers[CONFIG.KEY_HEADER] = CONFIG.GAME_KEY;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.TIMEOUT);
  try{
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: text,
        voice: CONFIG.VOICE,
        speed: CONFIG.SPEED,
        pitch: CONFIG.PITCH,
        style: CONFIG.STYLE
      }),
      signal: ctrl.signal
    });
    if(!res.ok){
      const t = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + ' ' + t.slice(0, 120));
    }
    const buf = Buffer.from(await res.arrayBuffer());
    /* mp3 至少应有几百字节；太小说明异常 */
    if(buf.length < 300) throw new Error('返回数据过小（' + buf.length + ' 字节）');
    return buf;
  }finally{
    clearTimeout(timer);
  }
}

async function generateWithRetry(ch){
  let lastErr;
  for(let i = 1; i <= CONFIG.RETRY; i++){
    try{ return await fetchAudio(ch); }
    catch(e){
      lastErr = e;
      if(i < CONFIG.RETRY){ await sleep(CONFIG.RETRY_DELAY * i); }
    }
  }
  throw lastErr;
}

/* ============ ⑥ 并发池 ============ */
async function runPool(items, worker, concurrency){
  let idx = 0;
  const n = Math.min(concurrency, items.length);
  async function runner(){
    while(true){
      const my = idx++;
      if(my >= items.length) break;
      await worker(items[my]);
    }
  }
  await Promise.all(Array.from({ length: n }, runner));
}

/* ============ ⑦ 主流程 ============ */
async function main(){
  log('');
  log(C.bold + '🔊 汉字拼音音频批量生成' + C.r);
  log(C.gray + '─'.repeat(58) + C.r);

  /* --- 字库 --- */
  const zkuPath = path.resolve(process.cwd(), CONFIG.ZKU_PATH);
  if(!fs.existsSync(zkuPath)){ err('找不到字库：' + zkuPath); process.exit(1); }
  info('字库：' + CONFIG.ZKU_PATH);

  let ZKU;
  try{ ZKU = loadZKU(zkuPath); }
  catch(e){ err(e.message); process.exit(1); }

  const { map, unsafe } = collectChars(ZKU);
  const chars = Array.from(map.keys()).sort();
  info('待生成：' + C.bold + chars.length + C.r + ' 个汉字' +
       (OPT.grade ? `（仅 ${OPT.grade} 年级）` : '（全部年级）'));
  if(unsafe.length){
    warn('跳过 ' + unsafe.length + ' 个非标准汉字（不适合做文件名）');
    unsafe.slice(0, 8).forEach(u => dim(u.ch + '（' + u.grade + '年级）'));
    if(unsafe.length > 8) dim('…还有 ' + (unsafe.length - 8) + ' 个');
  }

  /* --- 输出目录 --- */
  const outDir = path.resolve(process.cwd(), CONFIG.OUT_DIR);
  if(!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  info('输出：' + CONFIG.OUT_DIR + '/');
  info('参数：' + CONFIG.VOICE + ' / 语速 ' + CONFIG.SPEED);

  /* --- 试运行 --- */
  if(OPT.dry){
    log('');
    warn('试运行（--dry）——不会实际请求');
    chars.slice(0, 10).forEach(ch => dim(ch + '.mp3  (' + map.get(ch).pinyin + ')'));
    if(chars.length > 10) dim('…');
    return;
  }

  /* --- 探测 Worker --- */
  log('');
  info('探测 Worker…');
  try{
    const probe = await fetchAudio('测');
    ok('Worker 可用（返回 ' + probe.length + ' 字节）');
  }catch(e){
    err('Worker 不可用：' + e.message);
    err('请检查 CONFIG.WORKER_URL 是否正确、Worker 是否已部署');
    process.exit(1);
  }

  /* --- 过滤已存在 --- */
  const todo = [];
  let skipped = 0;
  for(const ch of chars){
    const fp = path.join(outDir, ch + '.mp3');
    if(!OPT.force && fs.existsSync(fp) && fs.statSync(fp).size > 300){ skipped++; continue; }
    todo.push(ch);
  }
  if(skipped) info('跳过已存在：' + skipped + ' 个（--force 可强制重生成）');
  info('本次生成：' + C.bold + todo.length + C.r + ' 个');
  if(!todo.length){ log(''); ok('全部已生成完毕'); return; }

  /* --- 开始 --- */
  log('');
  log(C.bold + '开始生成…' + C.r);
  const t0 = Date.now();
  let okCount = 0, failCount = 0;
  const failed = [];

  await runPool(todo, async (ch) => {
    const fp = path.join(outDir, ch + '.mp3');
    try{
      const buf = await generateWithRetry(ch);
      fs.writeFileSync(fp, buf);
      okCount++;
    }catch(e){
      failCount++;
      failed.push({ ch, err: e.message });
    }
    const cur = okCount + failCount, total = todo.length;
    const barLen = 28;
    const fill = Math.round(barLen * cur / total);
    const bar = '█'.repeat(fill) + '░'.repeat(barLen - fill);
    process.stdout.write(`\r  [${bar}] ${(cur/total*100).toFixed(1)}%  ${cur}/${total}  ✓${okCount} ✗${failCount}   `);
  }, CONFIG.CONCURRENCY);

  process.stdout.write('\n');
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  log('');
  log(C.gray + '─'.repeat(58) + C.r);
  ok(`完成：成功 ${okCount}，失败 ${failCount}，用时 ${dur}s`);

  if(failed.length){
    warn('失败清单（重跑脚本会自动重试这些）：');
    failed.slice(0, 20).forEach(f => dim(f.ch + '：' + f.err));
    if(failed.length > 20) dim('…还有 ' + (failed.length - 20) + ' 个');
  }

  /* --- 生成索引 --- */
  const index = {};
  for(const ch of chars){
    const fp = path.join(outDir, ch + '.mp3');
    if(fs.existsSync(fp)){
      const meta = map.get(ch);
      index[ch] = {
        p: meta.pinyin,
        w: meta.word,
        g: Array.from(meta.grades).sort(),
        s: fs.statSync(fp).size
      };
    }
  }
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 0), 'utf8');
  let totalSize = 0;
  for(const k in index) totalSize += index[k].s;
  ok('索引已生成：audio/index.json（' + Object.keys(index).length + ' 项）');
  info('音频总体积：' + (totalSize / 1024 / 1024).toFixed(2) + ' MB');

  log('');
  log(C.bold + '下一步：' + C.r);
  dim('git add audio && git commit -m "添加识字音频包" && git push');
  log('');
}

main().catch(e => { err('脚本异常：' + e.message); console.error(e); process.exit(1); });