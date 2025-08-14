#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const inquirer = require('inquirer');
const ytdl = require('@distube/ytdl-core');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const ora = require('ora');
const chalk = require('chalk');

// Wire ffmpeg-static to fluent-ffmpeg
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

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

async function downloadVideo(url, outputDir) {
  ensureDir(outputDir);
  const info = await ytdl.getInfo(url, { requestOptions: { headers: DEFAULT_HEADERS } });
  const title = info.videoDetails.title.replace(/[<>:"/\\|?*]/g, '_');
  const id = info.videoDetails.videoId;
  const filename = `${title}-${id}.mp4`;
  const outPath = path.join(outputDir, filename);

  const spinner = ora(`Downloading ${chalk.cyan(title)}`).start();
  await new Promise((resolve, reject) => {
    ytdl(url, {
      filter: 'audioandvideo',
      quality: 'highest',
      requestOptions: { headers: DEFAULT_HEADERS },
      range: { start: 0 },
      begin: '0s',
    })
      .pipe(fs.createWriteStream(outPath))
      .on('finish', () => { spinner.succeed(`Saved to ${chalk.green(outPath)}`); resolve(); })
      .on('error', (err) => { spinner.fail('Download failed'); reject(err); });
  });
  return outPath;
}

async function convertToMp3(inputPath, bitrateKbps = 192) {
  if (!fs.existsSync(inputPath)) throw new Error(`File not found: ${inputPath}`);
  if (!ffmpegPath) throw new Error('FFmpeg not available. Install failed or unsupported platform.');

  const { name, dir } = path.parse(inputPath);
  const outPath = path.join(dir, `${name}.mp3`);

  const spinner = ora(`Converting to MP3 (${bitrateKbps} kbps)`).start();
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate(`${bitrateKbps}`)
      .noVideo()
      .on('error', (err) => { spinner.fail('Conversion failed'); reject(err); })
      .on('end', () => { spinner.succeed(`Saved to ${chalk.green(outPath)}`); resolve(); })
      .save(outPath);
  });
  return outPath;
}

async function downloadMp3(url, outputDir, bitrateKbps = 192) {
  ensureDir(outputDir);
  const info = await ytdl.getInfo(url, { requestOptions: { headers: DEFAULT_HEADERS } });
  const title = info.videoDetails.title.replace(/[<>:"/\\|?*]/g, '_');
  const id = info.videoDetails.videoId;
  const filename = `${title}-${id}.mp3`;
  const outPath = path.join(outputDir, filename);

  const spinner = ora(`Downloading MP3 ${chalk.cyan(title)} (${bitrateKbps} kbps)`).start();
  await new Promise((resolve, reject) => {
    const audioStream = ytdl(url, {
      filter: 'audioonly',
      quality: 'highestaudio',
      dlChunkSize: 0,
      highWaterMark: 1 << 26,
      requestOptions: { headers: DEFAULT_HEADERS },
      range: { start: 0 },
      begin: '0s',
    });

    ffmpeg(audioStream)
      .audioCodec('libmp3lame')
      .audioBitrate(`${bitrateKbps}`)
      .format('mp3')
      .outputOptions(['-threads 0'])
      .on('error', (err) => { spinner.fail('MP3 download failed'); reject(err); })
      .on('end', () => { spinner.succeed(`Saved to ${chalk.green(outPath)}`); resolve(); })
      .save(outPath);
  });
  return outPath;
}

async function interactiveMenu() {
  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'choice',
      message: 'Select an option',
      choices: [
        { name: 'Download a YouTube video', value: 'download' },
        { name: 'Convert an existing file to MP3', value: 'convert' },
        { name: 'Quit', value: 'quit' },
      ],
    },
  ]);

  if (answers.choice === 'quit') return;

  if (answers.choice === 'download') {
    const { url } = await inquirer.prompt([
      { type: 'input', name: 'url', message: 'Enter YouTube video URL:' },
    ]);
    if (!url || !ytdl.validateURL(url)) {
      console.log(chalk.red('Invalid YouTube URL.'));
      return;
    }
    const outputDir = path.join(process.cwd(), 'downloads');
    const file = await downloadVideo(url, outputDir);

    const { post } = await inquirer.prompt([
      { type: 'confirm', name: 'post', default: false, message: 'Download directly as MP3 instead?' },
    ]);
    if (post) {
      const { bitrate } = await inquirer.prompt([
        { type: 'input', name: 'bitrate', default: '192', message: 'Target MP3 bitrate (kbps):' },
      ]);
      await downloadMp3(url, path.join(process.cwd(), 'downloads'), parseInt(bitrate, 10) || 192);
    }
    return;
  }

  if (answers.choice === 'convert') {
    const { file, bitrate } = await inquirer.prompt([
      { type: 'input', name: 'file', message: 'Enter path to the existing media file:' },
      { type: 'input', name: 'bitrate', default: '192', message: 'Target MP3 bitrate (kbps):' },
    ]);
    await convertToMp3(file, parseInt(bitrate, 10) || 192);
    return;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await interactiveMenu();
    return;
  }

  // Simple flags: --url and --convert
  const getArg = (name) => {
    const idx = args.indexOf(name);
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
    return null;
  };

  const url = getArg('--url');
  const convertPath = getArg('--convert');
  const bitrate = parseInt(getArg('--audio-quality') || '192', 10) || 192;
  const mp3Flag = args.includes('--post-convert');

  if (url) {
    const outDir = path.join(process.cwd(), 'downloads');
    if (mp3Flag) {
      await downloadMp3(url, outDir, bitrate);
    } else {
      const file = await downloadVideo(url, outDir);
      // keep existing behavior without --post-convert
    }
    return;
  }

  if (convertPath) {
    await convertToMp3(convertPath, bitrate);
    return;
  }

  await interactiveMenu();
}

main().catch((err) => {
  console.error(chalk.red(err && err.message ? err.message : String(err)));
  process.exit(1);
});


