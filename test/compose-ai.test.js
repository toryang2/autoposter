import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FAKE_CLAUDE } from './helpers.js';
import { buildComposePrompt, composePost, buildCommentPrompt, composeComment } from '../src/runner.js';

test('the AI writer asks for options in the chosen style, links in the first comment, no made-up facts', () => {
  const p = buildComposePrompt({ brief: 'Condo for rent in BGC, 25k/month', style: 'Professional', goal: 'Sell', audience: 'Home buyers', hook: 'Question', framework: 'PAS (Problem, Agitate, Solve)', cta: 'Send me a message', extra: 'Mention parking', language: 'Taglish', length: 'short', hashtags: true, platforms: ['Facebook'] });
  assert.match(p, /Condo for rent in BGC/);
  for (const re of [/Goal of the post: Sell/, /Written for: Home buyers/, /question hook/, /PAS/, /Send me a message/, /Mention parking/, /Writing style: Professional/]) assert.match(p, re);
  assert.match(p, /Taglish/);
  assert.match(p, /hashtags/);
  assert.match(p, /Do not use emojis/);
  assert.match(p, /first_comment/);
  assert.match(p, /Never invent/);
  assert.match(buildComposePrompt({ draft: 'my draft' }), /Improve this draft/);
  assert.match(buildComposePrompt({ brief: 'x', limit: { n: 280, unit: 'characters' } }), /about 280 characters/);
});

test('the AI writer runs claude with no tools and returns its options', async () => {
  const rec = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-')), 'rec.json');
  process.env.FAKE_MODE = 'compose';
  process.env.FAKE_RECORD = rec;
  try {
    const out = await composePost({ brief: 'Shoes sale' }, { claudeBin: FAKE_CLAUDE });
    assert.equal(out.options.length, 2);
    assert.equal(out.options[1].first_comment, "Here's the link: https://x.com");
    const { args, input } = JSON.parse(fs.readFileSync(rec, 'utf8'));
    assert.ok(args.includes('Bash') && args.includes('WebFetch') && !args.includes('--chrome') && !args.includes('--bare'));
    assert.match(input, /Shoes sale/);
    process.env.FAKE_MODE = 'garbage';
    assert.ok((await composePost({ brief: 'x' }, { claudeBin: FAKE_CLAUDE })).error);
  } finally {
    delete process.env.FAKE_MODE;
    delete process.env.FAKE_RECORD;
  }
});

test('the first-comment writer works from the post and never invents links', async () => {
  const p = buildCommentPrompt({ post: 'Soy candles, $15', notes: 'https://shop.example', kind: 'link', language: 'Spanish' });
  assert.match(p, /Soy candles/);
  assert.match(p, /https:\/\/shop\.example/);
  assert.match(p, /Spanish/);
  assert.match(p, /Never invent links/);
  process.env.FAKE_MODE = 'comment';
  try {
    const out = await composeComment({ post: 'Soy candles' }, { claudeBin: FAKE_CLAUDE });
    assert.deepEqual(out.options, ['Grab yours here: https://x.com', 'Which scent would you pick?']);
  } finally { delete process.env.FAKE_MODE; }
});

test('the image designer asks for fixed-size HTML with no scripts or outside files, and the photo placeholder when asked', async () => {
  const { buildImagePrompt } = await import('../src/runner.js');
  const p = buildImagePrompt({ brief: 'Sale 20% off', size: 'portrait', photo: true, colors: 'orange and black' });
  assert.match(p, /1080x1350/);
  assert.match(p, /\{\{PHOTO1\}\}/);
  assert.match(buildImagePrompt({ brief: 'x', photos: 3 }), /Combine the owner's 3 photos[\s\S]*\{\{PHOTO3\}\}/);
  assert.match(p, /No JavaScript/);
  assert.match(p, /orange and black/);
  assert.doesNotMatch(buildImagePrompt({ brief: 'x' }), /\{\{PHOTO/);
});

test('"No AI slop" adds the blacklist to the prompt and finds slop words, phrases and em dashes', async () => {
  const { findSlop, SLOP_RULES } = await import('../src/slop.js');
  const p = buildComposePrompt({ brief: 'Candles', noSlop: true });
  assert.ok(p.includes(SLOP_RULES));
  assert.doesNotMatch(p, /End with a simple question/);
  assert.doesNotMatch(buildComposePrompt({ brief: 'Candles' }), /NO AI SLOP/);
  assert.deepEqual(findSlop("Let's dive in — we leverage a seamless, game-changing tapestry. Thoughts? What are your thoughts?").sort(),
    ["em dash", "game-changing", "leverage", "let's dive in", 'seamless', 'tapestry', 'what are your thoughts'].sort());
  assert.deepEqual(findSlop('Our soy candles are $15 each. Order before Friday.'), []);
  assert.deepEqual(findSlop('This framework is robust and scalable.'), []); // honest technical words are not flagged on their own
});
