import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const key = process.env.GEMINI_API_KEY || '';
console.log('Testing newly updated API Key via REST (first 10 chars):', key.substring(0, 10) + '...');

async function run() {
  if (!key) {
    console.error('No GEMINI_API_KEY found in .env');
    return;
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Always use the x-goog-api-key header for API keys
  headers['x-goog-api-key'] = key;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: 'Hello, respond with a short message.'
          }
        ]
      }
    ]
  };

  try {
    console.log('Making POST request to:', url);
    console.log('Headers:', Object.keys(headers));
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    const data = await response.json() as any;
    if (!response.ok) {
      console.error('REST Call FAILED:', response.status, response.statusText, JSON.stringify(data, null, 2));
    } else {
      console.log('REST Call SUCCESS:', JSON.stringify(data, null, 2));
      console.log('Generated Text:', data.candidates?.[0]?.content?.parts?.[0]?.text);
    }
  } catch (e: any) {
    console.error('Error during fetch:', e.message);
  }
}

run();
