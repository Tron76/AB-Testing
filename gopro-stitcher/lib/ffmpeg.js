'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited with ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

async function probe(file) {
  const out = await run(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  const info = JSON.parse(out);
  const video = info.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new Error('No video stream found');
  const [num, den] = String(video.avg_frame_rate || video.r_frame_rate || '0/1').split('/').map(Number);
  return {
    duration: Number(info.format.duration) || 0,
    width: video.width,
    height: video.height,
    fps: den ? Math.round((num / den) * 1000) / 1000 : 0,
    videoCodec: video.codec_name,
    pixFmt: video.pix_fmt,
    audioCodec: audio ? audio.codec_name : null,
    sampleRate: audio ? Number(audio.sample_rate) : null,
    channels: audio ? audio.channels : null,
  };
}

async function thumbnail(file, outFile, duration) {
  const at = Math.min(1, Math.max(0, (duration || 0) / 2));
  await run(FFMPEG, [
    '-y', '-v', 'error',
    '-ss', String(at),
    '-i', file,
    '-frames:v', '1',
    '-vf', 'scale=320:-2',
    '-q:v', '4',
    outFile,
  ]);
}

// Clips can be joined losslessly (stream copy) only when every clip has the
// same codecs, resolution, frame rate and audio layout.
function canStreamCopy(clips) {
  if (clips.length === 0) return false;
  const key = (c) => [c.videoCodec, c.pixFmt, c.width, c.height, c.fps, c.audioCodec, c.sampleRate, c.channels].join('|');
  const first = key(clips[0]);
  return clips.every((c) => key(c) === first);
}

function concatListFile(paths) {
  // ffmpeg concat demuxer syntax; single quotes escaped as '\''
  return paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

function buildCopyArgs(listFile, outFile, clips) {
  const args = [
    '-y', '-v', 'error', '-nostats', '-progress', 'pipe:1',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c', 'copy',
  ];
  // Tag HEVC as hvc1 so it plays in QuickTime / iOS / Photos.
  if (clips[0].videoCodec === 'hevc') args.push('-tag:v', 'hvc1');
  args.push('-movflags', '+faststart', outFile);
  return args;
}

// Output size: the first clip's size, shrunk (keeping aspect ratio) so its
// shorter side is at most maxHeight (e.g. 1080 turns 4K into 1080p).
function targetSize(clip, maxHeight) {
  let W = clip.width;
  let H = clip.height;
  const short = Math.min(W, H);
  if (maxHeight && short > maxHeight) {
    const k = maxHeight / short;
    W = Math.round((W * k) / 2) * 2;
    H = Math.round((H * k) / 2) * 2;
  }
  return { W, H };
}

function needsDownscale(clips, maxHeight) {
  return Boolean(maxHeight) && clips.some((c) => Math.min(c.width, c.height) > maxHeight);
}

function buildReencodeArgs(paths, outFile, clips, maxHeight) {
  // Target the first clip's resolution (optionally downscaled) and frame
  // rate; letterbox others.
  const { W, H } = targetSize(clips[0], maxHeight);
  const fps = clips[0].fps || 30;
  const args = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1'];
  paths.forEach((p) => args.push('-i', p));

  const filters = [];
  const parts = [];
  clips.forEach((c, i) => {
    filters.push(
      `[${i}:v:0]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`
    );
    if (c.audioCodec) {
      filters.push(`[${i}:a:0]aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
    } else {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${c.duration}[a${i}]`);
    }
    parts.push(`[v${i}][a${i}]`);
  });
  filters.push(`${parts.join('')}concat=n=${clips.length}:v=1:a=1[outv][outa]`);

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[outv]', '-map', '[outa]',
    // Downscaled "share" exports use a slightly higher CRF for smaller files.
    '-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'medium', '-crf', maxHeight ? '21' : '18',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outFile
  );
  return args;
}

// Runs the stitch and reports progress (0..1) via onProgress.
// Returns { promise, cancel }.
function stitch({ paths, clips, outFile, listFile, mode, maxHeight, onProgress }) {
  const total = clips.reduce((s, c) => s + (c.duration || 0), 0);
  let args;
  if (mode === 'copy') {
    fs.writeFileSync(listFile, concatListFile(paths));
    args = buildCopyArgs(listFile, outFile, clips);
  } else {
    args = buildReencodeArgs(paths, outFile, clips, maxHeight);
  }

  const proc = spawn(FFMPEG, args);
  let stderr = '';
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
      if (m && total > 0) onProgress?.(Math.min(0.999, Number(m[1]) / 1e6 / total));
    }
  });
  proc.stderr.on('data', (d) => (stderr += d));

  const promise = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      if (code === 0) {
        onProgress?.(1);
        resolve();
      } else {
        reject(new Error(signal ? 'Cancelled' : `ffmpeg failed: ${stderr.slice(-2000)}`));
      }
    });
  });
  return { promise, cancel: () => proc.kill('SIGTERM') };
}

module.exports = { probe, thumbnail, canStreamCopy, needsDownscale, targetSize, concatListFile, buildCopyArgs, buildReencodeArgs, stitch, run, FFMPEG };
