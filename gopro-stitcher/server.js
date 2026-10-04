'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const ff = require('./lib/ffmpeg');
const { compareGoPro } = require('./lib/gopro');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUTPUT_DIR = path.join(DATA_DIR, 'output');
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

for (const d of [UPLOAD_DIR, OUTPUT_DIR, THUMB_DIR]) fs.mkdirSync(d, { recursive: true });

// ---- clip library (persisted so uploads survive a restart) ----
let library = {};
try {
  library = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
} catch {
  library = {};
}
function saveLibrary() {
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(library, null, 2));
}
function sortedClips() {
  return Object.values(library).sort((a, b) => compareGoPro(a.name, b.name));
}

const RESOLUTIONS = { '1080': 1080, '720': 720 };
const jobs = new Map();
const ID_RE = /^[a-f0-9]{16}$/;
const newId = () => crypto.randomBytes(8).toString('hex');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readJson(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Serves a file with HTTP Range support so <video> can seek.
function serveFile(req, res, file, { type, downloadName } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return sendJson(res, 404, { error: 'Not found' });
  }
  const headers = {
    'Content-Type': type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
  };
  if (downloadName) {
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  }
  const range = req.headers.range && req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, stat.size - 1);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// ---- handlers ----

// Uploads are sent as the raw request body (one file per request) so that
// multi-GB GoPro files stream straight to disk without buffering.
async function handleUpload(req, res) {
  const rawName = req.headers['x-filename'];
  if (!rawName) return sendJson(res, 400, { error: 'Missing X-Filename header' });
  const name = path.basename(decodeURIComponent(String(rawName))).slice(0, 255) || 'clip.mp4';
  const ext = (path.extname(name).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || ['.mp4'])[0];
  const id = newId();
  const file = path.join(UPLOAD_DIR, id + ext);

  try {
    await pipeline(req, fs.createWriteStream(file));
  } catch (e) {
    fs.rm(file, { force: true }, () => {});
    return sendJson(res, 400, { error: 'Upload interrupted' });
  }

  let meta;
  try {
    meta = await ff.probe(file);
  } catch (e) {
    fs.rm(file, { force: true }, () => {});
    return sendJson(res, 415, { error: `"${name}" is not a readable video file` });
  }

  const thumb = path.join(THUMB_DIR, id + '.jpg');
  try {
    await ff.thumbnail(file, thumb, meta.duration);
  } catch {
    // a missing thumbnail is not fatal
  }

  const size = fs.statSync(file).size;
  library[id] = { id, name, file: path.basename(file), size, uploadedAt: Date.now(), ...meta };
  saveLibrary();
  sendJson(res, 201, library[id]);
}

function handleDeleteClip(res, id) {
  const clip = library[id];
  if (!clip) return sendJson(res, 404, { error: 'Not found' });
  fs.rm(path.join(UPLOAD_DIR, clip.file), { force: true }, () => {});
  fs.rm(path.join(THUMB_DIR, id + '.jpg'), { force: true }, () => {});
  delete library[id];
  saveLibrary();
  sendJson(res, 200, { ok: true });
}

async function handleStitch(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON' });
  }
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (ids.length === 0) return sendJson(res, 400, { error: 'Pick at least one clip' });
  const clips = ids.map((id) => library[id]);
  if (clips.some((c) => !c)) return sendJson(res, 400, { error: 'Unknown clip in selection' });

  const maxHeight = RESOLUTIONS[body.resolution] || null;
  const downscale = ff.needsDownscale(clips, maxHeight);
  const compatible = ff.canStreamCopy(clips);
  let mode = body.mode === 'reencode' ? 'reencode' : body.mode === 'copy' ? 'copy' : 'auto';
  if (mode === 'auto') mode = compatible && !downscale ? 'copy' : 'reencode';
  if (mode === 'copy' && downscale) {
    return sendJson(res, 400, { error: 'Changing the resolution needs a re-encode. Pick Automatic or Re-encode.' });
  }
  if (mode === 'copy' && !compatible) {
    return sendJson(res, 400, {
      error: 'These clips have different formats (resolution, frame rate or codec), so they cannot be joined losslessly. Use re-encode.',
    });
  }

  const outName = (String(body.outputName || '').replace(/[^\w .-]/g, '').trim() || `stitched-${new Date().toISOString().slice(0, 10)}`).replace(/\.mp4$/i, '') + '.mp4';
  const id = newId();
  const job = {
    id,
    status: 'running',
    progress: 0,
    mode,
    resolution: maxHeight ? `${maxHeight}p` : 'original',
    outputName: outName,
    clipCount: clips.length,
    duration: clips.reduce((s, c) => s + c.duration, 0),
    startedAt: Date.now(),
    error: null,
  };
  const outFile = path.join(OUTPUT_DIR, id + '.mp4');
  const listFile = path.join(OUTPUT_DIR, id + '.txt');
  const run = ff.stitch({
    paths: clips.map((c) => path.join(UPLOAD_DIR, c.file)),
    clips,
    outFile,
    listFile,
    mode,
    maxHeight,
    onProgress: (p) => (job.progress = p),
  });
  jobs.set(id, { job, cancel: run.cancel, outFile });
  run.promise
    .then(() => {
      job.status = 'done';
      job.size = fs.statSync(outFile).size;
    })
    .catch((e) => {
      job.status = e.message === 'Cancelled' ? 'cancelled' : 'error';
      job.error = e.message;
      fs.rm(outFile, { force: true }, () => {});
    })
    .finally(() => {
      job.finishedAt = Date.now();
      fs.rm(listFile, { force: true }, () => {});
    });

  sendJson(res, 202, job);
}

function handleDeleteJob(res, id) {
  const entry = jobs.get(id);
  if (!entry) return sendJson(res, 404, { error: 'Not found' });
  if (entry.job.status === 'running') entry.cancel();
  else fs.rm(entry.outFile, { force: true }, () => {});
  jobs.delete(id);
  sendJson(res, 200, { ok: true });
}

// ---- router ----
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = (re) => p.match(re);
  let match;

  if (p === '/api/clips' && req.method === 'GET') return sendJson(res, 200, sortedClips());
  if (p === '/api/upload' && req.method === 'POST') return handleUpload(req, res);
  if ((match = m(/^\/api\/clips\/([a-f0-9]+)$/)) && req.method === 'DELETE') {
    return ID_RE.test(match[1]) ? handleDeleteClip(res, match[1]) : sendJson(res, 404, { error: 'Not found' });
  }
  if ((match = m(/^\/api\/clips\/([a-f0-9]+)\/(thumb|video)$/))) {
    const clip = ID_RE.test(match[1]) && library[match[1]];
    if (!clip) return sendJson(res, 404, { error: 'Not found' });
    if (match[2] === 'thumb') return serveFile(req, res, path.join(THUMB_DIR, clip.id + '.jpg'));
    return serveFile(req, res, path.join(UPLOAD_DIR, clip.file), { type: 'video/mp4' });
  }
  if (p === '/api/check' && req.method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const clips = (body.ids || []).map((id) => library[id]).filter(Boolean);
    return sendJson(res, 200, {
      canCopy: ff.canStreamCopy(clips),
      downscale: ff.needsDownscale(clips, RESOLUTIONS[body.resolution] || null),
    });
  }
  if (p === '/api/stitch' && req.method === 'POST') return handleStitch(req, res);
  if ((match = m(/^\/api\/jobs\/([a-f0-9]+)$/))) {
    const entry = ID_RE.test(match[1]) && jobs.get(match[1]);
    if (req.method === 'DELETE') return handleDeleteJob(res, match[1]);
    if (!entry) return sendJson(res, 404, { error: 'Not found' });
    return sendJson(res, 200, entry.job);
  }
  if ((match = m(/^\/api\/jobs\/([a-f0-9]+)\/(download|video)$/))) {
    const entry = ID_RE.test(match[1]) && jobs.get(match[1]);
    if (!entry || entry.job.status !== 'done') return sendJson(res, 404, { error: 'Not ready' });
    return serveFile(req, res, entry.outFile, {
      type: 'video/mp4',
      downloadName: match[2] === 'download' ? entry.job.outputName : undefined,
    });
  }

  // static files
  if (req.method === 'GET' || req.method === 'HEAD') {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (file.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return serveFile(req, res, file);
    }
  }
  sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
    else res.end();
  });
});
// Big uploads can take a long time; don't let Node time them out.
server.requestTimeout = 0;

if (require.main === module) {
  ff.run(ff.FFMPEG, ['-version'])
    .catch(() => {
      console.error('ffmpeg was not found. Install it (https://ffmpeg.org/download.html) or set FFMPEG_PATH / FFPROBE_PATH.');
      process.exit(1);
    })
    .then(() => {
      server.listen(PORT, HOST, () => {
        console.log(`GoPro Stitcher running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
      });
    });
}

module.exports = { server };
