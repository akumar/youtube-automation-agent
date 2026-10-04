const test = require('node:test');
const assert = require('node:assert/strict');
const { ScriptWriterAgent } = require('../agents/script-writer-agent');

const strategy = {
  topic: 'safe home gardening',
  contentType: 'Explainer',
  angle: 'A practical guide',
  targetAudience: 'new gardeners',
  keywords: ['gardening'],
  researchSources: [],
};
const template = { tone: 'informative', pacing: 'steady' };

function validScriptResponse() {
  return JSON.stringify({
    title: 'A Practical Gardening Guide',
    hook: 'Start with one small growing space.',
    sections: [{ title: 'Start small', content: ['Choose a sunny spot.'], duration: 30 }],
    cta: 'Try planting one herb this week.',
    claims: [],
  });
}

function agentWithResponses(responses) {
  const agent = new ScriptWriterAgent({ saveScript: async () => {} }, {});
  let index = 0;
  const prompts = [];
  agent.aiTextService = {
    isAvailable: () => true,
    providerName: 'OpenRouter',
    generateText: async prompt => {
      prompts.push(prompt);
      const response = responses[index++];
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { agent, prompts, get calls() { return index; } };
}

test('ScriptWriter accepts a successful first JSON response without retrying', async () => {
  const setup = agentWithResponses([validScriptResponse()]);
  const result = await setup.agent.generateScriptWithAI(strategy, template);

  assert.equal(result.metadata.generationSource, 'ai');
  assert.equal(setup.calls, 1);
  assert.equal(setup.prompts.length, 1);
});

test('ScriptWriter retries once after a safety-only response and accepts valid JSON', async () => {
  const setup = agentWithResponses(['User Safety: safe', validScriptResponse()]);
  const result = await setup.agent.generateScriptWithAI(strategy, template);

  assert.equal(result.metadata.generationSource, 'ai');
  assert.equal(setup.calls, 2);
  assert.match(setup.prompts[1], /Return ONLY one valid JSON object/);
  assert.match(setup.prompts[1], /no safety labels, commentary, Markdown, or prose/);
});

test('ScriptWriter falls back after one failed retry and does not loop', async () => {
  const setup = agentWithResponses(['User Safety: safe', 'User Safety: safe']);
  const result = await setup.agent.generateScript(strategy);

  assert.equal(setup.calls, 2);
  assert.equal(result.metadata.generationSource, undefined);
  assert.ok(result.fullScript.length > 0);
});

test('ScriptWriter retries an empty first response only once', async () => {
  const setup = agentWithResponses(['', '']);
  const result = await setup.agent.generateScriptWithAI(strategy, template);

  assert.equal(result, null);
  assert.equal(setup.calls, 2);
});
