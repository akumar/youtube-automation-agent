const test = require('node:test');
const assert = require('node:assert/strict');
const { AIVideoGenerator } = require('../utils/ai-video-generator');

test('slideshow mux forwards measured narration duration to the looped mux', async () => {
  const generator = new AIVideoGenerator({});
  let options;
  generator.addAudioToVideo = async (_video, _audio, _output, suppliedOptions) => { options = suppliedOptions; };
  await generator.muxSlideshowToNarration('visual.mp4', 'audio.m4a', 'final.mp4', 60);
  assert.deepEqual(options, { loopVideo: true, audioDurationSeconds: 60 });
});
