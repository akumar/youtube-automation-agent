const test = require('node:test');
const assert = require('node:assert/strict');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { normalizeSectionContent, getSectionSpokenText, estimateTextDuration } = require('../utils/script-content');
const { ProductionManagementAgent } = require('../agents/production-management-agent');
const { ScriptWriterAgent } = require('../agents/script-writer-agent');

test('slideshow mux forwards measured narration duration to the looped mux', async () => {
  const generator = new AIVideoGenerator({});
  let options;
  generator.addAudioToVideo = async (_video, _audio, _output, suppliedOptions) => { options = suppliedOptions; };
  await generator.muxSlideshowToNarration('visual.mp4', 'audio.m4a', 'final.mp4', 60);
  assert.deepEqual(options, { loopVideo: true, audioDurationSeconds: 60 });
});

test('shared section normalization handles string, array, steps, and items consistently', () => {
  const structured = [
    { content: '  A spoken sentence.  ' },
    { content: [' First line. ', '[visual cue]', 'Second line.'] },
    { steps: [{ title: 'Step one', description: 'Explain the first step.', tip: 'Keep it simple.' }] },
    { items: [{ number: 1, title: 'First item', description: 'Explain the first item.' }] },
  ];
  const normalized = structured.map(normalizeSectionContent);

  assert.deepEqual(normalized[0], ['A spoken sentence.']);
  assert.deepEqual(normalized[1], ['First line.', 'Second line.']);
  assert.deepEqual(normalized[2], ['Step one. Explain the first step. Keep it simple.']);
  assert.deepEqual(normalized[3], ['Number 1: First item. Explain the first item.']);
  normalized.forEach((lines, index) => {
    assert.equal(getSectionSpokenText(structured[index]), lines.join(' '));
    assert.equal(estimateTextDuration(getSectionSpokenText(structured[index])), estimateTextDuration(lines.join(' ')));
  });
});

test('ScriptWriter normalizes structured step and item sections before estimating spoken duration', () => {
  const longText = Array(150).fill('spoken').join(' ');
  const writer = new ScriptWriterAgent({}, {});
  const sections = writer.normalizeAISections([
    { title: 'String', content: longText },
    { title: 'Array', content: [longText] },
    { title: 'Steps', steps: [{ title: 'Step', description: longText }] },
    { title: 'Items', items: [{ number: 1, title: 'Item', description: longText }] },
  ], { topic: 'Topic' });

  assert.equal(sections.length, 4);
  sections.forEach(section => {
    assert.ok(section.content.length > 0);
    assert.equal(section.duration, estimateTextDuration(section.content.join(' ')));
  });
});

test('draft-only keeps the strategy recommendation but leaves actual scheduled time empty', () => {
  const recommendedTime = '2026-10-08T08:30:00.000Z';
  const draftAgent = new ProductionManagementAgent({}, {}, { draftOnly: true });
  const productionAgent = new ProductionManagementAgent({}, {}, { draftOnly: false });

  assert.equal(draftAgent.getScheduledPublishTime({ bestPublishTime: recommendedTime }), null);
  assert.equal(productionAgent.getScheduledPublishTime({ bestPublishTime: recommendedTime }), recommendedTime);
  assert.equal(draftAgent.calculatePublishTime({ bestPublishTime: recommendedTime }), recommendedTime);
});
