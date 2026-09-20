#!/usr/bin/env node
/**
 * Generuje plik TTS dla nokautu przez Orbio.
 *
 * Odliczanie nie jest już TTS — to syntezowany w Web Audio API gwar
 * trybun, patrz `src/lib/sfx.ts` (`startCrowdSwell`).
 *
 * Model: minimax/speech-2.8-turbo
 * Głos: presenter_male (angielski, głęboki męski głos prezentera)
 *
 * Użycie: npm run generate:sfx
 * Wymaga OPENAI_API_KEY i OPENAI_BASE_URL w .env.local
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'sfx');
const API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.orbio.so/api/v1';

if (!API_KEY) {
  console.error('Error: OPENAI_API_KEY not found in environment');
  console.error('Add it to .env.local');
  process.exit(1);
}

interface OpenAITTSRequest {
  model: string;
  input: string;
  voice: string;
  speed?: number; // 0.25-4.0
  language?: string; // 'en', 'zh', etc.
  response_format?: 'mp3' | 'opus' | 'aac' | 'flac';
}

/**
 * Generuje TTS przez Orbio (minimax/speech-2.8-turbo).
 * Używa formatu OpenAI TTS API.
 * Zwraca binary audio data (MP3).
 */
async function generateTTS(text: string, speed: number): Promise<Buffer> {
  const url = `${BASE_URL}/audio/speech`;

  const body: OpenAITTSRequest = {
    model: 'minimax/speech-2.8-turbo',
    input: text,
    voice: 'presenter_male',
    speed,
    language: 'en',
    response_format: 'mp3',
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_URL ?? 'https://orbio.so/build',
      'X-Title': process.env.APP_NAME ?? 'Orbio Build Week',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`TTS API failed (${response.status}): ${text}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function main() {
  console.log('Generating TTS file through Orbio...');
  console.log('Model: minimax/speech-2.8-turbo');
  console.log('Voice: presenter_male (English)\n');

  // Nokaut ze standardową prędkością
  console.log('=== Knockout (speed 1.0) ===');
  const knockoutText = 'knockout';
  const knockoutFile = 'knockout.mp3';
  const knockoutPath = path.join(OUTPUT_DIR, knockoutFile);

  try {
    console.log(`Generating ${knockoutFile}...`);
    const audioBuffer = await generateTTS(knockoutText, 1.0);
    fs.writeFileSync(knockoutPath, audioBuffer);
    console.log(`✓ Saved ${knockoutFile} (${audioBuffer.length} bytes)`);
  } catch (err) {
    console.error(`✗ Failed to generate ${knockoutFile}:`, err);
    process.exit(1);
  }

  console.log('\n✓ TTS file generated successfully.');
}

main();
