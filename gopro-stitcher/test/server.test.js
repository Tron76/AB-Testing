'use strict';

// End-to-end test: generates small clips with ffmpeg, uploads them, stitches
// them in a chosen order and checks the result. Requires ffmpeg/ffprobe.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gopro-stitcher-'));
process.env.DATA_DIR = path.join(tmp, 'data');
const { server } = require('../server');
const ff = require('../lib/ffmpeg');

let base;

async function makeClip(name, { seconds, size = '320x240', rate = 30, audio = true }) {
  const file = path.join(tmp, name);
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=${size}:rate=${rate}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'aac');
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', file);
  await ff.run(ff.FFMPEG, args);
  return file;
}

async function upload(file) {
  const res = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { 'X-Filename': encodeURIComponent(path.basename(file)) },
    body: fs.readFileSync(file),
  });
  assert.strictEqual(res.status, 201, await res.clone().text());
  return res.json();
}

async function stitchAndWait(body) {
  const res = await fetch(`${base}/api/stitch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const job = await res.json();
  assert.strictEqual(res.status, 202, JSON.stringify(job));
  for (;;) {
    const j = await (await fetch(`${base}/api/jobs/${job.id}`)).json();
    if (j.status !== 'running') return j;
    await new Promise((r) => setTimeout(r, 200));
  }
}

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('uploads, orders and stitches clips', async () => {
  // Uploaded out of order on purpose.
  const c2 = await upload(await makeClip('GX020001.MP4', { seconds: 2 }));
  const c1 = await upload(await makeClip('GX010001.MP4', { seconds: 1 }));
  const c3 = await upload(await makeClip('GX010002.MP4', { seconds: 3 }));

  const clips = await (await fetch(`${base}/api/clips`)).json();
  assert.deepStrictEqual(clips.map((c) => c.name), ['GX010001.MP4', 'GX020001.MP4', 'GX010002.MP4']);
  assert.strictEqual((await fetch(`${base}/api/clips/${c1.id}/thumb`)).status, 200);

  // Lossless join in a custom order, skipping c2.
  const job = await stitchAndWait({ ids: [c3.id, c1.id], mode: 'auto', outputName: 'trip' });
  assert.strictEqual(job.status, 'done', job.error);
  assert.strictEqual(job.mode, 'copy');
  assert.strictEqual(job.outputName, 'trip.mp4');

  const dl = await fetch(`${base}/api/jobs/${job.id}/download`);
  assert.strictEqual(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /trip\.mp4/);
  const out = path.join(tmp, 'out.mp4');
  fs.writeFileSync(out, Buffer.from(await dl.arrayBuffer()));
  const meta = await ff.probe(out);
  assert.ok(Math.abs(meta.duration - 4) < 0.3, `duration ${meta.duration}`);
  assert.ok(meta.audioCodec);

  // Range requests work for in-browser preview.
  const part = await fetch(`${base}/api/jobs/${job.id}/video`, { headers: { Range: 'bytes=0-99' } });
  assert.strictEqual(part.status, 206);
  assert.strictEqual((await part.arrayBuffer()).byteLength, 100);
});

test('re-encodes mismatched clips', async () => {
  const a = await upload(await makeClip('a.mp4', { seconds: 1, size: '320x240', rate: 30 }));
  const b = await upload(await makeClip('b.mp4', { seconds: 1, size: '640x360', rate: 25, audio: false }));

  const bad = await fetch(`${base}/api/stitch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [a.id, b.id], mode: 'copy' }),
  });
  assert.strictEqual(bad.status, 400);

  const job = await stitchAndWait({ ids: [a.id, b.id], mode: 'auto' });
  assert.strictEqual(job.status, 'done', job.error);
  assert.strictEqual(job.mode, 'reencode');
});

test('downscales to a smaller resolution', async () => {
  const a = await upload(await makeClip('hd1.mp4', { seconds: 1, size: '1920x1080' }));
  const b = await upload(await makeClip('hd2.mp4', { seconds: 1, size: '1920x1080' }));

  // Downscaling can't be done losslessly.
  const bad = await fetch(`${base}/api/stitch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [a.id, b.id], mode: 'copy', resolution: '720' }),
  });
  assert.strictEqual(bad.status, 400);

  const job = await stitchAndWait({ ids: [a.id, b.id], mode: 'auto', resolution: '720' });
  assert.strictEqual(job.status, 'done', job.error);
  assert.strictEqual(job.mode, 'reencode');
  assert.strictEqual(job.resolution, '720p');
  const out = path.join(tmp, 'small.mp4');
  fs.writeFileSync(out, Buffer.from(await (await fetch(`${base}/api/jobs/${job.id}/download`)).arrayBuffer()));
  const meta = await ff.probe(out);
  assert.deepStrictEqual([meta.width, meta.height], [1280, 720]);
  assert.ok(Math.abs(meta.duration - 2) < 0.3, `duration ${meta.duration}`);

  // Clips already at or below the target stay lossless.
  const small = await upload(await makeClip('sd.mp4', { seconds: 1, size: '640x360' }));
  const keep = await stitchAndWait({ ids: [small.id], mode: 'auto', resolution: '1080' });
  assert.strictEqual(keep.mode, 'copy');
});

test('targetSize shrinks 4K to 1080p keeping aspect ratio', () => {
  assert.deepStrictEqual(ff.targetSize({ width: 3840, height: 2160 }, 1080), { W: 1920, H: 1080 });
  assert.deepStrictEqual(ff.targetSize({ width: 2704, height: 1520 }, 1080), { W: 1922, H: 1080 });
  assert.deepStrictEqual(ff.targetSize({ width: 3840, height: 2880 }, 1080), { W: 1440, H: 1080 });
  assert.deepStrictEqual(ff.targetSize({ width: 1920, height: 1080 }, 1080), { W: 1920, H: 1080 });
  assert.deepStrictEqual(ff.targetSize({ width: 3840, height: 2160 }, null), { W: 3840, H: 2160 });
});

test('rejects non-video uploads', async () => {
  const res = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { 'X-Filename': 'notes.txt' },
    body: 'hello',
  });
  assert.strictEqual(res.status, 415);
});

test('deletes clips', async () => {
  const c = await upload(await makeClip('del.mp4', { seconds: 1 }));
  assert.strictEqual((await fetch(`${base}/api/clips/${c.id}`, { method: 'DELETE' })).status, 200);
  const clips = await (await fetch(`${base}/api/clips`)).json();
  assert.ok(!clips.some((x) => x.id === c.id));
});
