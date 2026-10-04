'use strict';

// GoPro file naming:
//   HERO6+ : GXccnnnn.MP4 (HEVC) / GHccnnnn.MP4 (AVC) / GLccnnnn.LRV
//            cc = chapter (01, 02, ...), nnnn = recording number
//   HERO5- : GOPRnnnn.MP4 for the first chapter, GPccnnnn.MP4 for later ones
// A long recording is split into chapters, so the natural order is by
// recording number first, then chapter.
function parseGoProName(filename) {
  const base = String(filename).split(/[\\/]/).pop().toUpperCase();
  let m = base.match(/^G[XHL](\d{2})(\d{4})\./);
  if (m) return { recording: Number(m[2]), chapter: Number(m[1]) };
  m = base.match(/^GOPR(\d{4})\./);
  if (m) return { recording: Number(m[1]), chapter: 0 };
  m = base.match(/^GP(\d{2})(\d{4})\./);
  if (m) return { recording: Number(m[2]), chapter: Number(m[1]) };
  return null;
}

// Sort GoPro files by recording then chapter; non-GoPro names go last,
// ordered by name.
function compareGoPro(a, b) {
  const pa = parseGoProName(a);
  const pb = parseGoProName(b);
  if (pa && pb) {
    if (pa.recording !== pb.recording) return pa.recording - pb.recording;
    if (pa.chapter !== pb.chapter) return pa.chapter - pb.chapter;
    return 0;
  }
  if (pa) return -1;
  if (pb) return 1;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

module.exports = { parseGoProName, compareGoPro };
