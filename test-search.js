#!/usr/bin/env node

/**
 * Test script for search_records functionality
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadEnv() {
  try {
    const envPath = join(__dirname, '.env');
    const envContent = readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        const value = valueParts.join('=').replace(/^["']|["']$/g, '');
        process.env[key] = value;
      }
    }
  } catch (e) {
    console.error('Could not load .env file:', e.message);
  }
}

loadEnv();

const API_KEY = process.env.TWENTY_API_KEY;
const BASE_URL = process.env.TWENTY_BASE_URL || 'https://api.twenty.com';

async function makeRequest(endpoint) {
  const url = `${BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  return response.json();
}

async function searchPeople(query) {
  const searchFields = ['name.firstName', 'name.lastName'];
  const allResults = [];
  const seenIds = new Set();
  const queryWords = query.trim().split(/\s+/).filter(w => w.length > 0);
  const limit = 10;

  console.log(`\nSearching for: "${query}"`);
  console.log(`Query words: ${JSON.stringify(queryWords)}`);
  console.log('---');

  for (const field of searchFields) {
    for (const word of queryWords) {
      const filter = `filter=${field}[ilike]:${encodeURIComponent('%' + word + '%')}`;
      const endpoint = `/rest/people?${filter}&limit=${limit}`;
      console.log(`Fetching: ${endpoint}`);

      const result = await makeRequest(endpoint);
      const items = result.data?.people || result.data || [];
      console.log(`  Found ${items.length} results`);

      for (const item of items) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          allResults.push(item);
          console.log(`  + Added: ${item.name?.firstName} ${item.name?.lastName}`);
        }
      }
    }
  }

  return allResults;
}

async function main() {
  if (!API_KEY) {
    console.error('TWENTY_API_KEY not set');
    process.exit(1);
  }

  console.log('=== Search Test ===');
  console.log(`Base URL: ${BASE_URL}`);

  // Test searches
  const testQueries = ['Daniel Shires', 'Daniel', 'Shires'];

  for (const query of testQueries) {
    const results = await searchPeople(query);
    console.log(`\nTotal unique results for "${query}": ${results.length}`);
    for (const person of results) {
      console.log(`  - ${person.name?.firstName} ${person.name?.lastName} (${person.id})`);
    }
    console.log('');
  }
}

main().catch(console.error);
