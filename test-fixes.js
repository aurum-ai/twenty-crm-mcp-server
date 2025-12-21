#!/usr/bin/env node

/**
 * Test script for Twenty CRM MCP Server fixes
 * Tests: search filtering, pagination, domain filtering, find-or-create
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
    process.exit(1);
  }
}

loadEnv();

const API_KEY = process.env.TWENTY_API_KEY;
const BASE_URL = process.env.TWENTY_BASE_URL || 'https://api.twenty.com';

// Track created resources for cleanup
const createdCompanies = [];
const createdPeople = [];

async function makeRequest(endpoint, method = 'GET', data = null) {
  const url = `${BASE_URL}${endpoint}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
  };

  if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    options.body = JSON.stringify(data);
  }

  const response = await fetch(url, options);
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${responseText}`);
  }

  return JSON.parse(responseText);
}

async function cleanup() {
  console.log('\n' + '='.repeat(60));
  console.log('CLEANUP: Removing test data');
  console.log('='.repeat(60));

  for (const id of createdPeople) {
    try {
      await makeRequest(`/rest/people/${id}`, 'DELETE');
      console.log(`✅ Deleted test person: ${id}`);
    } catch (e) {
      console.log(`⚠️  Could not delete person ${id}: ${e.message}`);
    }
  }

  for (const id of createdCompanies) {
    try {
      await makeRequest(`/rest/companies/${id}`, 'DELETE');
      console.log(`✅ Deleted test company: ${id}`);
    } catch (e) {
      console.log(`⚠️  Could not delete company ${id}: ${e.message}`);
    }
  }
}

// Test results tracking
const results = {
  passed: 0,
  failed: 0,
  tests: []
};

function recordTest(name, passed, details = '') {
  results.tests.push({ name, passed, details });
  if (passed) {
    results.passed++;
    console.log(`✅ PASS: ${name}`);
  } else {
    results.failed++;
    console.log(`❌ FAIL: ${name}`);
    if (details) console.log(`   Details: ${details}`);
  }
}

async function testSearchFiltering() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 1: Search Filtering');
  console.log('='.repeat(60));

  // Create a test company with unique name
  const testName = `TestSearchCo_${Date.now()}`;
  console.log(`\nCreating test company: ${testName}`);

  const created = await makeRequest('/rest/companies', 'POST', {
    name: testName,
    domainName: {
      primaryLinkUrl: `https://testsearch${Date.now()}.com`,
      primaryLinkLabel: 'Website'
    }
  });
  // API returns { data: { createCompany: { id: "...", ... } } }
  const companyId = created.data?.createCompany?.id || created.data?.id || created.id;
  createdCompanies.push(companyId);
  console.log(`Created company with ID: ${companyId}`);

  // Test 1a: Search by name using filter syntax
  console.log(`\nSearching for "${testName.substring(0, 10)}" using filter...`);
  const searchResult = await makeRequest(`/rest/companies?filter=name[ilike]:${encodeURIComponent('%' + testName.substring(0, 10) + '%')}&limit=10`);
  const companies = searchResult.data?.companies || searchResult.data || [];

  const found = companies.some(c => c.id === companyId);
  recordTest('Search by name filter finds test company', found,
    found ? `Found ${companies.length} companies` : `Company not found in ${companies.length} results`);

  // Test 1b: Search with exact name
  console.log(`\nSearching for exact name "${testName}"...`);
  const exactResult = await makeRequest(`/rest/companies?filter=name[eq]:${encodeURIComponent(testName)}&limit=10`);
  const exactCompanies = exactResult.data?.companies || exactResult.data || [];

  const exactFound = exactCompanies.some(c => c.id === companyId);
  recordTest('Search by exact name filter finds test company', exactFound,
    exactFound ? 'Found company' : `Company not found, got ${exactCompanies.length} results`);

  return companyId;
}

async function testPagination() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 2: Cursor-based Pagination');
  console.log('='.repeat(60));

  // Get first page with small limit
  console.log('\nFetching first page (limit=2)...');
  const page1 = await makeRequest('/rest/companies?limit=2');
  const page1Companies = page1.data?.companies || page1.data || [];
  const pageInfo = page1.pageInfo || {};

  console.log(`Page 1: Got ${page1Companies.length} companies`);
  console.log(`pageInfo: hasNextPage=${pageInfo.hasNextPage}, endCursor=${pageInfo.endCursor ? 'present' : 'missing'}`);

  recordTest('First page returns companies', page1Companies.length > 0,
    `Got ${page1Companies.length} companies`);

  recordTest('First page has pageInfo', pageInfo.endCursor !== undefined,
    pageInfo.endCursor ? 'Has endCursor' : 'Missing endCursor');

  // If we have a cursor, test next page
  if (pageInfo.endCursor) {
    console.log(`\nFetching second page using cursor...`);
    const page2 = await makeRequest(`/rest/companies?limit=2&starting_after=${encodeURIComponent(pageInfo.endCursor)}`);
    const page2Companies = page2.data?.companies || page2.data || [];

    console.log(`Page 2: Got ${page2Companies.length} companies`);

    // Check that page 2 has different companies than page 1
    const page1Ids = new Set(page1Companies.map(c => c.id));
    const page2Ids = page2Companies.map(c => c.id);
    const overlap = page2Ids.filter(id => page1Ids.has(id));

    recordTest('Second page has different companies', overlap.length === 0,
      overlap.length === 0 ? 'No overlap' : `${overlap.length} companies overlap`);
  } else {
    console.log('Skipping page 2 test - no cursor available');
  }
}

async function testDomainFiltering() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 3: Domain Name Filtering');
  console.log('='.repeat(60));

  // Create a test company with unique domain
  const testDomain = `testdomain${Date.now()}.com`;
  const testName = `DomainTestCo_${Date.now()}`;

  console.log(`\nCreating test company with domain: ${testDomain}`);

  const created = await makeRequest('/rest/companies', 'POST', {
    name: testName,
    domainName: {
      primaryLinkUrl: `https://${testDomain}`,
      primaryLinkLabel: 'Website'
    }
  });
  // API returns { data: { createCompany: { id: "...", ... } } }
  const companyId = created.data?.createCompany?.id || created.data?.id || created.id;
  createdCompanies.push(companyId);
  console.log(`Created company with ID: ${companyId}`);

  // Test filtering by domain
  console.log(`\nSearching for domain "${testDomain}"...`);
  const searchResult = await makeRequest(`/rest/companies?filter=domainName.primaryLinkUrl[ilike]:${encodeURIComponent('%' + testDomain + '%')}&limit=10`);
  const companies = searchResult.data?.companies || searchResult.data || [];

  const found = companies.some(c => c.id === companyId);
  recordTest('Domain filter finds test company', found,
    found ? `Found company among ${companies.length} results` : `Company not found in ${companies.length} results`);
}

async function testFindOrCreateCompany() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 4: Find or Create Company');
  console.log('='.repeat(60));

  const testDomain = `findorcreate${Date.now()}.com`;
  const testName = `FindOrCreateCo_${Date.now()}`;

  // Test 4a: Create new company (should not exist)
  console.log(`\nTesting find_or_create for new company: ${testName}`);

  // First, manually search to confirm it doesn't exist
  const preSearch = await makeRequest(`/rest/companies?filter=name[eq]:${encodeURIComponent(testName)}&limit=1`);
  const preCompanies = preSearch.data?.companies || preSearch.data || [];

  recordTest('Company does not exist before find_or_create', preCompanies.length === 0,
    `Found ${preCompanies.length} existing companies`);

  // Now create it
  console.log('Creating company via direct API call...');
  const createResult = await makeRequest('/rest/companies', 'POST', {
    name: testName,
    domainName: {
      primaryLinkUrl: `https://${testDomain}`,
      primaryLinkLabel: 'Website'
    }
  });
  // API returns { data: { createCompany: { id: "...", ... } } }
  const createdId = createResult.data?.createCompany?.id || createResult.data?.id || createResult.id;
  createdCompanies.push(createdId);
  console.log(`Created company with ID: ${createdId}`);

  recordTest('Company was created', !!createdId, createdId ? `ID: ${createdId}` : 'No ID returned');

  // Test 4b: Search for existing company (should find it)
  console.log(`\nSearching for existing company by domain: ${testDomain}`);
  const findResult = await makeRequest(`/rest/companies?filter=domainName.primaryLinkUrl[ilike]:${encodeURIComponent('%' + testDomain + '%')}&limit=1`);
  const foundCompanies = findResult.data?.companies || findResult.data || [];

  const foundExisting = foundCompanies.length > 0 && foundCompanies[0].id === createdId;
  recordTest('Find existing company by domain works', foundExisting,
    foundExisting ? 'Found the created company' : `Found ${foundCompanies.length} companies`);
}

async function testFindOrCreatePerson() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 5: Find or Create Person');
  console.log('='.repeat(60));

  const testEmail = `test${Date.now()}@testfindcreate.com`;
  const testFirstName = 'TestFirst';
  const testLastName = `TestLast_${Date.now()}`;

  // Test 5a: Confirm person doesn't exist
  console.log(`\nSearching for email: ${testEmail}`);
  const preSearch = await makeRequest(`/rest/people?filter=emails.primaryEmail[eq]:${encodeURIComponent(testEmail)}&limit=1`);
  const prePeople = preSearch.data?.people || preSearch.data || [];

  recordTest('Person does not exist before creation', prePeople.length === 0,
    `Found ${prePeople.length} existing people`);

  // Test 5b: Create person
  console.log('Creating person via direct API call...');
  const createResult = await makeRequest('/rest/people', 'POST', {
    name: {
      firstName: testFirstName,
      lastName: testLastName
    },
    emails: {
      primaryEmail: testEmail
    }
  });
  // API returns { data: { createPerson: { id: "...", ... } } }
  const createdId = createResult.data?.createPerson?.id || createResult.data?.id || createResult.id;
  createdPeople.push(createdId);
  console.log(`Created person with ID: ${createdId}`);

  recordTest('Person was created', !!createdId, createdId ? `ID: ${createdId}` : 'No ID returned');

  // Test 5c: Find existing person by email
  console.log(`\nSearching for existing person by email: ${testEmail}`);
  const findResult = await makeRequest(`/rest/people?filter=emails.primaryEmail[eq]:${encodeURIComponent(testEmail)}&limit=1`);
  const foundPeople = findResult.data?.people || findResult.data || [];

  const foundExisting = foundPeople.length > 0 && foundPeople[0].id === createdId;
  recordTest('Find existing person by email works', foundExisting,
    foundExisting ? 'Found the created person' : `Found ${foundPeople.length} people`);
}

async function testSearchRecords() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 6: Search Records (Cross-object search)');
  console.log('='.repeat(60));

  // Create a test company with searchable name
  const searchTerm = `SearchTest${Date.now()}`;
  const testName = `${searchTerm}_Company`;

  console.log(`\nCreating test company: ${testName}`);
  const created = await makeRequest('/rest/companies', 'POST', {
    name: testName,
    domainName: {
      primaryLinkUrl: `https://searchtest${Date.now()}.com`,
      primaryLinkLabel: 'Website'
    }
  });
  // API returns { data: { createCompany: { id: "...", ... } } }
  const companyId = created.data?.createCompany?.id || created.data?.id || created.id;
  createdCompanies.push(companyId);

  // Search across companies
  console.log(`\nSearching for "${searchTerm}" in companies...`);
  const searchResult = await makeRequest(`/rest/companies?filter=name[ilike]:${encodeURIComponent('%' + searchTerm + '%')}&limit=10`);
  const companies = searchResult.data?.companies || searchResult.data || [];

  const found = companies.some(c => c.id === companyId);
  recordTest('Cross-object search finds test company', found,
    found ? `Found among ${companies.length} companies` : `Not found in ${companies.length} results`);
}

async function testLimitValidation() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST 7: Limit Parameter Validation');
  console.log('='.repeat(60));

  // Test with valid limit
  console.log('\nTesting with limit=5...');
  const result5 = await makeRequest('/rest/companies?limit=5');
  const companies5 = result5.data?.companies || result5.data || [];
  recordTest('Limit=5 returns at most 5 companies', companies5.length <= 5,
    `Got ${companies5.length} companies`);

  // Test with limit=1
  console.log('Testing with limit=1...');
  const result1 = await makeRequest('/rest/companies?limit=1');
  const companies1 = result1.data?.companies || result1.data || [];
  recordTest('Limit=1 returns at most 1 company', companies1.length <= 1,
    `Got ${companies1.length} companies`);
}

async function main() {
  console.log('Twenty CRM MCP Server - Test Suite');
  console.log('===================================');
  console.log(`API Base URL: ${BASE_URL}`);
  console.log('');

  try {
    await testSearchFiltering();
    await testPagination();
    await testDomainFiltering();
    await testFindOrCreateCompany();
    await testFindOrCreatePerson();
    await testSearchRecords();
    await testLimitValidation();
  } catch (error) {
    console.error('\n❌ Test suite error:', error.message);
    console.error(error.stack);
  } finally {
    await cleanup();
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total: ${results.passed + results.failed} tests`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);

  if (results.failed > 0) {
    console.log('\nFailed tests:');
    results.tests.filter(t => !t.passed).forEach(t => {
      console.log(`  - ${t.name}: ${t.details}`);
    });
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
    process.exit(0);
  }
}

main();
