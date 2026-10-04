# GoPro Stitcher

A small web app for joining GoPro clips into one video. Upload your files, pick the ones you want, put them in order, and download a single MP4.

## Features

- **Drag-and-drop upload** of any number of clips, with progress bars. Files stream straight to disk, so multi-GB 4K files are fine.
- **Library sorted the GoPro way.** Chapters of the same recording are kept together (`GX010123`, `GX020123`, …, then `GX010124`). Legacy `GOPRxxxx` / `GPxxxxxx` names work too.
- **Choose clips and their order.** Add clips to "Your video", then drag to reorder or use the ↑ ↓ buttons. You can use a clip more than once. "Add all in order" adds the whole library in recording order.
- **Preview** any clip by clicking its thumbnail, and preview the finished video before downloading.
- **Lossless join by default.** Clips from the same camera and settings are joined with stream copy: no quality loss, and it takes seconds even for long videos. HEVC output is tagged so it plays in QuickTime, Photos and on iPhone.
- **Re-encode fallback** for mixed clips (different resolution, frame rate or codec). Everything is scaled and letterboxed to match the first clip, and encoded as H.264/AAC.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- [ffmpeg](https://ffmpeg.org/download.html), including `ffprobe`
  - macOS: `brew install ffmpeg`
  - Windows: `winget install ffmpeg`
  - Linux: `sudo apt install ffmpeg`

There are no npm dependencies.

## Run it

```bash
cd gopro-stitcher
npm start
```

Then open http://127.0.0.1:3000.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Interface to bind. Set `0.0.0.0` to reach it from your phone or other devices on your network. The app has no login, so only do this on a network you trust. |
| `DATA_DIR` | `./data` | Where uploads, thumbnails and finished videos are stored |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Paths to the binaries if they aren't on your `PATH` |
| `X264_PRESET` | `medium` | x264 speed/size trade-off for re-encodes (e.g. `veryfast`) |

Uploaded clips are kept in `DATA_DIR` until you delete them in the app. Finished videos are kept until the server restarts. You can delete the `data/` folder at any time to free up space.

## Tests

```bash
npm test
```

The tests generate small clips with ffmpeg and run real uploads and stitches against the server.
