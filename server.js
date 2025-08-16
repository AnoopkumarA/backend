const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

// Local storage only - simplified for Railway deployment

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

// Ensure downloads directory exists at startup (important for Railway/local storage)
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
// Rate limiting: track last request time to avoid hitting YouTube limits
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 5000; // 5 seconds between requests

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
      return;
    }
  };

  send(); // Send initial state
  const timer = setInterval(send, 1000);

  req.on('close', () => {
    clearInterval(timer);
  });
});

// Helper function to get local file URL
function getFileUrl(filename) {
  return `/downloads/${filename}`;
}

// Download video endpoint
app.post('/api/download', async (req, res) => {
  try {
    const { url, progressId } = req.body || {};
    if (!url || !ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    // Rate limiting: ensure minimum time between requests
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
      const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
      console.log(`Rate limiting: waiting ${waitTime}ms before processing request`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    lastRequestTime = Date.now();

    if (progressId) initProgress(progressId);

    console.log('Getting video info...');
    setProgress(progressId, { status: 'getting_info', percent: 10 });

    const info = await ytdl.getInfo(url);
    const videoTitle = info.videoDetails.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
    const filename = `${videoTitle}-${Date.now()}.mp4`;
    const filepath = path.join(process.cwd(), 'downloads', filename);

    setProgress(progressId, { status: 'downloading', percent: 20 });

    console.log('Starting download...');
    const stream = ytdl(url, { 
      quality: 'highest',
      filter: 'audioandvideo'
    });

    const writeStream = fs.createWriteStream(filepath);
    
    let downloadedBytes = 0;
    const totalBytes = parseInt(info.formats.find(f => f.quality === 'highest')?.contentLength || '0');
    
    stream.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      if (totalBytes > 0) {
        const percent = Math.min(90, 20 + (downloadedBytes / totalBytes) * 70);
        setProgress(progressId, { 
          status: 'downloading', 
          percent: Math.round(percent),
          etaSeconds: totalBytes > 0 ? Math.round((totalBytes - downloadedBytes) / (downloadedBytes / (Date.now() - (progressStates.get(progressId)?.startedAt || Date.now()))) / 1000) : null
        });
      }
    });

    stream.on('end', async () => {
      console.log('Download completed');
      setProgress(progressId, { status: 'processing', percent: 95 });
      
      try {
        // Get the final URL
        const finalUrl = getFileUrl(filename);
        
        finishProgress(progressId, true, { file: filename });
        
        res.json({
          success: true,
          filename,
          url: finalUrl,
          message: 'Video downloaded successfully'
        });
      } catch (err) {
        console.error('Post-download processing failed:', err.message);
        finishProgress(progressId, false, { error: err.message });
        res.status(500).json({ error: `Post-download processing failed: ${err.message}` });
      }
    });

    stream.on('error', (err) => {
      console.error('Download stream error:', err.message);
      finishProgress(progressId, false, { error: err.message });
      res.status(500).json({ error: `Download failed: ${err.message}` });
    });

    writeStream.on('error', (err) => {
      console.error('File write error:', err.message);
      finishProgress(progressId, false, { error: err.message });
      res.status(500).json({ error: `File write failed: ${err.message}` });
    });

    stream.pipe(writeStream);

  } catch (err) {
    console.error('Download endpoint error:', err.message);
    if (progressId) finishProgress(progressId, false, { error: err.message });
    res.status(500).json({ error: `Download failed: ${err.message}` });
  }
});

// Download MP3 endpoint
app.post('/api/download-mp3', async (req, res) => {
  try {
    const { url, progressId } = req.body || {};
    if (!url || !ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    // Rate limiting: ensure minimum time between requests
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
      const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
      console.log(`Rate limiting: waiting ${waitTime}ms before processing request`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    lastRequestTime = Date.now();

    if (progressId) initProgress(progressId);

    console.log('Getting video info for MP3...');
    setProgress(progressId, { status: 'getting_info', percent: 10 });

    const info = await ytdl.getInfo(url);
    const videoTitle = info.videoDetails.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
    const tempFilename = `${videoTitle}-${Date.now()}-temp.mp4`;
    const filename = `${videoTitle}-${Date.now()}.mp3`;
    const tempFilepath = path.join(process.cwd(), 'downloads', tempFilename);
    const filepath = path.join(process.cwd(), 'downloads', filename);

    setProgress(progressId, { status: 'downloading', percent: 20 });

    console.log('Starting audio download...');
    const stream = ytdl(url, { 
      quality: 'highestaudio',
      filter: 'audioonly'
    });

    const writeStream = fs.createWriteStream(tempFilepath);
    
    let downloadedBytes = 0;
    const totalBytes = parseInt(info.formats.find(f => f.quality === 'highestaudio')?.contentLength || '0');
    
    stream.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      if (totalBytes > 0) {
        const percent = Math.min(70, 20 + (downloadedBytes / totalBytes) * 50);
        setProgress(progressId, { 
          status: 'downloading', 
          percent: Math.round(percent),
          etaSeconds: totalBytes > 0 ? Math.round((totalBytes - downloadedBytes) / (downloadedBytes / (Date.now() - (progressStates.get(progressId)?.startedAt || Date.now()))) / 1000) : null
        });
      }
    });

    stream.on('end', async () => {
      console.log('Audio download completed, converting to MP3...');
      setProgress(progressId, { status: 'converting', percent: 80 });
      
      try {
        // Convert to MP3 using ffmpeg
        await new Promise((resolve, reject) => {
          ffmpeg(tempFilepath)
            .audioCodec('libmp3lame')
            .audioBitrate(192)
            .on('end', resolve)
            .on('error', reject)
            .save(filepath);
        });
        
        console.log('MP3 conversion completed');
        setProgress(progressId, { status: 'processing', percent: 95 });
        
        // Clean up temp file
        try {
          fs.unlinkSync(tempFilepath);
        } catch (err) {
          console.warn('Failed to cleanup temp file:', err.message);
        }
        
        // Get the final URL
        const finalUrl = getFileUrl(filename);
        
        finishProgress(progressId, true, { file: filename });
        
        res.json({
          success: true,
          filename,
          url: finalUrl,
          message: 'MP3 converted successfully'
        });
      } catch (err) {
        console.error('MP3 conversion failed:', err.message);
        finishProgress(progressId, false, { error: err.message });
        res.status(500).json({ error: `MP3 conversion failed: ${err.message}` });
      }
    });

    stream.on('error', (err) => {
      console.error('Audio download stream error:', err.message);
      finishProgress(progressId, false, { error: err.message });
      res.status(500).json({ error: `Audio download failed: ${err.message}` });
    });

    writeStream.on('error', (err) => {
      console.error('Temp file write error:', err.message);
      finishProgress(progressId, false, { error: err.message });
      res.status(500).json({ error: `Temp file write failed: ${err.message}` });
    });

    stream.pipe(writeStream);

  } catch (err) {
    console.error('MP3 download endpoint error:', err.message);
    if (progressId) finishProgress(progressId, false, { error: err.message });
    res.status(500).json({ error: `MP3 download failed: ${err.message}` });
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'YouTube Downloader Backend is running',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 5174;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Downloads directory: ${path.join(process.cwd(), 'downloads')}`);
  console.log(`Storage: Local filesystem`);
});


