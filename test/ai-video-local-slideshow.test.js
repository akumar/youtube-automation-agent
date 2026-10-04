const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { MediaGenerationService } = require('../utils/media-generation-service');

function setEnv(values) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function createGenerator(provider = 'slideshow') {
  const registry = {
    select: () => ({ id: provider })
  };
  const mediaGeneration = new MediaGenerationService({
    getAllSettings: async () => ({ video_provider: 'wan' })
  }, {}, { registry });
  return new AIVideoGenerator({ gemini: { apiKey: 'test-key' } }, { mediaGeneration });
}

test('local slideshow routing never submits clips to an external provider', async t => {
  const restore = setEnv({
    VIDEO_PROVIDER: 'slideshow',
    VIDEO_GENERATION_MODE: 'hybrid',
    VIDEO_MAX_GENERATED_SECONDS: undefined
  });
  t.after(restore);

  let createTaskCalls = 0;
  const localProvider = { id: 'slideshow', describe: () => ({ model: 'local-ffmpeg' }) };
  const externalProvider = {
    id: 'wan',
    describe: () => ({ model: 'wan-stub' }),
    normalizeRequest: request => request,
    createTask: async () => {
      createTaskCalls++;
      throw new Error('External provider must not be called');
    }
  };
  const registry = {
    select: requested => requested === 'slideshow' ? localProvider : externalProvider
  };
  const mediaGeneration = new MediaGenerationService({
    getAllSettings: async () => ({ video_provider: 'wan' })
  }, {}, { registry });
  const args = { productionId: 'local-test', script: {}, outputDir: 'unused' };

  const slideshowResult = await mediaGeneration.generateClips(args);
  assert.deepEqual(slideshowResult.clips, []);
  assert.equal(slideshowResult.actualProvider, 'slideshow');
  assert.equal(createTaskCalls, 0);

  process.env.VIDEO_PROVIDER = 'wan';
  process.env.VIDEO_MAX_GENERATED_SECONDS = '0';
  const zeroDurationResult = await mediaGeneration.generateClips(args);
  assert.deepEqual(zeroDurationResult.clips, []);
  assert.equal(zeroDurationResult.actualProvider, 'slideshow');
  assert.equal(createTaskCalls, 0);
});

test('slideshow mode creates a valid local thumbnail without calling Gemini image generation', async t => {
  const restore = setEnv({ VIDEO_PROVIDER: 'slideshow', GEMINI_API_KEY: 'test-key', OPENAI_API_KEY: undefined });
  t.after(restore);
  const generator = createGenerator();
  let imageCalls = 0;
  generator.generateImage = async () => { imageCalls++; throw new Error('Image provider should not be called'); };

  const thumbnail = await generator.generateThumbnail({ title: 'A local slideshow thumbnail' });
  t.after(() => fs.unlink(thumbnail.path).catch(() => {}));
  const metadata = await sharp(thumbnail.path).metadata();
  assert.equal(imageCalls, 0);
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 1280);
  assert.equal(metadata.height, 720);
  assert.equal(thumbnail.generatedWith, 'local-slideshow');
});

test('local thumbnail XML-escapes dynamic title and style text', async t => {
  const restore = setEnv({ VIDEO_PROVIDER: 'slideshow', GEMINI_API_KEY: 'test-key', OPENAI_API_KEY: undefined });
  t.after(restore);
  const generator = createGenerator();

  const thumbnail = await generator.generateLocalThumbnail(
    { title: 'R&D <ideas> "quoted" and \'draft\'' },
    'local & safe <style> "quoted" \'style\''
  );
  t.after(() => fs.unlink(thumbnail.path).catch(() => {}));

  const metadata = await sharp(thumbnail.path).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 1280);
  assert.equal(metadata.height, 720);
});

test('slideshow mode returns no visual assets without calling Gemini image generation', async t => {
  const restore = setEnv({ VIDEO_PROVIDER: 'slideshow', GEMINI_API_KEY: 'test-key', OPENAI_API_KEY: undefined });
  t.after(restore);
  const generator = createGenerator();
  let imageCalls = 0;
  generator.generateImage = async () => { imageCalls++; throw new Error('Image provider should not be called'); };

  assert.deepEqual(await generator.generateVisualAssets('scene prompt', 'ethereal', 2), []);
  assert.equal(imageCalls, 0);
});

test('Gemini TTS remains selectable in slideshow mode', async t => {
  const restore = setEnv({ VIDEO_PROVIDER: 'slideshow', GEMINI_API_KEY: 'test-key', OPENAI_API_KEY: undefined });
  t.after(restore);
  const generator = createGenerator();
  let ttsCalls = 0;
  generator.generateGeminiTTS = async (_text, outputPath) => { ttsCalls++; return outputPath; };
  generator.isUsableAudioFile = async () => true;

  const result = await generator.generateTTSAudio('Narration text', path.join('temp', 'narration.mp3'));
  assert.equal(result, path.join('temp', 'narration.mp3'));
  assert.equal(ttsCalls, 1);
  assert.equal(generator.lastNarrationResult.provider, 'gemini');
});

test('an external video provider preserves image-provider behavior', async t => {
  const restore = setEnv({ VIDEO_PROVIDER: 'wan', GEMINI_API_KEY: 'test-key', OPENAI_API_KEY: undefined });
  t.after(restore);
  const generator = createGenerator('wan');
  let imageCalls = 0;
  generator.generateImage = async (_prompt, imagePath) => {
    imageCalls++;
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#334455' } }).png().toFile(imagePath);
    return imagePath;
  };

  const thumbnail = await generator.generateThumbnail({ title: 'External provider thumbnail' });
  t.after(() => fs.unlink(thumbnail.path).catch(() => {}));
  const visuals = await generator.generateVisualAssets('scene prompt', 'ethereal', 1);
  t.after(() => Promise.all(visuals.map(file => fs.unlink(file).catch(() => {}))));
  assert.equal(imageCalls, 2);
  assert.equal((await sharp(thumbnail.path).metadata()).format, 'png');
  assert.equal(visuals.length, 1);
});
