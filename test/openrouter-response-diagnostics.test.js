const test = require('node:test');
const assert = require('node:assert/strict');
const { AITextService } = require('../utils/ai-text-service');
const { ScriptWriterAgent } = require('../agents/script-writer-agent');

function configureOpenRouter(t) {
  const previous = {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_MODEL = 'openrouter/free';
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('OpenRouter empty content is diagnosed without logging response text', async t => {
  configureOpenRouter(t);
  const service = new AITextService();
  const diagnostics = [];
  service.logger.info = (message, data) => diagnostics.push({ message, data });
  service.client.chat.completions.create = async () => ({
    choices: [{ message: { content: '', refusal: null }, finish_reason: 'stop' }],
  });

  await assert.rejects(service.generateText('private prompt'), /OpenRouter returned an empty response/);
  assert.deepEqual(diagnostics, [{
    message: 'OpenRouter response diagnostics',
    data: {
      provider: 'OpenRouter',
      model: 'openrouter/free',
      choicesCount: 1,
      messageType: 'object',
      contentType: 'string',
      contentLength: 0,
      finishReason: 'stop',
      refusalPresent: false,
      refusalType: 'null',
    },
  }]);
  assert.equal(JSON.stringify(diagnostics).includes('private prompt'), false);
});

test('ScriptWriter logs which required fields failed without weakening validation', async t => {
  configureOpenRouter(t);
  const agent = new ScriptWriterAgent({}, {});
  const warnings = [];
  agent.logger.warn = (message, data) => warnings.push({ message, data });
  let capturedPrompt;
  let requestCount = 0;
  agent.aiTextService = {
    isAvailable: () => true,
    providerName: 'OpenRouter',
    generateText: async prompt => {
      requestCount++;
      capturedPrompt = prompt;
      return JSON.stringify({
        title: 'Present title',
        hook: 'Present hook',
        sections: [],
        cta: 'Present CTA',
        claims: [],
      });
    },
  };

  const result = await agent.generateScriptWithAI(
    { topic: 'Topic', contentType: 'Explainer' },
    { tone: 'informative', pacing: 'steady' }
  );

  assert.equal(result, null);
  assert.deepEqual(warnings[0], {
    message: 'AI script response failed required-field validation',
    data: {
      hasTitle: true,
      hasHook: true,
      sectionCount: 0,
      sectionsWithSpokenContent: 0,
      hasCTA: true,
      claimsType: 'array',
    },
  });
  assert.equal(JSON.stringify(warnings).includes('Present title'), false);
  assert.equal(requestCount, 1, 'parseable JSON that fails schema validation is not retried');
  assert.match(capturedPrompt, /Return ONLY the JSON object with this exact shape/);
  assert.match(capturedPrompt, /Do not include safety labels, preambles, explanations, commentary, or Markdown fences/);
});
