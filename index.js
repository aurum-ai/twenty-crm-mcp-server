#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// =============================================================================
// COMPOSITE FIELD TYPE TRANSFORMERS
// Twenty CRM uses composite objects for certain field types (LINKS, ADDRESS, EMAILS)
// These functions transform simple string inputs into the required structure
// while also accepting pre-structured objects for flexibility
// =============================================================================

/**
 * Check if a value is already a properly structured composite object
 */
function isCompositeObject(value, fieldType) {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  switch (fieldType) {
    case 'LINKS':
      return 'primaryLinkUrl' in value;
    case 'ADDRESS':
      return 'addressStreet1' in value || 'addressCity' in value;
    case 'EMAILS':
      return 'primaryEmail' in value;
    case 'PHONES':
      return 'primaryPhoneNumber' in value;
    case 'CURRENCY':
      return 'amountMicros' in value;
    case 'FULL_NAME':
      return 'firstName' in value || 'lastName' in value;
    default:
      return false;
  }
}

/**
 * Transform a simple string into a LINKS composite object
 * @param {string} url - The URL string
 * @returns {object|null} LINKS composite object or null if invalid
 */
function transformToLinks(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }

  // Generate a label from the URL (domain name)
  let label = url;
  try {
    const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
    label = urlObj.hostname.replace('www.', '');
  } catch {
    label = url;
  }

  return {
    primaryLinkUrl: url.startsWith('http') ? url : `https://${url}`,
    primaryLinkLabel: label
  };
}

/**
 * Transform a simple string or partial object into an ADDRESS composite object
 * @param {string|object} address - The address string or partial object
 * @returns {object|null} ADDRESS composite object or null if invalid
 */
function transformToAddress(address) {
  if (address === null || address === undefined) {
    return null;
  }

  // If already an object, merge with defaults (use ?? to allow empty strings)
  if (typeof address === 'object') {
    return {
      addressStreet1: address.addressStreet1 ?? address.street1 ?? '',
      addressStreet2: address.addressStreet2 ?? address.street2 ?? '',
      addressCity: address.addressCity ?? address.city ?? '',
      addressPostcode: address.addressPostcode ?? address.postcode ?? address.zip ?? '',
      addressState: address.addressState ?? address.state ?? '',
      addressCountry: address.addressCountry ?? address.country ?? '',
      addressLat: address.addressLat ?? address.lat ?? null,
      addressLng: address.addressLng ?? address.lng ?? null
    };
  }

  // Simple string - put in street1
  if (typeof address === 'string') {
    return {
      addressStreet1: address,
      addressStreet2: '',
      addressCity: '',
      addressPostcode: '',
      addressState: '',
      addressCountry: '',
      addressLat: null,
      addressLng: null
    };
  }

  // Unexpected type
  return null;
}

/**
 * Transform a simple string into an EMAILS composite object
 * @param {string} email - The email string
 * @returns {object|null} EMAILS composite object or null if invalid
 */
function transformToEmails(email) {
  if (!email || typeof email !== 'string') {
    return null;
  }

  return {
    primaryEmail: email
  };
}

/**
 * Transform a simple string into a PHONES composite object
 * @param {string} phone - The phone number string
 * @returns {object|null} PHONES composite object or null if invalid
 */
function transformToPhones(phone) {
  if (!phone || typeof phone !== 'string') {
    return null;
  }

  return {
    primaryPhoneNumber: phone,
    additionalPhones: null
  };
}

/**
 * Transform a value into a CURRENCY composite object
 * Accepts: number, string like "$100" or "100 USD", or object
 * @param {number|string|object} value - The currency value
 * @param {string} defaultCurrency - Default currency code (default: 'USD')
 * @returns {object|null} CURRENCY composite object or null if invalid
 */
function transformToCurrency(value, defaultCurrency = 'USD') {
  if (value === null || value === undefined) {
    return null;
  }

  // Already structured
  if (typeof value === 'object' && 'amountMicros' in value) {
    return value;
  }

  let amount = value;
  let currency = defaultCurrency;

  if (typeof value === 'string') {
    // Parse strings like "$100", "100 USD", "€50", "100"
    const match = value.match(/^[$€£]?\s*([\d,.]+)\s*([A-Z]{3})?$/i);
    if (match) {
      amount = parseFloat(match[1].replace(/,/g, ''));
      currency = match[2]?.toUpperCase() || defaultCurrency;
    } else {
      return null;
    }
  }

  if (typeof amount === 'number' || !isNaN(parseFloat(amount))) {
    return {
      amountMicros: Math.round(parseFloat(amount) * 1000000),
      currencyCode: currency
    };
  }

  return null;
}

/**
 * Transform a value into a FULL_NAME composite object
 * @param {string|object} value - Name string or object with firstName/lastName
 * @returns {object|null} FULL_NAME composite object or null if invalid
 */
function transformToFullName(value) {
  if (!value) {
    return null;
  }

  // Already structured
  if (typeof value === 'object' && ('firstName' in value || 'lastName' in value)) {
    return {
      firstName: value.firstName ?? '',
      lastName: value.lastName ?? ''
    };
  }

  // Parse string - split on first space
  if (typeof value === 'string') {
    const parts = value.trim().split(/\s+/);
    return {
      firstName: parts[0] || '',
      lastName: parts.slice(1).join(' ') || ''
    };
  }

  return null;
}

/**
 * Main transformation function for all composite fields
 * @param {object} data - The input data object
 * @param {string} entityType - The entity type ('company' or 'person')
 * @returns {object} Transformed data with composite fields
 */
function transformCompositeFields(data, entityType) {
  const transformed = { ...data };

  // LINKS fields (company: domainName, linkedinUrl, xUrl; person: linkedinUrl)
  const linksFields = entityType === 'company'
    ? ['domainName', 'linkedinUrl', 'xUrl']
    : ['linkedinUrl'];

  for (const field of linksFields) {
    if (field in transformed && transformed[field] !== undefined) {
      if (!isCompositeObject(transformed[field], 'LINKS')) {
        const transformedValue = transformToLinks(transformed[field]);
        if (transformedValue !== null) {
          transformed[field] = transformedValue;
        } else {
          // Remove invalid field to avoid API errors
          delete transformed[field];
        }
      }
    }
  }

  // ADDRESS field (company only)
  if (entityType === 'company' && 'address' in transformed && transformed.address !== undefined) {
    if (!isCompositeObject(transformed.address, 'ADDRESS')) {
      const transformedValue = transformToAddress(transformed.address);
      if (transformedValue !== null) {
        transformed.address = transformedValue;
      } else {
        delete transformed.address;
      }
    }
  }

  // Person-specific composite fields
  if (entityType === 'person') {
    // FULL_NAME field - combine firstName + lastName into name
    if (('firstName' in transformed || 'lastName' in transformed) && !('name' in transformed)) {
      transformed.name = transformToFullName({
        firstName: transformed.firstName,
        lastName: transformed.lastName
      });
      delete transformed.firstName;
      delete transformed.lastName;
    }

    // EMAILS field - API uses 'emails' (plural)
    if ('email' in transformed && transformed.email !== undefined) {
      if (!isCompositeObject(transformed.email, 'EMAILS')) {
        const transformedValue = transformToEmails(transformed.email);
        if (transformedValue !== null) {
          transformed.emails = transformedValue;
        }
      }
      delete transformed.email;
    }

    // PHONES field - API uses 'phones' (plural)
    if ('phone' in transformed && transformed.phone !== undefined) {
      if (!isCompositeObject(transformed.phone, 'PHONES')) {
        const transformedValue = transformToPhones(transformed.phone);
        if (transformedValue !== null) {
          transformed.phones = transformedValue;
        }
      }
      delete transformed.phone;
    }
  }

  return transformed;
}

// =============================================================================
// OBJECT NAME NORMALIZATION
// Twenty's metadata API requires plural object names (namePlural format)
// =============================================================================

/**
 * Normalize object name to plural form for metadata API
 * Twenty CRM expects plural names: 'people' not 'person', 'companies' not 'company'
 * @param {string} name - Object name (singular or plural)
 * @returns {string} Plural form of the object name
 */
function normalizeObjectName(name) {
  const singularToPlural = {
    'person': 'people',
    'company': 'companies',
    'note': 'notes',
    'task': 'tasks',
    'opportunity': 'opportunities',
    'activity': 'activities'
  };
  return singularToPlural[name] || name;
}

// =============================================================================
// METADATA CACHE
// Caches object field metadata to enable dynamic field type transformation
// =============================================================================

class MetadataCache {
  constructor(ttlMs = 5 * 60 * 1000) { // 5 minute default TTL
    this.cache = new Map();
    this.ttlMs = ttlMs;
  }

  get(objectName) {
    const entry = this.cache.get(objectName);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(objectName);
      return null;
    }
    return entry.data;
  }

  set(objectName, data) {
    this.cache.set(objectName, {
      data,
      expiresAt: Date.now() + this.ttlMs
    });
  }

  clear() {
    this.cache.clear();
  }
}

// =============================================================================
// DYNAMIC FIELD TRANSFORMATION
// Transform fields based on their metadata type
// =============================================================================

/**
 * Transform a field value based on its metadata type
 * @param {string} fieldName - Name of the field
 * @param {*} value - The value to transform
 * @param {string} fieldType - The field type from metadata
 * @returns {*} Transformed value
 */
function transformFieldByType(fieldName, value, fieldType) {
  if (value === null || value === undefined) return value;

  // Check if already a composite object
  if (isCompositeObject(value, fieldType)) {
    return value;
  }

  switch (fieldType) {
    case 'LINKS':
      return transformToLinks(value);
    case 'ADDRESS':
      return transformToAddress(value);
    case 'EMAILS':
      return transformToEmails(value);
    case 'PHONES':
      return transformToPhones(value);
    case 'CURRENCY':
      return transformToCurrency(value);
    case 'FULL_NAME':
      return transformToFullName(value);
    // Pass through without transformation
    case 'TEXT':
    case 'NUMBER':
    case 'BOOLEAN':
    case 'DATE':
    case 'DATE_TIME':
    case 'UUID':
    case 'RATING':
    case 'SELECT':
    case 'MULTI_SELECT':
    case 'RELATION':
    case 'RAW_JSON':
    case 'RICH_TEXT':
    case 'ARRAY':
    case 'POSITION':
    default:
      return value;
  }
}

/**
 * Transform all fields in data object based on metadata
 * @param {object} data - The input data object
 * @param {Array} fieldMetadata - Array of field metadata from API
 * @returns {object} Transformed data
 */
function transformFieldsWithMetadata(data, fieldMetadata) {
  if (!data || !fieldMetadata || !Array.isArray(fieldMetadata)) {
    return data;
  }

  const transformed = {};

  // Build field type lookup from metadata
  const fieldTypeMap = new Map();
  for (const field of fieldMetadata) {
    if (field.name && field.type) {
      fieldTypeMap.set(field.name, field.type);
    }
  }

  // Handle special field aliases BEFORE processing regular fields
  // These handle common user-friendly input names that map to API field names

  // firstName + lastName → name (FULL_NAME)
  if (('firstName' in data || 'lastName' in data) && fieldTypeMap.has('name')) {
    transformed.name = transformToFullName({
      firstName: data.firstName,
      lastName: data.lastName
    });
  }

  // email → emails (EMAILS) - singular to plural
  if ('email' in data && fieldTypeMap.has('emails')) {
    const transformedValue = transformFieldByType('emails', data.email, 'EMAILS');
    if (transformedValue !== null) {
      transformed.emails = transformedValue;
    }
  }

  // phone → phones (PHONES) - singular to plural
  if ('phone' in data && fieldTypeMap.has('phones')) {
    const transformedValue = transformFieldByType('phones', data.phone, 'PHONES');
    if (transformedValue !== null) {
      transformed.phones = transformedValue;
    }
  }

  // Fields to skip because they were handled as aliases above
  const aliasedFields = ['firstName', 'lastName', 'email', 'phone'];

  // Transform remaining fields
  for (const [key, value] of Object.entries(data)) {
    // Skip aliased fields - already handled above
    if (aliasedFields.includes(key)) {
      continue;
    }

    const fieldType = fieldTypeMap.get(key);
    if (fieldType) {
      const transformedValue = transformFieldByType(key, value, fieldType);
      if (transformedValue !== null) {
        transformed[key] = transformedValue;
      }
      // Skip null results (invalid transformations)
    } else {
      // Unknown field - pass through (might be valid custom field)
      transformed[key] = value;
    }
  }

  return transformed;
}

/**
 * Get structure hint for composite field types (for documentation)
 */
function getCompositeStructureHint(fieldType) {
  const hints = {
    LINKS: { primaryLinkUrl: "https://...", primaryLinkLabel: "Label" },
    ADDRESS: { addressStreet1: "123 Main St", addressCity: "City", addressState: "State", addressPostcode: "12345", addressCountry: "Country" },
    EMAILS: { primaryEmail: "email@example.com" },
    PHONES: { primaryPhoneNumber: "+1234567890" },
    CURRENCY: { amountMicros: 1000000, currencyCode: "USD" },
    FULL_NAME: { firstName: "John", lastName: "Doe" }
  };
  return hints[fieldType] || null;
}

class TwentyCRMServer {
  constructor() {
    this.server = new Server(
      {
        name: "twenty-crm",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.apiKey = process.env.TWENTY_API_KEY;
    this.baseUrl = process.env.TWENTY_BASE_URL || "https://api.twenty.com";

    if (!this.apiKey) {
      throw new Error("TWENTY_API_KEY environment variable is required");
    }

    // Initialize metadata cache for dynamic field type transformation
    this.metadataCache = new MetadataCache();

    this.setupToolHandlers();
  }

  /**
   * Fetch enum values from GraphQL schema introspection
   * @param {string} enumTypeName - The GraphQL enum type name (e.g., 'OpportunityStageEnum')
   * @returns {Promise<Array>} Array of enum values with name and description
   */
  async getEnumValues(enumTypeName) {
    const query = `
      query GetEnumValues($typeName: String!) {
        __type(name: $typeName) {
          enumValues {
            name
            description
          }
        }
      }
    `;

    try {
      const response = await fetch(`${this.baseUrl}/graphql`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables: { typeName: enumTypeName } })
      });

      if (!response.ok) return [];

      const result = await response.json();
      return result.data?.__type?.enumValues || [];
    } catch (error) {
      console.error(`Failed to fetch enum values for ${enumTypeName}: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch field metadata via GraphQL introspection (fallback when REST metadata API fails)
   * @param {string} typeName - GraphQL type name (e.g., 'Company', 'Person')
   * @returns {Promise<Array|null>} Array of field metadata or null if unavailable
   */
  async getFieldMetadataViaGraphQL(typeName) {
    const query = `
      query IntrospectType($typeName: String!) {
        __type(name: $typeName) {
          name
          fields {
            name
            type {
              name
              kind
              ofType { name kind }
            }
          }
        }
      }
    `;

    try {
      const response = await fetch(`${this.baseUrl}/graphql`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables: { typeName } })
      });

      if (!response.ok) {
        return null;
      }

      const result = await response.json();
      const rawFields = result.data?.__type?.fields || [];

      // Convert GraphQL introspection format to metadata format
      const fields = rawFields.map(field => {
        const fieldTypeName = field.type.name || field.type.ofType?.name || field.type.kind;
        // Map GraphQL types to Twenty field types
        let fieldType = 'TEXT';
        if (fieldTypeName === 'Links') fieldType = 'LINKS';
        else if (fieldTypeName === 'Address') fieldType = 'ADDRESS';
        else if (fieldTypeName === 'Emails') fieldType = 'EMAILS';
        else if (fieldTypeName === 'Phones') fieldType = 'PHONES';
        else if (fieldTypeName === 'Currency') fieldType = 'CURRENCY';
        else if (fieldTypeName === 'FullName') fieldType = 'FULL_NAME';
        else if (fieldTypeName?.endsWith('Enum')) fieldType = 'SELECT';
        else if (fieldTypeName === 'Float' || fieldTypeName === 'Int') fieldType = 'NUMBER';
        else if (fieldTypeName === 'Boolean') fieldType = 'BOOLEAN';
        else if (fieldTypeName === 'DateTime') fieldType = 'DATE_TIME';
        else if (fieldTypeName === 'UUID' || fieldTypeName === 'ID') fieldType = 'UUID';

        return {
          name: field.name,
          type: fieldType,
          graphqlType: fieldTypeName,
          isNullable: field.type.kind !== 'NON_NULL'
        };
      });

      // Fetch enum values for SELECT fields
      const selectFields = fields.filter(f => f.type === 'SELECT' && f.graphqlType);
      const enumTypeNames = [...new Set(selectFields.map(f => f.graphqlType))];

      if (enumTypeNames.length > 0) {
        // Fetch all enum values in parallel
        const enumResults = await Promise.all(
          enumTypeNames.map(async (enumTypeName) => ({
            typeName: enumTypeName,
            values: await this.getEnumValues(enumTypeName)
          }))
        );

        // Build lookup map
        const enumValuesMap = {};
        enumResults.forEach(r => { enumValuesMap[r.typeName] = r.values; });

        // Add options to SELECT fields
        fields.forEach(field => {
          if (field.type === 'SELECT' && field.graphqlType && enumValuesMap[field.graphqlType]) {
            field.options = enumValuesMap[field.graphqlType].map(v => ({
              value: v.name,
              label: v.name
            }));
          }
        });
      }

      return fields;
    } catch (error) {
      console.error(`Failed to fetch metadata via GraphQL for ${typeName}: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch and cache field metadata for an object type
   * @param {string} objectName - The object type (e.g., 'companies', 'people')
   * @returns {Promise<Array|null>} Array of field metadata or null if unavailable
   */
  async getFieldMetadata(objectName) {
    // Normalize to plural form (Twenty API expects 'people', 'companies', etc.)
    const normalizedName = normalizeObjectName(objectName);

    // Check cache first
    let metadata = this.metadataCache.get(normalizedName);
    if (metadata) {
      return metadata;
    }

    // Try REST metadata endpoint first
    try {
      const result = await this.makeRequest(`/rest/metadata/objects/${normalizedName}`);
      const fields = result.data?.object?.fields || result.fields || [];
      if (fields.length > 0) {
        this.metadataCache.set(normalizedName, fields);
        return fields;
      }
    } catch (error) {
      // REST metadata endpoint failed, will try GraphQL fallback
      console.error(`REST metadata failed for ${normalizedName}, trying GraphQL: ${error.message}`);
    }

    // Fallback to GraphQL introspection
    // Map plural names to GraphQL type names
    const graphqlTypeMap = {
      'people': 'Person',
      'companies': 'Company',
      'notes': 'Note',
      'tasks': 'Task',
      'opportunities': 'Opportunity'
    };
    const graphqlTypeName = graphqlTypeMap[normalizedName] || normalizedName.charAt(0).toUpperCase() + normalizedName.slice(1, -1);

    const graphqlMetadata = await this.getFieldMetadataViaGraphQL(graphqlTypeName);
    if (graphqlMetadata && graphqlMetadata.length > 0) {
      this.metadataCache.set(normalizedName, graphqlMetadata);
      return graphqlMetadata;
    }

    return null;
  }

  async makeRequest(endpoint, method = "GET", data = null) {
    const url = `${this.baseUrl}${endpoint}`;
    const options = {
      method,
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    };

    if (data && (method === "POST" || method === "PUT" || method === "PATCH")) {
      options.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(url, options);
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      return result;
    } catch (error) {
      throw new Error(`API request failed: ${error.message}`);
    }
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          // People Management
          {
            name: "create_person",
            description: "Create a new person in Twenty CRM. Supports standard fields and any custom fields. Use get_object_metadata('people') to discover all available fields.",
            inputSchema: {
              type: "object",
              properties: {
                firstName: { type: "string", description: "First name" },
                lastName: { type: "string", description: "Last name" },
                email: { type: "string", description: "Email address - accepts string or EMAILS object {primaryEmail}" },
                phone: { type: "string", description: "Phone number" },
                jobTitle: { type: "string", description: "Job title" },
                companyId: { type: "string", description: "Company ID to associate with" },
                linkedinUrl: { type: "string", description: "LinkedIn profile URL - accepts string or LINKS object {primaryLinkUrl, primaryLinkLabel}" },
                city: { type: "string", description: "City" },
                avatarUrl: { type: "string", description: "Avatar image URL" }
              },
              additionalProperties: true,
              required: ["firstName", "lastName"]
            }
          },
          {
            name: "get_person",
            description: "Get details of a specific person by ID",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Person ID" }
              },
              required: ["id"]
            }
          },
          {
            name: "update_person",
            description: "Update an existing person's information. Supports standard fields and any custom fields. Use get_object_metadata('people') to discover all available fields.",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Person ID" },
                firstName: { type: "string", description: "First name" },
                lastName: { type: "string", description: "Last name" },
                email: { type: "string", description: "Email address - accepts string or EMAILS object {primaryEmail}" },
                phone: { type: "string", description: "Phone number" },
                jobTitle: { type: "string", description: "Job title" },
                companyId: { type: "string", description: "Company ID" },
                linkedinUrl: { type: "string", description: "LinkedIn profile URL - accepts string or LINKS object {primaryLinkUrl, primaryLinkLabel}" },
                city: { type: "string", description: "City" }
              },
              additionalProperties: true,
              required: ["id"]
            }
          },
          {
            name: "list_people",
            description: "List people with optional filtering and pagination",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Number of results to return (default: 20)" },
                offset: { type: "number", description: "Number of results to skip (default: 0)" },
                search: { type: "string", description: "Search term for name or email" },
                companyId: { type: "string", description: "Filter by company ID" }
              }
            }
          },
          {
            name: "delete_person",
            description: "Delete a person from Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Person ID to delete" }
              },
              required: ["id"]
            }
          },

          // Company Management
          {
            name: "create_company",
            description: "Create a new company in Twenty CRM. Supports standard fields and any custom fields. Use get_object_metadata('companies') to discover all available fields.",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Company name" },
                domainName: { type: "string", description: "Company domain - accepts 'example.com' or LINKS object {primaryLinkUrl, primaryLinkLabel}" },
                address: { type: "string", description: "Company address - accepts string or ADDRESS object {addressStreet1, addressCity, addressPostcode, addressState, addressCountry}" },
                employees: { type: "number", description: "Number of employees" },
                linkedinUrl: { type: "string", description: "LinkedIn company URL - accepts string or LINKS object {primaryLinkUrl, primaryLinkLabel}" },
                xUrl: { type: "string", description: "X (Twitter) URL - accepts string or LINKS object {primaryLinkUrl, primaryLinkLabel}" },
                annualRecurringRevenue: { type: "number", description: "Annual recurring revenue" },
                idealCustomerProfile: { type: "boolean", description: "Is this an ideal customer profile" }
              },
              additionalProperties: true,
              required: ["name"]
            }
          },
          {
            name: "get_company",
            description: "Get details of a specific company by ID",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Company ID" }
              },
              required: ["id"]
            }
          },
          {
            name: "update_company",
            description: "Update an existing company's information. Supports standard fields and any custom fields. Use get_object_metadata('companies') to discover all available fields.",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Company ID" },
                name: { type: "string", description: "Company name" },
                domainName: { type: "string", description: "Company domain - accepts 'example.com' or LINKS object {primaryLinkUrl, primaryLinkLabel}" },
                address: { type: "string", description: "Company address - accepts string or ADDRESS object {addressStreet1, addressCity, addressPostcode, addressState, addressCountry}" },
                employees: { type: "number", description: "Number of employees" },
                linkedinUrl: { type: "string", description: "LinkedIn company URL - accepts string or LINKS object {primaryLinkUrl, primaryLinkLabel}" },
                annualRecurringRevenue: { type: "number", description: "Annual recurring revenue" }
              },
              additionalProperties: true,
              required: ["id"]
            }
          },
          {
            name: "list_companies",
            description: "List companies with optional filtering and pagination",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Number of results to return (default: 20)" },
                offset: { type: "number", description: "Number of results to skip (default: 0)" },
                search: { type: "string", description: "Search term for company name" }
              }
            }
          },
          {
            name: "delete_company",
            description: "Delete a company from Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Company ID to delete" }
              },
              required: ["id"]
            }
          },

          // Notes Management
          {
            name: "create_note",
            description: "Create a new note in Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                title: { type: "string", description: "Note title" },
                body: { type: "string", description: "Note content" },
                position: { type: "number", description: "Position for ordering" }
              },
              required: ["title", "body"]
            }
          },
          {
            name: "get_note",
            description: "Get details of a specific note by ID",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Note ID" }
              },
              required: ["id"]
            }
          },
          {
            name: "list_notes",
            description: "List notes with optional filtering and pagination",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Number of results to return (default: 20)" },
                offset: { type: "number", description: "Number of results to skip (default: 0)" },
                search: { type: "string", description: "Search term for note title or content" }
              }
            }
          },
          {
            name: "update_note",
            description: "Update an existing note",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Note ID" },
                title: { type: "string", description: "Note title" },
                body: { type: "string", description: "Note content" },
                position: { type: "number", description: "Position for ordering" }
              },
              required: ["id"]
            }
          },
          {
            name: "delete_note",
            description: "Delete a note from Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Note ID to delete" }
              },
              required: ["id"]
            }
          },

          // Tasks Management
          {
            name: "create_task",
            description: "Create a new task in Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                title: { type: "string", description: "Task title" },
                body: { type: "string", description: "Task description" },
                dueAt: { type: "string", description: "Due date (ISO 8601 format)" },
                status: { type: "string", description: "Task status", enum: ["TODO", "IN_PROGRESS", "DONE"] },
                assigneeId: { type: "string", description: "ID of person assigned to task" },
                position: { type: "number", description: "Position for ordering" }
              },
              required: ["title"]
            }
          },
          {
            name: "get_task",
            description: "Get details of a specific task by ID",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Task ID" }
              },
              required: ["id"]
            }
          },
          {
            name: "list_tasks",
            description: "List tasks with optional filtering and pagination",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Number of results to return (default: 20)" },
                offset: { type: "number", description: "Number of results to skip (default: 0)" },
                status: { type: "string", description: "Filter by status", enum: ["TODO", "IN_PROGRESS", "DONE"] },
                assigneeId: { type: "string", description: "Filter by assignee ID" }
              }
            }
          },
          {
            name: "update_task",
            description: "Update an existing task",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Task ID" },
                title: { type: "string", description: "Task title" },
                body: { type: "string", description: "Task description" },
                dueAt: { type: "string", description: "Due date (ISO 8601 format)" },
                status: { type: "string", description: "Task status", enum: ["TODO", "IN_PROGRESS", "DONE"] },
                assigneeId: { type: "string", description: "ID of person assigned to task" }
              },
              required: ["id"]
            }
          },
          {
            name: "delete_task",
            description: "Delete a task from Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Task ID to delete" }
              },
              required: ["id"]
            }
          },

          // Opportunities Management
          {
            name: "create_opportunity",
            description: "Create a new opportunity in Twenty CRM. Supports standard fields and any custom fields. Use get_object_metadata('opportunities') to discover all available fields.",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Opportunity name" },
                amount: { type: "number", description: "Deal amount - accepts number or CURRENCY object {amountMicros, currencyCode}" },
                closeDate: { type: "string", description: "Expected close date (ISO 8601 format)" },
                stage: { type: "string", description: "Pipeline stage" },
                probability: { type: "number", description: "Win probability (0-100)" },
                companyId: { type: "string", description: "Associated company ID" },
                pointOfContactId: { type: "string", description: "Primary contact person ID" }
              },
              additionalProperties: true,
              required: ["name"]
            }
          },
          {
            name: "get_opportunity",
            description: "Get details of a specific opportunity by ID",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Opportunity ID" }
              },
              required: ["id"]
            }
          },
          {
            name: "update_opportunity",
            description: "Update an existing opportunity. Supports standard fields and any custom fields. Use get_object_metadata('opportunities') to discover all available fields.",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Opportunity ID" },
                name: { type: "string", description: "Opportunity name" },
                amount: { type: "number", description: "Deal amount - accepts number or CURRENCY object {amountMicros, currencyCode}" },
                closeDate: { type: "string", description: "Expected close date (ISO 8601 format)" },
                stage: { type: "string", description: "Pipeline stage" },
                probability: { type: "number", description: "Win probability (0-100)" },
                companyId: { type: "string", description: "Associated company ID" },
                pointOfContactId: { type: "string", description: "Primary contact person ID" }
              },
              additionalProperties: true,
              required: ["id"]
            }
          },
          {
            name: "list_opportunities",
            description: "List opportunities with optional filtering and pagination",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Number of results to return (default: 20)" },
                offset: { type: "number", description: "Number of results to skip (default: 0)" },
                search: { type: "string", description: "Search term for opportunity name" },
                stage: { type: "string", description: "Filter by pipeline stage" },
                companyId: { type: "string", description: "Filter by company ID" }
              }
            }
          },
          {
            name: "delete_opportunity",
            description: "Delete an opportunity from Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Opportunity ID to delete" }
              },
              required: ["id"]
            }
          },

          // Metadata Operations
          {
            name: "get_metadata_objects",
            description: "Get all object types and their metadata",
            inputSchema: {
              type: "object",
              properties: {}
            }
          },
          {
            name: "get_object_metadata",
            description: "Get metadata for a specific object type",
            inputSchema: {
              type: "object",
              properties: {
                objectName: { type: "string", description: "Object name (e.g., 'people', 'companies')" }
              },
              required: ["objectName"]
            }
          },

          // Search and Enrichment
          {
            name: "search_records",
            description: "Search across multiple object types",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search query" },
                objectTypes: { 
                  type: "array", 
                  items: { type: "string" },
                  description: "Object types to search (e.g., ['people', 'companies'])" 
                },
                limit: { type: "number", description: "Number of results per object type" }
              },
              required: ["query"]
            }
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          // People operations
          case "create_person":
            return await this.createPerson(args);
          case "get_person":
            return await this.getPerson(args.id);
          case "update_person":
            return await this.updatePerson(args);
          case "list_people":
            return await this.listPeople(args);
          case "delete_person":
            return await this.deletePerson(args.id);

          // Company operations
          case "create_company":
            return await this.createCompany(args);
          case "get_company":
            return await this.getCompany(args.id);
          case "update_company":
            return await this.updateCompany(args);
          case "list_companies":
            return await this.listCompanies(args);
          case "delete_company":
            return await this.deleteCompany(args.id);

          // Note operations
          case "create_note":
            return await this.createNote(args);
          case "get_note":
            return await this.getNote(args.id);
          case "list_notes":
            return await this.listNotes(args);
          case "update_note":
            return await this.updateNote(args);
          case "delete_note":
            return await this.deleteNote(args.id);

          // Task operations
          case "create_task":
            return await this.createTask(args);
          case "get_task":
            return await this.getTask(args.id);
          case "list_tasks":
            return await this.listTasks(args);
          case "update_task":
            return await this.updateTask(args);
          case "delete_task":
            return await this.deleteTask(args.id);

          // Opportunity operations
          case "create_opportunity":
            return await this.createOpportunity(args);
          case "get_opportunity":
            return await this.getOpportunity(args.id);
          case "update_opportunity":
            return await this.updateOpportunity(args);
          case "list_opportunities":
            return await this.listOpportunities(args);
          case "delete_opportunity":
            return await this.deleteOpportunity(args.id);

          // Metadata operations
          case "get_metadata_objects":
            return await this.getMetadataObjects();
          case "get_object_metadata":
            return await this.getObjectMetadata(args.objectName);

          // Search operations
          case "search_records":
            return await this.searchRecords(args);

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error.message}`
            }
          ]
        };
      }
    });
  }

  // People methods
  async createPerson(data) {
    // Try metadata-driven transformation first
    const fieldMetadata = await this.getFieldMetadata('person');
    let transformedData;

    if (fieldMetadata && fieldMetadata.length > 0) {
      transformedData = transformFieldsWithMetadata(data, fieldMetadata);
    } else {
      // Fallback to hardcoded composite field transformation
      transformedData = transformCompositeFields(data, 'person');
    }

    const result = await this.makeRequest("/rest/people", "POST", transformedData);
    return {
      content: [
        {
          type: "text",
          text: `Created person: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async getPerson(id) {
    const result = await this.makeRequest(`/rest/people/${id}`);
    return {
      content: [
        {
          type: "text",
          text: `Person details: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async updatePerson(data) {
    const { id, ...updateData } = data;

    // Try metadata-driven transformation first
    const fieldMetadata = await this.getFieldMetadata('person');
    let transformedData;

    if (fieldMetadata && fieldMetadata.length > 0) {
      transformedData = transformFieldsWithMetadata(updateData, fieldMetadata);
    } else {
      // Fallback to hardcoded composite field transformation
      transformedData = transformCompositeFields(updateData, 'person');
    }

    const result = await this.makeRequest(`/rest/people/${id}`, "PUT", transformedData);
    return {
      content: [
        {
          type: "text",
          text: `Updated person: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async listPeople(params = {}) {
    const { limit = 20, offset = 0, search, companyId } = params;
    let endpoint = `/rest/people?limit=${limit}&offset=${offset}`;
    
    if (search) {
      endpoint += `&search=${encodeURIComponent(search)}`;
    }
    if (companyId) {
      endpoint += `&companyId=${companyId}`;
    }

    const result = await this.makeRequest(endpoint);
    return {
      content: [
        {
          type: "text",
          text: `People list: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async deletePerson(id) {
    await this.makeRequest(`/rest/people/${id}`, "DELETE");
    return {
      content: [
        {
          type: "text",
          text: `Successfully deleted person with ID: ${id}`
        }
      ]
    };
  }

  // Company methods
  async createCompany(data) {
    // Try metadata-driven transformation first
    const fieldMetadata = await this.getFieldMetadata('company');
    let transformedData;

    if (fieldMetadata && fieldMetadata.length > 0) {
      transformedData = transformFieldsWithMetadata(data, fieldMetadata);
    } else {
      // Fallback to hardcoded composite field transformation
      transformedData = transformCompositeFields(data, 'company');
    }

    const result = await this.makeRequest("/rest/companies", "POST", transformedData);
    return {
      content: [
        {
          type: "text",
          text: `Created company: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async getCompany(id) {
    const result = await this.makeRequest(`/rest/companies/${id}`);
    return {
      content: [
        {
          type: "text",
          text: `Company details: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async updateCompany(data) {
    const { id, ...updateData } = data;

    // Try metadata-driven transformation first
    const fieldMetadata = await this.getFieldMetadata('company');
    let transformedData;

    if (fieldMetadata && fieldMetadata.length > 0) {
      transformedData = transformFieldsWithMetadata(updateData, fieldMetadata);
    } else {
      // Fallback to hardcoded composite field transformation
      transformedData = transformCompositeFields(updateData, 'company');
    }

    const result = await this.makeRequest(`/rest/companies/${id}`, "PUT", transformedData);
    return {
      content: [
        {
          type: "text",
          text: `Updated company: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async listCompanies(params = {}) {
    const { limit = 20, offset = 0, search } = params;
    let endpoint = `/rest/companies?limit=${limit}&offset=${offset}`;
    
    if (search) {
      endpoint += `&search=${encodeURIComponent(search)}`;
    }

    const result = await this.makeRequest(endpoint);
    return {
      content: [
        {
          type: "text",
          text: `Companies list: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async deleteCompany(id) {
    await this.makeRequest(`/rest/companies/${id}`, "DELETE");
    return {
      content: [
        {
          type: "text",
          text: `Successfully deleted company with ID: ${id}`
        }
      ]
    };
  }

  // Opportunity methods
  async createOpportunity(data) {
    // Try metadata-driven transformation first
    const fieldMetadata = await this.getFieldMetadata('opportunity');
    let transformedData;

    if (fieldMetadata && fieldMetadata.length > 0) {
      transformedData = transformFieldsWithMetadata(data, fieldMetadata);
    } else {
      // Fallback to hardcoded composite field transformation
      transformedData = transformCompositeFields(data, 'opportunity');
    }

    const result = await this.makeRequest("/rest/opportunities", "POST", transformedData);
    return {
      content: [
        {
          type: "text",
          text: `Created opportunity: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async getOpportunity(id) {
    const result = await this.makeRequest(`/rest/opportunities/${id}`);
    return {
      content: [
        {
          type: "text",
          text: `Opportunity details: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async updateOpportunity(data) {
    const { id, ...updateData } = data;

    // Try metadata-driven transformation first
    const fieldMetadata = await this.getFieldMetadata('opportunity');
    let transformedData;

    if (fieldMetadata && fieldMetadata.length > 0) {
      transformedData = transformFieldsWithMetadata(updateData, fieldMetadata);
    } else {
      // Fallback to hardcoded composite field transformation
      transformedData = transformCompositeFields(updateData, 'opportunity');
    }

    const result = await this.makeRequest(`/rest/opportunities/${id}`, "PUT", transformedData);
    return {
      content: [
        {
          type: "text",
          text: `Updated opportunity: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async listOpportunities(params = {}) {
    const { limit = 20, offset = 0, search, stage, companyId } = params;
    let endpoint = `/rest/opportunities?limit=${limit}&offset=${offset}`;

    if (search) {
      endpoint += `&search=${encodeURIComponent(search)}`;
    }
    if (stage) {
      endpoint += `&filter[stage]=${encodeURIComponent(stage)}`;
    }
    if (companyId) {
      endpoint += `&filter[companyId]=${encodeURIComponent(companyId)}`;
    }

    const result = await this.makeRequest(endpoint);
    return {
      content: [
        {
          type: "text",
          text: `Opportunities list: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async deleteOpportunity(id) {
    await this.makeRequest(`/rest/opportunities/${id}`, "DELETE");
    return {
      content: [
        {
          type: "text",
          text: `Successfully deleted opportunity with ID: ${id}`
        }
      ]
    };
  }

  // Note methods
  async createNote(data) {
    const result = await this.makeRequest("/rest/notes", "POST", data);
    return {
      content: [
        {
          type: "text",
          text: `Created note: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async getNote(id) {
    const result = await this.makeRequest(`/rest/notes/${id}`);
    return {
      content: [
        {
          type: "text",
          text: `Note details: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async listNotes(params = {}) {
    const { limit = 20, offset = 0, search } = params;
    let endpoint = `/rest/notes?limit=${limit}&offset=${offset}`;
    
    if (search) {
      endpoint += `&search=${encodeURIComponent(search)}`;
    }

    const result = await this.makeRequest(endpoint);
    return {
      content: [
        {
          type: "text",
          text: `Notes list: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async updateNote(data) {
    const { id, ...updateData } = data;
    const result = await this.makeRequest(`/rest/notes/${id}`, "PUT", updateData);
    return {
      content: [
        {
          type: "text",
          text: `Updated note: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async deleteNote(id) {
    await this.makeRequest(`/rest/notes/${id}`, "DELETE");
    return {
      content: [
        {
          type: "text",
          text: `Successfully deleted note with ID: ${id}`
        }
      ]
    };
  }

  // Task methods
  async createTask(data) {
    const result = await this.makeRequest("/rest/tasks", "POST", data);
    return {
      content: [
        {
          type: "text",
          text: `Created task: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async getTask(id) {
    const result = await this.makeRequest(`/rest/tasks/${id}`);
    return {
      content: [
        {
          type: "text",
          text: `Task details: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async listTasks(params = {}) {
    const { limit = 20, offset = 0, status, assigneeId } = params;
    let endpoint = `/rest/tasks?limit=${limit}&offset=${offset}`;
    
    if (status) {
      endpoint += `&status=${status}`;
    }
    if (assigneeId) {
      endpoint += `&assigneeId=${assigneeId}`;
    }

    const result = await this.makeRequest(endpoint);
    return {
      content: [
        {
          type: "text",
          text: `Tasks list: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async updateTask(data) {
    const { id, ...updateData } = data;
    const result = await this.makeRequest(`/rest/tasks/${id}`, "PUT", updateData);
    return {
      content: [
        {
          type: "text",
          text: `Updated task: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async deleteTask(id) {
    await this.makeRequest(`/rest/tasks/${id}`, "DELETE");
    return {
      content: [
        {
          type: "text",
          text: `Successfully deleted task with ID: ${id}`
        }
      ]
    };
  }

  // Metadata methods
  async getMetadataObjects() {
    const result = await this.makeRequest("/rest/metadata/objects");
    return {
      content: [
        {
          type: "text",
          text: `Metadata objects: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async getObjectMetadata(objectName) {
    // Use getFieldMetadata which handles normalization and GraphQL fallback
    const normalizedName = normalizeObjectName(objectName);
    const fields = await this.getFieldMetadata(objectName);

    if (!fields || fields.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No metadata found for object: ${objectName} (tried: ${normalizedName}). The object may not exist or metadata is unavailable.`
          }
        ]
      };
    }

    // Format for AI readability
    const formattedFields = fields.map(field => {
      const info = {
        name: field.name,
        label: field.label,
        type: field.type,
        required: field.isNullable === false,
      };

      // Add options for SELECT/MULTI_SELECT
      if (field.options && Array.isArray(field.options) && field.options.length > 0) {
        info.options = field.options.map(o => o.value || o.label || o);
      }

      // Add structure hints for composite types
      const structureHint = getCompositeStructureHint(field.type);
      if (structureHint) {
        info.structure = structureHint;
        info.note = "Can pass simple value (e.g., string) - will be auto-transformed";
      }

      return info;
    });

    // Build summary text
    const summary = formattedFields.map(f => {
      let line = `- ${f.name} (${f.type})`;
      if (f.required) line += ' [required]';
      if (f.options) line += ` - options: ${f.options.join(', ')}`;
      return line;
    }).join('\n');

    return {
      content: [
        {
          type: "text",
          text: `Fields for ${normalizedName}:\n\n${summary}\n\nDetailed schema:\n${JSON.stringify(formattedFields, null, 2)}\n\nNote: For composite types (LINKS, ADDRESS, EMAILS, etc.), you can pass simple values that will be auto-transformed.`
        }
      ]
    };
  }

  // Search methods
  async searchRecords(params) {
    const { query, objectTypes = ['people', 'companies'], limit = 10 } = params;
    const results = {};

    for (const objectType of objectTypes) {
      try {
        const endpoint = `/rest/${objectType}?search=${encodeURIComponent(query)}&limit=${limit}`;
        results[objectType] = await this.makeRequest(endpoint);
      } catch (error) {
        results[objectType] = { error: error.message };
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `Search results for "${query}": ${JSON.stringify(results, null, 2)}`
        }
      ]
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Twenty CRM MCP server running on stdio");
  }
}

const server = new TwentyCRMServer();
server.run().catch(console.error);