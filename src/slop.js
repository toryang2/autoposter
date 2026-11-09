// "No AI slop": words, phrases and habits that make a post read as machine-written. Claude is told to avoid them,
// and the writer checks its options afterwards: any that still use one are rewritten once.
// Words with honest technical meanings (framework, scalable, robust, ecosystem...) are only discouraged as vague
// praise in the instructions, never flagged on their own.

export const SLOP_WORDS = [
  'delve', 'delves', 'delving', 'tapestry', 'realm', 'embark', 'unleash', 'unlock', 'unlocks', 'unlocking', 'harness', 'leverage',
  'leveraging', 'elevate', 'elevates', 'empower', 'empowers', 'empowering', 'foster', 'fostering', 'cultivate', 'revolutionize',
  'revolutionizes', 'transformative', 'game-changing', 'game-changer', 'groundbreaking', 'cutting-edge', 'seamless', 'seamlessly',
  'holistic', 'multifaceted', 'nuanced', 'intricate', 'pivotal', 'paramount', 'unprecedented', 'profound', 'invaluable',
  'undeniable', 'noteworthy', 'meticulous', 'meticulously', 'synergy', 'paradigm', 'supercharge', 'turbocharge', 'reimagine',
  'redefine', 'redefines', 'reshape', 'spearhead', 'underscore', 'underscores', 'illuminate', 'unpack', 'deep-dive', 'impactful',
  'bespoke', 'vibrant', 'bustling', 'ever-evolving', 'fast-paced', 'testament', 'beacon',
];

export const SLOP_PHRASES = [
  // openings
  "in today's fast-paced world", "in today's digital age", 'in an ever-changing world', 'in an increasingly interconnected world',
  'in the ever-evolving landscape', 'in a world where', 'in the realm of', 'as we navigate', 'as technology continues to evolve',
  'since the dawn of time', 'in this day and age', 'now more than ever', 'at the heart of', 'imagine a world where', 'picture this',
  'have you ever wondered', 'what if i told you', "let's dive in", "let's explore", "let's unpack", "let's delve", "let's take a closer look",
  "let's break it down", "here's the thing", "here's the kicker", "here's where it gets interesting", "but here's the twist",
  // fake drama
  'little did they know', 'what happened next', 'then something unexpected happened', 'everything changed overnight',
  'but there was a catch', 'the real story was just beginning', "that's when things took a turn", "that's when everything changed",
  'nobody saw it coming', 'no one could have predicted', 'against all odds', 'in a surprising turn of events', 'in an unexpected twist',
  'the answer might surprise you', 'nothing short of remarkable', 'this is where the story gets interesting',
  'a story that deserves to be told', "the future isn't coming", 'from humble beginnings', 'what once seemed impossible',
  // business clichés
  "i'm thrilled to announce", "i'm excited to share", "i'm humbled and honored", "i'm beyond grateful", 'a huge shoutout to',
  'what an incredible journey', 'driving meaningful impact', 'creating lasting impact', 'moving the needle', 'breaking down silos',
  'pushing the boundaries', 'thinking outside the box', 'taking it to the next level', 'raising the bar', 'leading the charge',
  'setting a new standard', 'unlocking new opportunities', 'the full potential', 'the journey has just begun', 'the possibilities are endless',
  'the future looks bright', 'exciting times ahead', 'onward and upward', "here's to the next chapter",
  // filler
  'furthermore', 'moreover', "it's worth noting", "it's important to note", 'it should be noted', 'interestingly enough',
  'needless to say', 'at its core', 'in essence', 'to put it simply', 'simply put', 'in a nutshell', 'first and foremost',
  'that being said', 'with that said', 'having said that',
  // fake inspiration
  'let that sink in', 'read that again', 'think about that for a second', 'the harsh reality is', 'the uncomfortable truth',
  "here's the hard truth", 'this serves as a reminder', 'a powerful reminder', 'this speaks volumes', 'a shining example',
  'a symbol of resilience', 'the human spirit', 'dreams do come true', 'anything is possible', "success doesn't happen overnight",
  'every setback is a setup', 'outside your comfort zone', 'the power of perseverance', 'restores your faith in humanity',
  // marketing
  'say goodbye to', 'say hello to', 'look no further', "we've got you covered", 'discover the power of', 'experience the difference',
  'unlock your potential', 'transform the way you', 'revolutionize your', 'elevate your', 'all-in-one solution', 'one-stop shop',
  'ultimate solution', 'perfect solution', 'best-in-class', 'industry-leading', 'next-generation', 'state-of-the-art', 'world-class',
  'future-proof', 'designed with you in mind', 'tailored to your needs', 'whether you\'re a beginner or an expert',
  'no matter where you are in your journey', 'to new heights', "don't miss out", 'start your journey', 'your journey starts here',
  // tech hype
  'digital transformation', 'frictionless experience', 'paradigm shift', 'democratizing', 'ai revolution', 'exponential innovation',
  // blog
  'the ultimate guide', 'everything you need to know', 'a comprehensive guide', "in this article, we'll", "in this post, we'll",
  'without further ado', "let's jump right in", 'in conclusion', 'to sum up', 'final thoughts', 'key takeaways', 'only time will tell',
  // engagement bait
  'what are your thoughts', 'agree or disagree', 'let me know in the comments', 'drop your thoughts below', "i'd love to hear your thoughts",
  'can you relate', 'does this resonate', 'who else needs to hear this', 'tag someone who needs', 'save this for later',
  'follow for more', 'the choice is yours', 'will you be left behind', 'which side are you on',
];

export const SLOP_RULES = [
  'NO AI SLOP. Write like a real person talking to people they know, with concrete details from the brief (names, numbers, places, prices). Avoid:',
  `- These words: ${SLOP_WORDS.filter((w, i, a) => a.indexOf(w) === i).join(', ')}. Also don't use landscape, journey, ecosystem, framework, robust, scalable, powerful, incredible or exciting as vague praise or metaphor.`,
  `- These phrases (and close variants): ${SLOP_PHRASES.map((p) => `"${p}"`).join(', ')}.`,
  '- Contrast templates: "It\'s not X, it\'s Y", "This isn\'t just X", "Not only X but also Y", "More than just X", "From X to Y".',
  '- Habits: every sentence on its own line for drama; lists of three ("Faster. Smarter. Better."); fake suspense or a big "reveal" of an ordinary fact; repeating the same point; a forced moral or life lesson at the end; rhetorical questions that go nowhere; generic examples ("a busy professional"); hype adjectives; claims of changing an industry; "experts say" or "studies show" without a source; opening with praise; em dashes (use commas or periods); bold on many phrases.',
  '- Do not end with "What do you think?", "Thoughts?" or similar bait. End on a concrete next step or one specific question about the post\'s own topic.',
].join('\n');

/** The slop words and phrases a text still uses (lowercase), plus "em dash" if it has any. */
export function findSlop(text) {
  const t = String(text).toLowerCase().replace(/[’‘]/g, "'");
  const hits = new Set();
  for (const w of SLOP_WORDS) if (new RegExp(`(^|[^\\p{L}-])${w}($|[^\\p{L}-])`, 'u').test(t)) hits.add(w);
  for (const p of SLOP_PHRASES) if (t.includes(p)) hits.add(p);
  if (t.includes('—')) hits.add('em dash');
  return [...hits];
}
