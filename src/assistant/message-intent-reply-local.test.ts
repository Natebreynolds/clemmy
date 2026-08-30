import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyMessageIntent } from './message-intent.js';

test('reply-local construction stays conversational without catalog or effect authority', () => {
  const prompts = [
    'Create a haiku about rain.',
    'Write a limerick about cats.',
    'Build a simple packing checklist.',
    'Generate three title ideas.',
    'Prepare a short agenda.',
    'Design a simple workout.',
    'Rewrite this sentence: Hello.',
    'Make a two-item grocery list.',
    'Produce a short bedtime story.',
    'Create a four-line poem.',
    'Could you write a short toast?',
    'Please create a concise strategy outline.',
  ];
  for (const prompt of prompts) {
    const result = classifyMessageIntent(prompt);
    assert.equal(result.intent, 'conversation', `${prompt}: ${JSON.stringify(result)}`);
    assert.ok(result.confidence >= 0.8, prompt);
  }
});

test('durable, current-world, named-system, and compound construction remains action-capable', () => {
  const prompts = [
    'Create three Todoist tasks.',
    'Write this to a Desktop file.',
    'Build a simple website.',
    'Create an API endpoint.',
    'Prepare a Google Sheet.',
    'Design a new workflow.',
    'Generate an image of a lighthouse.',
    'Create a report from the latest pipeline.',
    'Write a poem, then save it to Desktop.',
    'Rewrite the existing Project Note.',
    'Make a calendar event for tomorrow.',
    'Produce a PDF and email it to Alex.',
    'Build a status page and keep it updated every week.',
    'Prepare a client portal.',
    'Write a book.',
  ];
  for (const prompt of prompts) {
    assert.notEqual(classifyMessageIntent(prompt).intent, 'conversation', prompt);
  }
});
