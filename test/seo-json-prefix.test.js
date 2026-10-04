const test = require('node:test');
const assert = require('node:assert/strict');
const { SEOOptimizerAgent } = require('../agents/seo-optimizer-agent');

test('SEO parsing accepts a User Safety prefix before the JSON object', async () => {
  const agent = new SEOOptimizerAgent({}, {});
  agent.aiTextService = {
    isAvailable: () => true,
    providerName: 'OpenRouter',
    generateText: async () => `User Safety: safe\n{
      "title": "A useful SEO title",
      "description": "A clear video description",
      "tags": ["topic", "guide"]
    }`,
  };

  const result = await agent.generateSEOWithAI(
    { title: 'Original title' },
    { topic: 'Topic', angle: 'Practical guide', contentType: 'Tutorial', targetAudience: 'Learners', keywords: ['fallback'] }
  );

  assert.deepEqual(result, {
    title: 'A useful SEO title',
    description: 'A clear video description',
    tags: ['topic', 'guide'],
  });
});

test('SEO JSON extraction strips optional Markdown fences and handles braces in strings', () => {
  const agent = new SEOOptimizerAgent({}, {});
  const parsed = agent.parseAIJsonResponse(`\`\`\`json\n{"title":"A {title}","description":"Details","tags":["one"]}\n\`\`\``);

  assert.deepEqual(parsed, { title: 'A {title}', description: 'Details', tags: ['one'] });
});

test('SEO JSON extraction rejects responses without a valid JSON object', () => {
  const agent = new SEOOptimizerAgent({}, {});

  assert.throws(
    () => agent.parseAIJsonResponse('User Safety: safe, but no structured result'),
    /AI SEO response does not contain a valid JSON object/
  );
  assert.throws(
    () => agent.parseAIJsonResponse('{"title":"valid"} trailing malformed output'),
    /AI SEO response does not contain a valid JSON object/
  );
  assert.throws(
    () => agent.parseAIJsonResponse('[{"title":"not an object response"}]'),
    /AI SEO response does not contain a valid JSON object/
  );
});

test('SEO required title, description, and tags validation remains in force', async () => {
  const agent = new SEOOptimizerAgent({}, {});
  const warnings = [];
  agent.logger.warn = message => warnings.push(message);
  agent.aiTextService = {
    isAvailable: () => true,
    providerName: 'OpenRouter',
    generateText: async () => '{"title":"A title","tags":["topic"]}',
  };

  const result = await agent.generateSEOWithAI(
    { title: 'Original title' },
    { topic: 'Topic', angle: 'Guide', contentType: 'Tutorial', targetAudience: 'Learners', keywords: [] }
  );

  assert.equal(result, null);
  assert.ok(warnings.some(message => message.includes('AI SEO response missing required fields')));
});

test('SEO chapter and description timestamps estimate from normalized section content', async () => {
  const agent = new SEOOptimizerAgent({}, {});
  const longText = Array(150).fill('spoken').join(' ');
  const sections = [
    { title: 'String section', content: longText },
    { title: 'Array section', content: [longText] },
    { title: 'Steps section', steps: [{ title: 'Step', description: longText }] },
    { title: 'Items section', items: [{ number: 1, title: 'Item', description: longText }] },
  ];
  const script = { title: 'A guide', mainContent: { sections } };
  const chapters = await agent.generateChapters(script);
  const description = await agent.generateDescription(script, {
    angle: 'a useful guide', topic: 'gardening', contentType: 'Tutorial', keywords: [], targetAudience: 'beginners'
  });
  let currentTime = 20;

  sections.forEach((section, index) => {
    const chapter = chapters[index + 1];
    assert.equal(chapter.seconds, currentTime);
    assert.match(description, new RegExp(`${chapter.time} ${section.title}`));
    currentTime += agent.sectionDurationSeconds(section);
  });
  assert.equal(chapters.at(-1).seconds, currentTime);
});
