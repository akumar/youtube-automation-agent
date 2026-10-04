const test = require('node:test');
const assert = require('node:assert/strict');
const { AITextService, PROVIDERS } = require('../utils/ai-text-service');

const providerKeys = [
  'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL',
  'MOONSHOT_API_KEY', 'MIMO_API_KEY', 'GLM_API_KEY', 'GEMINI_API_KEY'
];

function configureEnv(t, values) {
  const previous = new Map(providerKeys.map(key => [key, process.env[key]]));
  for (const key of providerKeys) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('OPENROUTER_MODEL overrides the model when OpenRouter is selected by environment key', t => {
  configureEnv(t, {
    OPENROUTER_API_KEY: 'test-key',
    OPENROUTER_MODEL: 'openrouter/free'
  });

  const service = new AITextService();
  assert.equal(service.providerName, 'OpenRouter');
  assert.equal(service.model, 'openrouter/free');
});

test('OpenRouter keeps its existing default model when OPENROUTER_MODEL is unset', t => {
  configureEnv(t, { OPENROUTER_API_KEY: 'test-key' });

  const service = new AITextService();
  assert.equal(service.providerName, 'OpenRouter');
  assert.equal(service.model, PROVIDERS.openrouter.defaultModel);
  assert.equal(service.model, 'openai/gpt-5.6-sol');
});

test('OPENROUTER_MODEL overrides a configured OpenRouter model only', t => {
  configureEnv(t, { OPENROUTER_MODEL: 'openrouter/free' });

  const service = new AITextService({
    aiProvider: { provider: 'openrouter', apiKey: 'test-key', model: 'openai/gpt-5.6-sol' }
  });
  assert.equal(service.providerName, 'OpenRouter');
  assert.equal(service.model, 'openrouter/free');
});
