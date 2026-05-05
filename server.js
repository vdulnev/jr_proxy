const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '8081', 10);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const JRIVER_BASE = process.env.JRIVER_BASE || 'http://127.0.0.1:52199';
const FLAC_LEVEL = process.env.FLAC_LEVEL || '5';
const BUFFER = (process.env.BUFFER || 'disk').toLowerCase(); // 'stream' | 'disk'
const CACHE_DIR = process.env.CACHE_DIR || path.join(os.tmpdir(), 'jr_proxy_cache');
const DEBUG = process.env.DEBUG === '1';

fs.mkdirSync(CACHE_DIR, { recursive: true });

function cleanCache() {
  let removed = 0;
  for (const name of fs.readdirSync(CACHE_DIR)) {
    if (!/^(flac|opus\d+)_[a-f0-9]+\.(flac|m4a)(\.tmp\..+)?$/.test(name)) continue;
    try { fs.unlinkSync(path.join(CACHE_DIR, name)); removed++; } catch (_) {}
  }
  if (removed) console.log(`cache cleanup: removed ${removed} file(s) from ${CACHE_DIR}`);
}
cleanCache();

const baseUrl = new URL(JRIVER_BASE);
const upstreamLib = baseUrl.protocol === 'https:' ? https : http;
const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'DELETE']);

function log(...args) { console.log(new Date().toISOString(), ...args); }
function dbg(...args) { if (DEBUG) log('[debug]', ...args); }

const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection',
  'transfer-encoding', 'te', 'trailer', 'upgrade',
]);

function copyHeaders(src, drop = HOP_BY_HOP) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (!drop.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function transcodeSpec(reqUrl) {
  if (!reqUrl.pathname.toLowerCase().endsWith('/mcws/v1/file/getfile')) return null;
  if (!reqUrl.searchParams.has('Conversion')) return null;
  const conv = (reqUrl.searchParams.get('Conversion') || '').toLowerCase();
  const quality = (reqUrl.searchParams.get('Quality') || '').toLowerCase();

  if (conv === 'opus') {
    const bitrateMap = { high: 160, normal: 96, low: 64 };
    const kbps = bitrateMap[quality] || 96;
    return {
      ext: 'm4a',
      contentType: 'audio/mp4',
      cachePrefix: `opus${kbps}`,
      streamable: false,
      ffmpegOutputArgs: [
        '-c:a', 'libopus',
        '-b:a', `${kbps}k`,
        '-vbr', 'on',
        '-movflags', '+faststart',
        '-f', 'mp4',
      ],
    };
  }

  return {
    ext: 'flac',
    contentType: 'audio/flac',
    cachePrefix: 'flac',
    streamable: true,
    ffmpegOutputArgs: [
      '-f', 'flac',
      '-compression_level', FLAC_LEVEL,
    ],
  };
}

function cacheFilename(reqUrl, spec) {
  const sp = reqUrl.searchParams;
  const parts = [
    sp.get('File') || '',
    sp.get('FileType') || '',
    spec.cachePrefix,
  ].join('|');
  const hash = crypto.createHash('sha1').update(parts).digest('hex').slice(0, 16);
  return `${spec.cachePrefix}_${hash}.${spec.ext}`;
}

function upstreamPathFor(reqUrl) {
  // We always need WAV from JRiver for transcoding; rewrite Conversion accordingly.
  const u = new URL(reqUrl.toString());
  u.searchParams.set('Conversion', 'wav');
  return u.pathname + u.search;
}

function upstreamGet(pathAndQuery, clientHeaders) {
  const headers = {};
  for (const [k, v] of Object.entries(clientHeaders)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (lk === 'range' || lk === 'if-range' || lk === 'if-none-match'
        || lk === 'if-modified-since' || lk === 'accept-encoding') continue;
    headers[k] = v;
  }
  headers.host = baseUrl.host;

  return new Promise((resolve, reject) => {
    const req = upstreamLib.request({
      protocol: baseUrl.protocol,
      hostname: baseUrl.hostname,
      port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      path: pathAndQuery,
      headers,
    }, resolve);
    req.on('error', reject);
    req.end();
  });
}

const encodingPromises = new Map();

function encodeToCache(reqUrl, clientHeaders, label, spec) {
  const tag = `[ff ${label}]`;
  const finalPath = path.join(CACHE_DIR, cacheFilename(reqUrl, spec));
  const tmpPath = `${finalPath}.tmp.${process.pid}.${label}`;

  return (async () => {
    const t0 = Date.now();
    const upstreamRes = await upstreamGet(upstreamPathFor(reqUrl), clientHeaders);
    if (upstreamRes.statusCode < 200 || upstreamRes.statusCode >= 300) {
      upstreamRes.resume();
      throw new Error(`upstream HTTP ${upstreamRes.statusCode}`);
    }
    log(`${tag} encoding ${spec.cachePrefix} upstreamLen=${upstreamRes.headers['content-length'] || '?'} -> ${finalPath}`);

    const ff = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'warning',
      '-i', 'pipe:0',
      ...spec.ffmpegOutputArgs,
      '-y', tmpPath,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    let ffErr = '';
    ff.stderr.on('data', (d) => {
      const s = d.toString();
      ffErr += s;
      process.stderr.write(`${tag} ${s}`);
    });

    upstreamRes.pipe(ff.stdin);
    upstreamRes.on('error', () => { try { ff.kill('SIGKILL'); } catch (_) {} });
    ff.stdin.on('error', () => {});

    try {
      await new Promise((resolve, reject) => {
        ff.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg exit ${code}: ${ffErr.trim()}`));
        });
        ff.on('error', reject);
      });
      await fs.promises.rename(tmpPath, finalPath);
      const stat = await fs.promises.stat(finalPath);
      log(`${tag} cached size=${stat.size} in ${Date.now() - t0}ms`);
      return finalPath;
    } catch (err) {
      fs.unlink(tmpPath, () => {});
      throw err;
    }
  })();
}

async function ensureCached(reqUrl, clientHeaders, label, spec) {
  const key = cacheFilename(reqUrl, spec);
  const finalPath = path.join(CACHE_DIR, key);

  try {
    const st = await fs.promises.stat(finalPath);
    if (st.size > 0) return finalPath;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (encodingPromises.has(key)) return encodingPromises.get(key);

  const p = encodeToCache(reqUrl, clientHeaders, label, spec);
  encodingPromises.set(key, p);
  p.finally(() => encodingPromises.delete(key));
  return p;
}

function serveCachedFile(filePath, clientReq, clientRes, label, spec) {
  fs.stat(filePath, (err, stat) => {
    if (err) {
      log(`[serve ${label}] stat failed: ${err.message}`);
      if (!clientRes.headersSent) {
        clientRes.writeHead(500, { 'content-type': 'text/plain' });
        clientRes.end('stat failed\n');
      }
      return;
    }

    const baseHeaders = {
      'content-type': spec.contentType,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    };

    if (clientReq.method === 'HEAD') {
      clientRes.writeHead(200, { ...baseHeaders, 'content-length': stat.size });
      clientRes.end();
      log(`[serve ${label}] HEAD size=${stat.size}`);
      return;
    }

    const range = clientReq.headers.range;
    let start = 0, end = stat.size - 1, status = 200;

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) {
        clientRes.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${stat.size}` });
        clientRes.end();
        return;
      }
      if (m[1] !== '') start = parseInt(m[1], 10);
      if (m[2] !== '') end = parseInt(m[2], 10);
      if (end >= stat.size) end = stat.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
        clientRes.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${stat.size}` });
        clientRes.end();
        return;
      }
      status = 206;
    }

    const headers = { ...baseHeaders, 'content-length': end - start + 1 };
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;

    clientRes.writeHead(status, headers);
    log(`[serve ${label}] ${status} bytes=${start}-${end}/${stat.size}`);

    const rs = fs.createReadStream(filePath, { start, end });
    rs.on('error', () => clientRes.destroy());
    rs.pipe(clientRes);
    clientRes.on('close', () => rs.destroy());
  });
}

async function handleTranscodeCached(reqUrl, clientReq, clientRes, label, spec) {
  try {
    const cachedPath = await ensureCached(reqUrl, clientReq.headers, label, spec);
    if (clientReq.destroyed) return;
    serveCachedFile(cachedPath, clientReq, clientRes, label, spec);
  } catch (err) {
    log(`[transcode ${label}] failed: ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'text/plain' });
      clientRes.end(`transcode failed: ${err.message}\n`);
    } else {
      clientRes.destroy();
    }
  }
}

function pipeTranscodedStream(upstreamRes, clientRes, clientReq, label) {
  const tag = `[ff ${label}]`;
  const ff = spawn(FFMPEG, [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', '+nobuffer',
    '-i', 'pipe:0',
    '-f', 'flac', '-compression_level', FLAC_LEVEL,
    '-flush_packets', '1',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let ffErr = '';
  ff.stderr.on('data', (d) => {
    const s = d.toString();
    ffErr += s;
    process.stderr.write(`${tag} ${s}`);
  });

  const headers = copyHeaders(upstreamRes.headers,
    new Set([...HOP_BY_HOP, 'content-length', 'content-type', 'accept-ranges', 'content-range']));
  headers['content-type'] = 'audio/flac';
  headers['cache-control'] = 'no-store';
  headers['accept-ranges'] = 'none';

  clientRes.writeHead(200, headers);

  let bytesIn = 0, bytesOut = 0;
  upstreamRes.on('data', (c) => { bytesIn += c.length; });
  ff.stdout.on('data', (c) => { bytesOut += c.length; });

  upstreamRes.pipe(ff.stdin);
  ff.stdout.pipe(clientRes);

  let done = false;
  const cleanup = (reason) => {
    if (done) return;
    done = true;
    upstreamRes.unpipe(ff.stdin);
    ff.stdout.unpipe(clientRes);
    if (!ff.killed) ff.kill('SIGKILL');
    upstreamRes.destroy();
    ff.stdout.destroy();
    ff.stdin.destroy();
    if (!clientRes.writableEnded) clientRes.end();
    log(`${tag} done reason=${reason || 'ok'} in=${bytesIn} out=${bytesOut}`);
    if (reason && ffErr) console.error(`${tag} stderr: ${ffErr.trim()}`);
  };

  upstreamRes.on('error', () => cleanup('upstream'));
  ff.stdin.on('error', () => {});
  ff.stdout.on('error', () => cleanup('ffmpeg stdout'));
  clientRes.on('error', () => cleanup('client write'));
  ff.on('exit', (code) => {
    if (code !== 0 && code !== null) cleanup(`ffmpeg exit ${code}`);
    if (!clientRes.writableEnded) clientRes.end();
  });
  clientReq.on('close', () => cleanup());
  clientRes.on('close', () => cleanup());
}

function pipePassthrough(upstreamRes, clientRes) {
  const headers = copyHeaders(upstreamRes.headers);
  clientRes.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, headers);
  upstreamRes.pipe(clientRes);
  const stop = () => { upstreamRes.unpipe(clientRes); upstreamRes.destroy(); };
  upstreamRes.on('error', stop);
  clientRes.on('error', stop);
  clientRes.on('close', stop);
}

let reqSeq = 0;

const server = http.createServer((clientReq, clientRes) => {
  const reqUrl = new URL(clientReq.url, `http://${clientReq.headers.host || 'x'}`);
  const spec = transcodeSpec(reqUrl);
  const reqId = (++reqSeq).toString(36);

  // Opus must be cached (mp4 muxer needs seek for +faststart). FLAC may stream if asked.
  if (spec && (!spec.streamable || BUFFER === 'disk')) {
    log(`transcode #${reqId} mode=disk codec=${spec.cachePrefix} ${clientReq.method} ${clientReq.url} range=${clientReq.headers.range || '-'}`);
    handleTranscodeCached(reqUrl, clientReq, clientRes, reqId, spec);
    return;
  }

  const dropForUpstream = new Set(HOP_BY_HOP);
  if (spec) {
    dropForUpstream.add('range');
    dropForUpstream.add('if-range');
    dropForUpstream.add('if-none-match');
    dropForUpstream.add('if-modified-since');
    dropForUpstream.add('accept-encoding');
  }
  const headers = copyHeaders(clientReq.headers, dropForUpstream);
  headers.host = baseUrl.host;

  const upstreamPath = spec ? upstreamPathFor(reqUrl) : clientReq.url;

  const upstreamReq = upstreamLib.request({
    protocol: baseUrl.protocol,
    hostname: baseUrl.hostname,
    port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
    method: clientReq.method,
    path: upstreamPath,
    headers,
  }, (upstreamRes) => {
    dbg('<-', upstreamRes.statusCode, clientReq.method, clientReq.url);
    const ok = upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 300;
    if (ok && spec) {
      log(`transcode #${reqId} mode=stream codec=${spec.cachePrefix} upstream=${upstreamRes.statusCode} upstreamLen=${upstreamRes.headers['content-length'] || '?'} ${clientReq.url}`);
      pipeTranscodedStream(upstreamRes, clientRes, clientReq, reqId);
    } else {
      pipePassthrough(upstreamRes, clientRes);
    }
  });

  upstreamReq.on('error', (err) => {
    log('upstream error', clientReq.method, clientReq.url, '-', err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      clientRes.end(`upstream error: ${err.message}\n`);
    } else {
      clientRes.destroy();
    }
  });

  dbg('->', clientReq.method, clientReq.url);

  if (BODYLESS_METHODS.has(clientReq.method)) {
    upstreamReq.end();
  } else {
    clientReq.pipe(upstreamReq);
  }
  clientReq.on('close', () => upstreamReq.destroy());
});

server.listen(PORT, () => {
  console.log(`jr_proxy listening on :${PORT} -> ${JRIVER_BASE} (BUFFER=${BUFFER}, cache=${CACHE_DIR})`);
});

process.on('uncaughtException', (err) => {
  log('uncaughtException', err.code || '', err.message);
});
