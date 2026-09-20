#!/usr/bin/env node
import fs from 'fs';

const API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = 'https://api.orbio.so/api/v1';

async function testVariant(name: string, body: any) {
  console.log(`\nTesting: ${name}`);
  console.log('Body:', JSON.stringify(body, null, 2));

  const response = await fetch(`${BASE_URL}/audio/speech`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    console.log('✗ Failed:', text);
    return false;
  }

  const buffer = await response.arrayBuffer();
  const filename = `/tmp/test-${name.replace(/\s+/g, '-')}.mp3`;
  fs.writeFileSync(filename, Buffer.from(buffer));
  console.log(`✓ Generated ${buffer.byteLength} bytes → ${filename}`);
  return true;
}

async function main() {
  // Test 1: Words instead of numbers
  await testVariant('words', {
    model: 'minimax/speech-2.8-turbo',
    input: 'One',
    voice: 'presenter_male',
    speed: 0.8,
    response_format: 'mp3',
  });

  // Test 2: With language parameter
  await testVariant('language-en', {
    model: 'minimax/speech-2.8-turbo',
    input: 'One',
    voice: 'presenter_male',
    speed: 0.8,
    language: 'en',
    response_format: 'mp3',
  });

  // Test 3: With language_boost
  await testVariant('language-boost', {
    model: 'minimax/speech-2.8-turbo',
    input: 'One',
    voice: 'presenter_male',
    speed: 0.8,
    language_boost: 'en',
    response_format: 'mp3',
  });

  // Test 4: With language_code
  await testVariant('language-code', {
    model: 'minimax/speech-2.8-turbo',
    input: 'One',
    voice: 'presenter_male',
    speed: 0.8,
    language_code: 'en-US',
    response_format: 'mp3',
  });

  console.log('\n✓ All tests complete. Play with: afplay /tmp/test-*.mp3');
}

main();
