const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const youtubedl = require('youtube-dl-exec');

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

// Ensure downloads directory exists at startup (important for Render/local storage)
try {
  const downloadsDir = path.join(process.cwd(), 'downloads');
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }
} catch {}

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

// Optional: pass YouTube cookies to yt-dlp via youtube-dl-exec
// Supports multiple sources: browser, file path, raw text, or base64 text
let CACHED_COOKIES_FILE = null;
function resolveCookiesOption() {
  try {
    // 1) Use browser cookies (useful for local dev only). Example: EDGE/CHROME/FIREFOX
    //    set env YTDLP_COOKIES_FROM_BROWSER=edge | chrome | firefox
    const fromBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER;
    if (fromBrowser && typeof fromBrowser === 'string' && fromBrowser.trim()) {
      return { 'cookies-from-browser': fromBrowser.trim() };
    }

    // 2) Use an on-disk cookies.txt file (Netscape format)
    const filePath = process.env.YTDLP_COOKIES_FILE;
    if (filePath && fs.existsSync(filePath)) {
      return { cookies: filePath };
    }

    // 3) Use cookies provided directly via env var (plain text or base64)
    const text = process.env.YTDLP_COOKIES_TEXT;
    const b64 = process.env.YTDLP_COOKIES_BASE64;
    if ((text && text.trim()) || (b64 && b64.trim())) {
      if (!CACHED_COOKIES_FILE) {
        const content = text && text.trim() ? text : Buffer.from(b64, 'base64').toString('utf8');
        const target = path.join(process.cwd(), 'cookies.youtube.txt');
        try { fs.writeFileSync(target, content, 'utf8'); } catch {}
        CACHED_COOKIES_FILE = target;
      }
      return { cookies: CACHED_COOKIES_FILE };
    }
  } catch {}
  return {};
}

// Simple youtube-dl-exec wrapper functions
async function runYoutubeDl(url, options = {}) {
  try {
    const result = await youtubedl(url, options);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error.message || 'Unknown error' };
  }
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

async function downloadWithYoutubeDl(url, { audioOnly = false, bitrateKbps = 192 } = {}) {
  const outDir = path.join(process.cwd(), 'downloads');
  ensureDir(outDir);
  const ffmpegBin = resolveLocalFfmpegBinary();
  const startMs = Date.now();

  const outputTemplate = path.join(outDir, '%(title).150B-%(id)s.%(ext)s');
  
  const cookieOpts = resolveCookiesOption();
  const options = {
    output: outputTemplate,
    noPlaylist: true,
    restrictFilenames: true,
    print: ['after_move:filepath', 'filepath', 'filename'],
    addHeader: [
      `User-Agent: ${DEFAULT_HEADERS['User-Agent']}`,
      'Accept-Language: en-US,en;q=0.9',
      'Referer: https://www.youtube.com/'
    ],
    ...cookieOpts,
  };

  if (ffmpegBin) {
    options.ffmpegLocation = ffmpegBin;
  }

  if (audioOnly) {
    options.extractAudio = true;
    options.audioFormat = 'mp3';
    options.audioQuality = String(bitrateKbps);
    options.format = 'bestaudio/best';
  } else {
    options.format = 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b';
  }

  const result = await runYoutubeDl(url, options);
  if (!result.ok) {
    throw new Error(`youtube-dl-exec failed: ${result.error}`);
  }

  // Find the downloaded file
  const extList = audioOnly ? ['.mp3'] : ['.mp4'];
  const newest = getNewestFileInDirectory(outDir, extList, startMs - 1000);
  if (!newest || !fs.existsSync(newest)) {
    throw new Error('youtube-dl-exec finished but output file could not be determined');
  }
  
  const filename = path.basename(newest);
  const fileUrl = await getFileUrl(newest, filename);
  
  return {
    path: newest,
    filename,
    url: fileUrl,
  };
}

async function downloadWithYoutubeDlStreaming(url, { audioOnly = false, bitrateKbps = 192, progressId } = {}) {
  const outDir = path.join(process.cwd(), 'downloads');
  ensureDir(outDir);
  const ffmpegBin = resolveLocalFfmpegBinary();
  const startMs = Date.now();

  const outputTemplate = path.join(outDir, '%(title).150B-%(id)s.%(ext)s');
  
  const cookieOpts = resolveCookiesOption();
  const options = {
    output: outputTemplate,
    noPlaylist: true,
    restrictFilenames: true,
    print: ['after_move:filepath', 'filepath', 'filename'],
    addHeader: [
      `User-Agent: ${DEFAULT_HEADERS['User-Agent']}`,
      'Accept-Language: en-US,en;q=0.9',
      'Referer: https://www.youtube.com/'
    ],
    ...cookieOpts,
  };

  if (ffmpegBin) {
    options.ffmpegLocation = ffmpegBin;
  }

  if (audioOnly) {
    options.extractAudio = true;
    options.audioFormat = 'mp3';
    options.audioQuality = String(bitrateKbps);
    options.format = 'bestaudio/best';
  } else {
    options.format = 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b';
  }

  // For streaming version, we'll use the same approach but with progress updates
  // Note: youtube-dl-exec doesn't support real-time progress like the old spawn approach
  // So we'll simulate progress updates
  if (progressId) {
    setProgress(progressId, { status: 'downloading', percent: 0, etaSeconds: null });
    
    // Simulate progress updates every 2 seconds
    const progressInterval = setInterval(() => {
      const current = progressStates.get(progressId);
      if (current && current.status === 'downloading') {
        const elapsed = (Date.now() - current.startedAt) / 1000;
        // Estimate progress based on time (this is a fallback since we can't get real progress)
        const estimatedPercent = Math.min(90, Math.floor(elapsed / 30 * 100)); // Assume 30 seconds for most videos
        setProgress(progressId, { percent: estimatedPercent });
      }
    }, 2000);

    // Clear interval after 3 minutes or when done
    setTimeout(() => clearInterval(progressInterval), 180000);
  }

  const result = await runYoutubeDl(url, options);
  if (!result.ok) {
    if (progressId) finishProgress(progressId, false, { error: result.error });
    throw new Error(`youtube-dl-exec failed: ${result.error}`);
  }

  // Find the downloaded file
  const extList = audioOnly ? ['.mp3'] : ['.mp4'];
  const newest = getNewestFileInDirectory(outDir, extList, startMs - 1000);
  if (!newest || !fs.existsSync(newest)) {
    if (progressId) finishProgress(progressId, false, { error: 'Output file not found' });
    throw new Error('youtube-dl-exec finished but output file could not be determined');
  }

  if (progressId) finishProgress(progressId, true, { file: path.basename(newest) });
  
  const filename = path.basename(newest);
  const fileUrl = await getFileUrl(newest, filename);
  
  return {
    path: newest,
    filename,
    url: fileUrl,
  };
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
        console.log('Stream error, trying yt-dlp fallback:', err.message);
        try {
          const fallback = progressId
            ? await downloadWithYoutubeDlStreaming(url, { audioOnly: false, progressId })
            : await downloadWithYoutubeDl(url, { audioOnly: false });
          finalize(200, fallback);
        } catch (fallbackErr) {
          if (progressId) finishProgress(progressId, false);
          finalize(500, { error: `Download failed: ${err.message}; youtube-dl-exec fallback failed: ${fallbackErr.message}` });
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
            ? await downloadWithYoutubeDlStreaming(url, { audioOnly: false, progressId })
            : await downloadWithYoutubeDl(url, { audioOnly: false });
          finalize(200, fallback);
        } catch (fallbackErr) {
          if (progressId) finishProgress(progressId, false, { error: err.message });
          finalize(500, { error: `File write failed: ${err.message}; youtube-dl-exec fallback failed: ${fallbackErr.message}` });
        }
      });

      stream.pipe(write);
    } catch (infoError) {
      console.log('ytdl-core failed, trying yt-dlp fallback:', infoError.message);
      try {
        const fallback = req.body?.progressId
          ? await downloadWithYoutubeDlStreaming(url, { audioOnly: false, progressId: req.body.progressId })
          : await downloadWithYoutubeDl(url, { audioOnly: false });
        return res.json(fallback);
      } catch (fallbackErr) {
        console.error('Both ytdl-core and youtube-dl-exec failed:', infoError.message, fallbackErr.message);
        if (req.body?.progressId) finishProgress(req.body.progressId, false, { error: infoError.message });
        return res.status(500).json({ error: `Failed to get video info: ${infoError.message}; youtube-dl-exec fallback failed: ${fallbackErr.message}` });
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
              ? await downloadWithYoutubeDlStreaming(url, { audioOnly: true, bitrateKbps: bitrate, progressId })
              : await downloadWithYoutubeDl(url, { audioOnly: true, bitrateKbps: bitrate });
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
          ? await downloadWithYoutubeDlStreaming(url, { audioOnly: true, bitrateKbps: bitrate, progressId: req.body.progressId })
          : await downloadWithYoutubeDl(url, { audioOnly: true, bitrateKbps: bitrate });
        if (req.body?.progressId) finishProgress(req.body.progressId, true);
        return res.json(fallback);
      } catch (fallbackErr) {
        if (req.body?.progressId) finishProgress(req.body.progressId, false);
        return res.status(500).json({ error: `Failed to get video info: ${infoError.message}; youtube-dl-exec fallback failed: ${fallbackErr.message}` });
      }
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 5174;
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));


