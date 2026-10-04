'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  clips: [],      // library, in GoPro order
  sequence: [],   // clip ids in the order they'll be stitched (may repeat)
  job: null,
};

// ---- helpers ----
function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtSize(bytes) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return Math.round(bytes / 1e3) + ' KB';
}
function resLabel(c) {
  const p = Math.min(c.width, c.height);
  const name = p >= 2160 ? '4K' : p >= 1520 && c.width >= 2700 ? '2.7K' : `${p}p`;
  return `${name} ${Math.round(c.fps)}fps`;
}
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const clipById = (id) => state.clips.find((c) => c.id === id);

function saveSequence() {
  try { localStorage.setItem('gopro-sequence', JSON.stringify(state.sequence)); } catch {}
}
function loadSequence() {
  try { return JSON.parse(localStorage.getItem('gopro-sequence')) || []; } catch { return []; }
}

// ---- rendering ----
function thumb(c) {
  return el('img', {
    src: `/api/clips/${c.id}/thumb`,
    alt: '',
    loading: 'lazy',
    title: 'Preview',
    onclick: () => preview(c),
    onerror: (e) => (e.target.style.visibility = 'hidden'),
  });
}

function renderLibrary() {
  const list = $('#library');
  list.replaceChildren(
    ...state.clips.map((c) => {
      const count = state.sequence.filter((id) => id === c.id).length;
      return el('li', { class: 'clip' + (count ? ' in-seq' : '') },
        thumb(c),
        el('div', { class: 'info' },
          el('div', { class: 'name', title: c.name }, c.name),
          el('div', { class: 'meta' }, `${fmtDuration(c.duration)} · ${resLabel(c)} · ${c.videoCodec.toUpperCase()} · ${fmtSize(c.size)}`),
        ),
        el('div', { class: 'actions' },
          el('button', { class: 'primary icon', title: 'Add to video', onclick: () => addToSequence(c.id) }, count ? '+ Add again' : '+ Add'),
          el('button', { class: 'icon', title: 'Delete upload', onclick: () => deleteClip(c) }, '🗑'),
        ),
      );
    }),
  );
  $('#library-empty').hidden = state.clips.length > 0;
  $('#add-all').disabled = state.clips.length === 0;
}

let dragIndex = null;
function renderSequence() {
  const list = $('#sequence');
  list.replaceChildren(
    ...state.sequence.map((id, i) => {
      const c = clipById(id);
      const li = el('li', { class: 'clip', draggable: 'true' },
        el('span', { class: 'num' }, String(i + 1)),
        thumb(c),
        el('div', { class: 'info' },
          el('div', { class: 'name', title: c.name }, c.name),
          el('div', { class: 'meta' }, `${fmtDuration(c.duration)} · ${resLabel(c)}`),
        ),
        el('div', { class: 'actions' },
          el('button', { class: 'icon', title: 'Move up', disabled: i === 0, onclick: () => move(i, i - 1) }, '↑'),
          el('button', { class: 'icon', title: 'Move down', disabled: i === state.sequence.length - 1, onclick: () => move(i, i + 1) }, '↓'),
          el('button', { class: 'icon', title: 'Remove', onclick: () => removeAt(i) }, '✕'),
        ),
      );
      li.addEventListener('dragstart', (e) => {
        dragIndex = i;
        li.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(i));
      });
      li.addEventListener('dragend', () => {
        dragIndex = null;
        li.classList.remove('dragging');
        list.querySelectorAll('.drop-before,.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
      });
      li.addEventListener('dragover', (e) => {
        if (dragIndex === null) return;
        e.preventDefault();
        const after = e.offsetY > li.offsetHeight / 2;
        li.classList.toggle('drop-after', after);
        li.classList.toggle('drop-before', !after);
      });
      li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragIndex === null) return;
        let to = e.offsetY > li.offsetHeight / 2 ? i + 1 : i;
        if (dragIndex < to) to -= 1;
        move(dragIndex, to);
      });
      return li;
    }),
  );
  $('#sequence-empty').hidden = state.sequence.length > 0;
  $('#clear-seq').disabled = state.sequence.length === 0;
  $('#stitch').disabled = state.sequence.length === 0 || state.job?.status === 'running';

  const total = state.sequence.reduce((s, id) => s + clipById(id).duration, 0);
  $('#summary').textContent = state.sequence.length
    ? `${state.sequence.length} clip${state.sequence.length > 1 ? 's' : ''} · total ${fmtDuration(total)}`
    : '';
  checkCompat();
}

function render() {
  renderLibrary();
  renderSequence();
  saveSequence();
}

// ---- sequence actions ----
function addToSequence(id) { state.sequence.push(id); render(); }
function removeAt(i) { state.sequence.splice(i, 1); render(); }
function move(from, to) {
  if (to < 0 || to >= state.sequence.length || from === to) return;
  const [id] = state.sequence.splice(from, 1);
  state.sequence.splice(to, 0, id);
  render();
}
$('#add-all').addEventListener('click', () => {
  state.sequence = state.clips.map((c) => c.id);
  render();
});
$('#clear-seq').addEventListener('click', () => {
  state.sequence = [];
  render();
});

let compatSeq = 0;
async function checkCompat() {
  const out = $('#compat');
  if (!state.sequence.length) { out.textContent = ''; return; }
  const mine = ++compatSeq;
  const { canCopy } = await api('POST', '/api/check', { ids: state.sequence }).catch(() => ({}));
  if (mine !== compatSeq) return;
  const mode = document.querySelector('input[name=mode]:checked').value;
  if (canCopy) {
    out.className = 'compat ok';
    out.textContent = mode === 'reencode'
      ? 'Clips match — lossless join would also work and is much faster.'
      : '✓ Clips match — they will be joined losslessly (fast, no quality loss).';
  } else {
    out.className = mode === 'copy' ? 'compat err' : 'compat warn';
    out.textContent = mode === 'copy'
      ? 'These clips have different settings (resolution, frame rate or codec) and can’t be joined losslessly. Pick Automatic or Re-encode.'
      : 'Clips have different settings, so the video will be re-encoded to match the first clip. This takes longer.';
  }
}
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', checkCompat));

// ---- library actions ----
async function loadClips() {
  state.clips = await api('GET', '/api/clips');
  const known = new Set(state.clips.map((c) => c.id));
  state.sequence = (state.sequence.length ? state.sequence : loadSequence()).filter((id) => known.has(id));
  render();
}

async function deleteClip(c) {
  if (!confirm(`Delete "${c.name}" from the server?`)) return;
  try {
    await api('DELETE', `/api/clips/${c.id}`);
  } catch (e) {
    return alert(e.message);
  }
  state.sequence = state.sequence.filter((id) => id !== c.id);
  await loadClips();
}

function preview(c) {
  const v = $('#preview-video');
  v.src = `/api/clips/${c.id}/video`;
  $('#preview').showModal();
  v.play().catch(() => {});
}
$('#preview').addEventListener('close', () => {
  const v = $('#preview-video');
  v.pause();
  v.removeAttribute('src');
  v.load();
});

// ---- uploads ----
const uploadQueue = [];
let uploading = false;

function queueFiles(files) {
  for (const file of files) {
    const bar = el('progress', { max: 1, value: 0 });
    const label = el('span', {}, `${file.name} — waiting…`);
    const li = el('li', {}, label, bar);
    $('#uploads').append(li);
    uploadQueue.push({ file, li, bar, label });
  }
  pumpUploads();
}

async function pumpUploads() {
  if (uploading) return;
  uploading = true;
  while (uploadQueue.length) {
    const item = uploadQueue.shift();
    try {
      const clip = await uploadOne(item);
      item.li.remove();
      // Newly uploaded clips go straight into the video, in the order uploaded.
      state.sequence.push(clip.id);
      await loadClips();
    } catch (e) {
      item.label.className = 'err';
      item.label.textContent = `${item.file.name} — ${e.message}`;
      item.bar.remove();
      setTimeout(() => item.li.remove(), 8000);
    }
  }
  uploading = false;
}

function uploadOne({ file, bar, label }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      bar.value = e.loaded / e.total;
      label.textContent = `${file.name} — ${Math.round((e.loaded / e.total) * 100)}% of ${fmtSize(e.total)}`;
      if (e.loaded === e.total) label.textContent = `${file.name} — processing…`;
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(file);
  });
}

const dz = $('#dropzone');
$('#file-input').addEventListener('change', (e) => {
  queueFiles([...e.target.files]);
  e.target.value = '';
});
['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  dz.classList.add('over');
}));
['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, () => dz.classList.remove('over')));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  queueFiles([...e.dataTransfer.files]);
});
// Don't let a file dropped elsewhere on the page navigate away.
window.addEventListener('dragover', (e) => e.dataTransfer.types.includes('Files') && e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---- stitching ----
$('#stitch').addEventListener('click', async () => {
  const mode = document.querySelector('input[name=mode]:checked').value;
  const outputName = $('#output-name').value.trim();
  let job;
  try {
    job = await api('POST', '/api/stitch', { ids: state.sequence, mode, outputName });
  } catch (e) {
    return alert(e.message);
  }
  state.job = job;
  $('#job').hidden = false;
  $('#job-result').hidden = true;
  $('#job-cancel').hidden = false;
  $('#job-video').removeAttribute('src');
  renderSequence();
  pollJob();
});

$('#job-cancel').addEventListener('click', async () => {
  if (!state.job) return;
  await api('DELETE', `/api/jobs/${state.job.id}`).catch(() => {});
  state.job.status = 'cancelled';
  showJob();
});

async function pollJob() {
  const id = state.job?.id;
  while (state.job && state.job.id === id && state.job.status === 'running') {
    showJob();
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const j = await api('GET', `/api/jobs/${id}`);
      if (state.job?.id === id && state.job.status === 'running') state.job = j;
    } catch {
      break;
    }
  }
  showJob();
  renderSequence();
}

function showJob() {
  const j = state.job;
  const status = $('#job-status');
  status.className = '';
  $('#job-progress').value = j.progress || 0;
  if (j.status === 'running') {
    const how = j.mode === 'copy' ? 'Joining losslessly' : 'Re-encoding';
    status.textContent = `${how}… ${Math.round((j.progress || 0) * 100)}%`;
  } else if (j.status === 'done') {
    status.textContent = `Done — ${j.outputName} (${fmtSize(j.size)}, ${fmtDuration(j.duration)})`;
    $('#job-cancel').hidden = true;
    $('#job-result').hidden = false;
    $('#job-video').src = `/api/jobs/${j.id}/video`;
    $('#job-download').href = `/api/jobs/${j.id}/download`;
  } else if (j.status === 'cancelled') {
    status.textContent = 'Cancelled.';
    $('#job-cancel').hidden = true;
  } else {
    status.className = 'err';
    status.textContent = `Failed: ${j.error || 'unknown error'}`;
    $('#job-cancel').hidden = true;
  }
}

loadClips().catch((e) => alert('Could not reach the server: ' + e.message));
