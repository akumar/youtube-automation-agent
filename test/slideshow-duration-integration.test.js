const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { checkFFmpeg, getMediaDuration, runFFmpeg } = require('../utils/ffmpeg');

test('slideshow mux loops short visuals and ends with 60-second narration', async (t) => {
  if (!(await checkFFmpeg())) return t.skip('FFmpeg is unavailable');
  try { require.resolve('playwright'); } catch { return t.skip('Playwright is unavailable'); }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slideshow-duration-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const audio = path.join(dir, 'audio.m4a');
  await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60', '-c:a', 'aac', audio]);
  const audioDuration = await getMediaDuration(audio);
  assert.ok(Math.abs(audioDuration - 60) < 0.3);
  const generator = new AIVideoGenerator({});
  const script = { title: 'Local duration test', mainContent: { sections: [
    { title: 'First', content: ['Array spoken content for slide one.'] },
    { title: 'Second', content: ['Array spoken content for slide two.'] }
  ] } };
  const final = path.join(dir, 'final.mp4');
  await generator.generateSlideshowVideo(script, [], audio, final);
  const visual = path.join(dir, 'final_visual.mp4');
  const visualDuration = await getMediaDuration(visual);
  const finalDuration = await getMediaDuration(final);
  assert.ok(visualDuration >= audioDuration - 0.3, 'generated visual track should span narration');
  assert.ok(Math.abs(finalDuration - audioDuration) < 0.5, 'final mux should match narration duration');
  const stills = [];
  for (let i = 0; i < 2; i++) {
    const still = path.join(dir, 'still-' + i + '.png');
    await sharp({ create: { width: 640, height: 360, channels: 3, background: i ? '#345' : '#234' } }).png().toFile(still);
    stills.push(still);
  }
  const shortVisual = path.join(dir, 'short.mp4');
  const extended = path.join(dir, 'extended.mp4');
  await generator.renderSlidesToVideo(stills, 8, shortVisual);
  const shortDuration = await getMediaDuration(shortVisual);
  await generator.muxSlideshowToNarration(shortVisual, audio, extended, audioDuration);
  const extendedDuration = await getMediaDuration(extended);
  assert.ok(shortDuration < audioDuration - 50, 'fixture visual should be shorter than narration');
  assert.ok(Math.abs(extendedDuration - audioDuration) < 0.5, 'looped mux should end with narration');
  t.diagnostic(JSON.stringify({ audioDuration, visualDuration, finalDuration, shortDuration, extendedDuration }));
});
