const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');

// S3 configuration (optional - falls back to local storage if not configured)
const S3_CONFIG = {
  enabled: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_S3_BUCKET,
  bucket: process.env.AWS_S3_BUCKET,
  region: process.env.AWS_REGION || 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};

// Initialize S3 client if configured
let s3Client = null;
if (S3_CONFIG.enabled) {
  try {
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({
      region: S3_CONFIG.region,
      credentials: {
        accessKeyId: S3_CONFIG.accessKeyId,
        secretAccessKey: S3_CONFIG.secretAccessKey,
      },
    });
  } catch (err) {
    console.warn('S3 client not available, falling back to local storage:', err.message);
    S3_CONFIG.enabled = false;
  }
}

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const app = express();
app.use(cors());
app.use(express.json());
// Publicly serve downloaded files
app.use('/downloads', express.static(path.join(process.cwd(), 'downloads'), { index: false, dotfiles: 'allow' }));

// In-memory progress state for SSE
const progressStates = new Map();
// Cleanup any debug watch files that may exist so they never get served or deployed
try {
  const root = process.cwd();
  for (const name of fs.readdirSync(root)) {
    if (/-watch\.html$/i.test(name)) {
      try { fs.unlinkSync(path.join(root, name)); } catch {}
    }
  }
} catch {}
function initProgress(id) {
  if (!id) return;
  progressStates.set(id, { status: 'starting', percent: 0, etaSeconds: null, startedAt: Date.now() });
}
function setProgress(id, mutation) {
  if (!id) return;
  const prev = progressStates.get(id) || { status: 'starting', percent: 0, etaSeconds: null, startedAt: Date.now() };
  const next = { ...prev, ...mutation };
  progressStates.set(id, next);
}
function finishProgress(id, ok, details) {
  if (!id) return;
  const now = Date.now();
  setProgress(id, { status: ok ? 'done' : 'error', percent: ok ? 100 : (progressStates.get(id)?.percent || 0), etaSeconds: 0, finishedAt: now, ...(details ? { file: details.file, error: details.error } : {}) });
}

// SSE endpoint: clients subscribe to progress by id
app.get('/api/progress/:id', (req, res) => {
  const { id } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders && res.flushHeaders();

  const send = () => {
    const state = progressStates.get(id) || { status: 'unknown' };
    try {
      res.write(`data: ${JSON.stringify(state)}\n\n`);
    } catch (_) {
      clearInterval(timer);
    }
    if (state.status === 'done' || state.status === 'error') {
      clearInterval(timer);
    }
  };
  const timer = setInterval(send, 1000);
  send();
  req.on('close', () => { clearInterval(timer); });
});

// JSON polling fallback for environments that don't support SSE
app.get('/api/progress/:id/json', (req, res) => {
  const { id } = req.params;
  const state = progressStates.get(id) || { status: 'unknown' };
  res.setHeader('Cache-Control', 'no-store');
  res.json(state);
});

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'DNT': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Cache-Control': 'max-age=0'
};

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function resolveLocalFfmpegBinary() {
  try {
    const candidate = path.join(process.cwd(), 'tools', 'ffmpeg-7.1.1-essentials_build', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (fs.existsSync(candidate)) return candidate;
  } catch (_) {}
  if (ffmpegPath) return ffmpegPath;
  return null;
}

function spawnOnce(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    let spawned = true;
    child.on('error', (err) => {
      spawned = false;
      resolve({ ok: false, code: null, error: err, stdout: '', stderr: '' });
    });
    child.stdout && child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr && child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (!spawned) return; 
      resolve({ ok: code === 0, code, error: null, stdout, stderr });
    });
  });
}

async function runYtDlp(url, args) {
  const commands = [
    { cmd: 'yt-dlp', args: [] },
    { cmd: 'python', args: ['-m', 'yt_dlp'] },
    { cmd: 'python3', args: ['-m', 'yt_dlp'] },
    { cmd: 'py', args: ['-3', '-m', 'yt_dlp'] },
  ];
  for (const candidate of commands) {
    const result = await spawnOnce(candidate.cmd, [...candidate.args, ...args, url], { shell: false });
    if (result.ok) return result;
    const isNotFound = result.error && (result.error.code === 'ENOENT');
    if (!isNotFound && result.code !== null) {
      return result;
    }
  }
  return { ok: false, code: null, error: new Error('yt-dlp not available'), stdout: '', stderr: '' };
}

function getNewestFileInDirectory(directoryPath, extensions, newerThanMs) {
  const entries = fs.readdirSync(directoryPath).map((name) => path.join(directoryPath, name));
  const filtered = entries.filter((p) => {
    try {
      const stat = fs.statSync(p);
      const ext = path.extname(p).toLowerCase();
      return stat.isFile() && (!extensions || extensions.includes(ext)) && (!newerThanMs || stat.mtimeMs >= newerThanMs);
    } catch (_) {
      return false;
    }
  });
  filtered.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return filtered[0] || null;
}

async function downloadWithYtDlp(url, { audioOnly = false, bitrateKbps = 192 } = {}) {
  const outDir = path.join(process.cwd(), 'downloads');
  ensureDir(outDir);
  const ffmpegBin = resolveLocalFfmpegBinary();
  const startMs = Date.now();

  const outputTemplate = path.join(outDir, '%(title).150B-%(id)s.%(ext)s');
  const baseArgs = [
    '--no-playlist',
    '--restrict-filenames',
    '-o', outputTemplate,
    '--print', 'after_move:filepath',
    '--print', 'filepath',
    '--print', 'filename'
  ];
  if (ffmpegBin) {
    baseArgs.push('--ffmpeg-location', ffmpegBin);
  }
  const modeArgs = audioOnly
    ? ['-f', 'bestaudio/best', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', String(bitrateKbps)]
    : ['-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b'];

  const result = await runYtDlp(url, [...modeArgs, ...baseArgs]);
  if (!result.ok) {
    const message = result.stderr || (result.error ? result.error.message : 'Unknown error');
    throw new Error(`yt-dlp failed: ${message}`);
  }

  const lines = (result.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let resolvedPath = lines.reverse().find((l) => l.toLowerCase().startsWith(outDir.toLowerCase()));
  if (!resolvedPath) {
    const extList = audioOnly ? ['.mp3'] : ['.mp4'];
    const newest = getNewestFileInDirectory(outDir, extList, startMs - 1000);
    if (newest) resolvedPath = newest;
  }
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    throw new Error('yt-dlp finished but output file could not be determined');
  }
  
  const filename = path.basename(resolvedPath);
  const fileUrl = await getFileUrl(resolvedPath, filename);
  
  return {
    path: resolvedPath,
    filename,
    url: fileUrl,
  };
}

async function downloadWithYtDlpStreaming(url, { audioOnly = false, bitrateKbps = 192, progressId } = {}) {
  const outDir = path.join(process.cwd(), 'downloads');
  ensureDir(outDir);
  const ffmpegBin = resolveLocalFfmpegBinary();
  const outputTemplate = path.join(outDir, '%(title).150B-%(id)s.%(ext)s');
  const baseArgs = [
    '--no-playlist',
    '--restrict-filenames',
    '-o', outputTemplate,
    '--print', 'after_move:filepath',
    '--print', 'filepath',
    '--print', 'filename'
  ];
  if (ffmpegBin) baseArgs.push('--ffmpeg-location', ffmpegBin);
  const modeArgs = audioOnly
    ? ['-f', 'bestaudio/best', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', String(bitrateKbps)]
    : ['-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b'];

  const commands = [
    { cmd: 'yt-dlp', args: [] },
    { cmd: 'python', args: ['-m', 'yt_dlp'] },
    { cmd: 'python3', args: ['-m', 'yt_dlp'] },
    { cmd: 'py', args: ['-3', '-m', 'yt_dlp'] },
  ];

  let stdout = '';
  let selected = null;
  for (const candidate of commands) {
    const child = spawn(candidate.cmd, [...candidate.args, ...modeArgs, ...baseArgs, url], { shell: false });
    selected = child;
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => {
      const text = d.toString();
      // Parse lines like: "[download]  42.1% of 10.00MiB at 2.00MiB/s ETA 00:03"
      const m = text.match(/(\d{1,3}\.\d|\d{1,3})%.*?ETA\s+(\d{2}):(\d{2})/);
      if (m && progressId) {
        const percent = Math.max(0, Math.min(100, parseFloat(m[1])));
        const etaSeconds = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
        setProgress(progressId, { status: 'downloading', percent, etaSeconds });
      } else if (progressId) {
        setProgress(progressId, { status: 'downloading' });
      }
    });
    const res = await new Promise((resolve) => {
      child.on('close', (code) => resolve({ ok: code === 0, code }));
      child.on('error', (err) => resolve({ ok: false, error: err }));
    });
    if (res.ok) {
      break;
    }
    // If the command was not found, try the next candidate
    if (res.error && res.error.code === 'ENOENT') {
      selected = null;
      continue;
    }
    // Any other error: stop trying further and throw
    selected = null;
    throw res.error || new Error('yt-dlp failed');
  }

  if (!selected) throw new Error('yt-dlp not available or failed');

  const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let resolvedPath = lines.reverse().find((l) => l.toLowerCase().startsWith(path.join(process.cwd(), 'downloads').toLowerCase()));
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    // Best-effort: pick newest file
    const extList = audioOnly ? ['.mp3'] : ['.mp4'];
    const newest = getNewestFileInDirectory(path.join(process.cwd(), 'downloads'), extList);
    resolvedPath = newest;
  }
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    throw new Error('yt-dlp finished but output file could not be determined');
  }
  if (progressId) finishProgress(progressId, true);
  return { path: resolvedPath, filename: path.basename(resolvedPath), url: `/downloads/${encodeURIComponent(path.basename(resolvedPath))}` };
}

// Helper function to upload file to S3 or return local path
async function getFileUrl(filePath, filename) {
  if (!S3_CONFIG.enabled || !s3Client) {
    // Fallback to local storage
    return `/downloads/${encodeURIComponent(filename)}`;
  }

  try {
    const fileStream = fs.createReadStream(filePath);
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    
    const uploadParams = {
      Bucket: S3_CONFIG.bucket,
      Key: `downloads/${filename}`,
      Body: fileStream,
      ContentType: filename.endsWith('.mp4') ? 'video/mp4' : 'audio/mpeg',
      ACL: 'public-read',
    };

    await s3Client.send(new PutObjectCommand(uploadParams));
    
    // Return S3 public URL
    const s3Url = `https://${S3_CONFIG.bucket}.s3.${S3_CONFIG.region}.amazonaws.com/downloads/${encodeURIComponent(filename)}`;
    
    // Optionally delete local file after S3 upload
    if (process.env.CLEANUP_LOCAL_FILES === 'true') {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.warn('Failed to cleanup local file:', err.message);
      }
    }
    
    return s3Url;
  } catch (err) {
    console.error('S3 upload failed, falling back to local:', err.message);
    return `/downloads/${encodeURIComponent(filename)}`;
  }
}

app.post('/api/download', async (req, res) => {
  try {
    const { url, progressId } = req.body || {};
    if (!url || !ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    if (progressId) initProgress(progressId);
    
    try {
      const info = await ytdl.getInfo(url, { requestOptions: { headers: DEFAULT_HEADERS } });
    const title = info.videoDetails.title.replace(/[<>:"/\\|?*]/g, '_');
    const id = info.videoDetails.videoId;
    const filename = `${title}-${id}.mp4`;
    const outDir = path.join(process.cwd(), 'downloads');
    ensureDir(outDir);
    const outPath = path.join(outDir, filename);

    const write = fs.createWriteStream(outPath);
    const stream = ytdl(url, {
      filter: 'audioandvideo',
      quality: 'highest',
        dlChunkSize: 0,
        highWaterMark: 1 << 26,
      requestOptions: { headers: DEFAULT_HEADERS },
      range: { start: 0 },
      begin: '0s',
    });

      if (progressId) {
        const startedAt = Date.now();
        stream.on('progress', (_chunkLen, downloaded, total) => {
          const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
          const speed = downloaded / elapsed; // bytes per second
          const remaining = Math.max(0, total - downloaded);
          const etaSeconds = speed > 0 ? Math.round(remaining / speed) : null;
          const percent = total ? (downloaded / total) * 100 : 0;
          setProgress(progressId, { status: 'downloading', percent, etaSeconds });
        });
      }

      let responded = false;
      const finalize = (statusCode, payload) => {
        if (responded) return;
        responded = true;
        res.status(statusCode).json(payload);
      };

      stream.on('error', async (err) => {
        if (responded) return;
        try {
          const fallback = progressId
            ? await downloadWithYtDlpStreaming(url, { audioOnly: false, progressId })
            : await downloadWithYtDlp(url, { audioOnly: false });
          finalize(200, fallback);
        } catch (fallbackErr) {
          if (progressId) finishProgress(progressId, false);
          finalize(500, { error: `Download failed: ${err.message}; yt-dlp fallback failed: ${fallbackErr.message}` });
        }
      });

      write.on('finish', async () => {
        if (progressId) finishProgress(progressId, true, { file: filename });
        const fileUrl = await getFileUrl(outPath, filename);
        finalize(200, { path: outPath, filename, url: fileUrl });
      });

      write.on('error', async (err) => {
        if (responded) return;
        try {
          const fallback = progressId
            ? await downloadWithYtDlpStreaming(url, { audioOnly: false, progressId })
            : await downloadWithYtDlp(url, { audioOnly: false });
          finalize(200, fallback);
        } catch (fallbackErr) {
          if (progressId) finishProgress(progressId, false, { error: err.message });
          finalize(500, { error: `File write failed: ${err.message}; yt-dlp fallback failed: ${fallbackErr.message}` });
        }
      });

      stream.pipe(write);
    } catch (infoError) {
      try {
        const fallback = req.body?.progressId
          ? await downloadWithYtDlpStreaming(url, { audioOnly: false, progressId: req.body.progressId })
          : await downloadWithYtDlp(url, { audioOnly: false });
        return res.json(fallback);
      } catch (fallbackErr) {
        console.error('Error getting video info:', infoError.message);
        if (req.body?.progressId) finishProgress(req.body.progressId, false, { error: infoError.message });
        return res.status(500).json({ error: `Failed to get video info: ${infoError.message}; yt-dlp fallback failed: ${fallbackErr.message}` });
      }
    }
  } catch (e) {
    console.error('General error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/convert', async (req, res) => {
  try {
    const { file, bitrate = 192 } = req.body || {};
    if (!file || !fs.existsSync(file)) {
      return res.status(400).json({ error: 'File not found' });
    }
    const { name, dir } = path.parse(file);
    const outPath = path.join(dir, `${name}.mp3`);

    ffmpeg(file)
      .audioCodec('libmp3lame')
      .audioBitrate(String(bitrate))
      .noVideo()
      .on('end', () => res.json({ path: outPath, filename: path.basename(outPath) }))
      .on('error', (err) => res.status(500).json({ error: err.message }))
      .save(outPath);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/download-mp3', async (req, res) => {
  try {
    const { url, bitrate = 192, progressId } = req.body || {};
    if (!url || !ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    if (progressId) initProgress(progressId);
    try {
    const info = await ytdl.getInfo(url, { requestOptions: { headers: DEFAULT_HEADERS } });
    const title = info.videoDetails.title.replace(/[<>:"/\\|?*]/g, '_');
    const id = info.videoDetails.videoId;
    const filename = `${title}-${id}.mp3`;
    const outDir = path.join(process.cwd(), 'downloads');
    ensureDir(outDir);
    const outPath = path.join(outDir, filename);

    const audioStream = ytdl(url, {
      filter: 'audioonly',
      quality: 'highestaudio',
      dlChunkSize: 0,
      highWaterMark: 1 << 26,
      requestOptions: { headers: DEFAULT_HEADERS },
      range: { start: 0 },
      begin: '0s',
    });

      if (progressId) {
        const startedAt = Date.now();
        audioStream.on('progress', (_chunkLen, downloaded, total) => {
          const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
          const speed = downloaded / elapsed;
          const remaining = Math.max(0, total - downloaded);
          const etaSeconds = speed > 0 ? Math.round(remaining / speed) : null;
          const percent = total ? (downloaded / total) * 100 : 0;
          setProgress(progressId, { status: 'downloading', percent, etaSeconds });
        });
      }

    ffmpeg(audioStream)
      .audioCodec('libmp3lame')
      .audioBitrate(String(bitrate))
      .format('mp3')
      .outputOptions(['-threads 0'])
        .on('error', async (err) => {
          try {
            const fallback = progressId
              ? await downloadWithYtDlpStreaming(url, { audioOnly: true, bitrateKbps: bitrate, progressId })
              : await downloadWithYtDlp(url, { audioOnly: true, bitrateKbps: bitrate });
            if (progressId) finishProgress(progressId, true, { file: filename });
            res.json(fallback);
          } catch (fallbackErr) {
            if (progressId) finishProgress(progressId, false, { error: fallbackErr.message || err.message });
            res.status(500).json({ error: fallbackErr.message || err.message });
          }
        })
        .on('end', async () => {
          if (progressId) finishProgress(progressId, true, { file: filename });
          const fileUrl = await getFileUrl(outPath, filename);
          res.json({ path: outPath, filename, url: fileUrl })
        })
      .save(outPath);
    } catch (infoError) {
      try {
        const fallback = req.body?.progressId
          ? await downloadWithYtDlpStreaming(url, { audioOnly: true, bitrateKbps: bitrate, progressId: req.body.progressId })
          : await downloadWithYtDlp(url, { audioOnly: true, bitrateKbps: bitrate });
        if (req.body?.progressId) finishProgress(req.body.progressId, true);
        return res.json(fallback);
      } catch (fallbackErr) {
        if (req.body?.progressId) finishProgress(req.body.progressId, false);
        return res.status(500).json({ error: `Failed to get video info: ${infoError.message}; yt-dlp fallback failed: ${fallbackErr.message}` });
      }
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 5174;
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));


