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
            description: "Create person. Supports custom fields.",
            inputSchema: {
              type: "object",
              properties: {
                firstName: { type: "string", description: "First name" },
                lastName: { type: "string", description: "Last name" },
                email: { type: "string", description: "Email (string or {primaryEmail})" },
                phone: { type: "string", description: "Phone" },
                jobTitle: { type: "string", description: "Job title" },
                companyId: { type: "string", description: "Company ID" },
                linkedinUrl: { type: "string", description: "LinkedIn URL (string or LINKS)" },
                city: { type: "string", description: "City" },
                avatarUrl: { type: "string", description: "Avatar URL" }
              },
              additionalProperties: true,
              required: ["firstName", "lastName"]
            }
          },
          {
            name: "get_person",
            description: "Get person by ID",
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
            description: "Update person. Supports custom fields.",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Person ID" },
                firstName: { type: "string", description: "First name" },
                lastName: { type: "string", description: "Last name" },
                email: { type: "string", description: "Email (string or {primaryEmail})" },
                phone: { type: "string", description: "Phone" },
                jobTitle: { type: "string", description: "Job title" },
                companyId: { type: "string", description: "Company ID" },
                linkedinUrl: { type: "string", description: "LinkedIn URL (string or LINKS)" },
                city: { type: "string", description: "City" }
              },
              additionalProperties: true,
              required: ["id"]
            }
          },
          {
            name: "list_people",
            description: "List/filter people with pagination.",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Limit (default: 20, max: 100)" },
                cursor: { type: "string", description: "Cursor from pageInfo.endCursor" },
                search: { type: "string", description: "Search firstName" },
                firstName: { type: "string", description: "Filter firstName" },
                lastName: { type: "string", description: "Filter lastName" },
                email: { type: "string", description: "Filter email (exact)" },
                companyId: { type: "string", description: "Filter companyId (exact)" }
              }
            }
          },
          {
            name: "delete_person",
            description: "Delete person by ID",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Person ID" }
              },
              required: ["id"]
            }
          },

          // Company Management
          {
            name: "create_company",
            description: "Create company. Supports custom fields.",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Company name" },
                domainName: { type: "string", description: "Domain (string or LINKS)" },
                address: { type: "string", description: "Address (string or ADDRESS)" },
                employees: { type: "number", description: "Employee count" },
                linkedinUrl: { type: "string", description: "LinkedIn URL (string or LINKS)" },
                xUrl: { type: "string", description: "X/Twitter URL (string or LINKS)" },
                annualRecurringRevenue: { type: "number", description: "ARR" },
                idealCustomerProfile: { type: "boolean", description: "ICP flag" }
              },
              additionalProperties: true,
              required: ["name"]
            }
          },
          {
            name: "get_company",
            description: "Get company by ID",
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
            description: "Update company. Supports custom fields.",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Company ID" },
                name: { type: "string", description: "Company name" },
                domainName: { type: "string", description: "Domain (string or LINKS)" },
                address: { type: "string", description: "Address (string or ADDRESS)" },
                employees: { type: "number", description: "Employee count" },
                linkedinUrl: { type: "string", description: "LinkedIn URL (string or LINKS)" },
                annualRecurringRevenue: { type: "number", description: "ARR" }
              },
              additionalProperties: true,
              required: ["id"]
            }
          },
          {
            name: "list_companies",
            description: "List/filter companies with pagination.",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Limit (default: 20, max: 100)" },
                cursor: { type: "string", description: "Cursor from pageInfo.endCursor" },
                search: { type: "string", description: "Search name" },
                name: { type: "string", description: "Filter name (exact)" },
                domainName: { type: "string", description: "Filter domain" }
              }
            }
          },
          {
            name: "delete_company",
            description: "Delete company by ID",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Company ID" }
              },
              required: ["id"]
            }
          },

          // Notes Management
          {
            name: "create_note",
            description: "Create note",
            inputSchema: {
              type: "object",
              properties: {
                title: { type: "string", description: "Title" },
                body: { type: "string", description: "Content" },
                position: { type: "number", description: "Order position" }
              },
              required: ["title", "body"]
            }
          },
          {
            name: "get_note",
            description: "Get note by ID",
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
            description: "List/filter notes with pagination.",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Limit (default: 20, max: 100)" },
                cursor: { type: "string", description: "Cursor from pageInfo.endCursor" },
                search: { type: "string", description: "Search title" }
              }
            }
          },
          {
            name: "update_note",
            description: "Update note",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Note ID" },
                title: { type: "string", description: "Title" },
                body: { type: "string", description: "Content" },
                position: { type: "number", description: "Order position" }
              },
              required: ["id"]
            }
          },
          {
            name: "delete_note",
            description: "Delete note by ID",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Note ID" }
              },
              required: ["id"]
            }
          },

          // Tasks Management
          {
            name: "create_task",
            description: "Create task",
            inputSchema: {
              type: "object",
              properties: {
                title: { type: "string", description: "Title" },
                body: { type: "string", description: "Description" },
                dueAt: { type: "string", description: "Due date (ISO 8601)" },
                status: { type: "string", description: "Status", enum: ["TODO", "IN_PROGRESS", "DONE"] },
                assigneeId: { type: "string", description: "Assignee ID" },
                position: { type: "number", description: "Order position" }
              },
              required: ["title"]
            }
          },
          {
            name: "get_task",
            description: "Get task by ID",
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
            description: "List/filter tasks with pagination.",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Limit (default: 20, max: 100)" },
                cursor: { type: "string", description: "Cursor from pageInfo.endCursor" },
                search: { type: "string", description: "Search title" },
                status: { type: "string", description: "Filter status", enum: ["TODO", "IN_PROGRESS", "DONE"] },
                assigneeId: { type: "string", description: "Filter assignee" }
              }
            }
          },
          {
            name: "update_task",
            description: "Update task",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Task ID" },
                title: { type: "string", description: "Title" },
                body: { type: "string", description: "Description" },
                dueAt: { type: "string", description: "Due date (ISO 8601)" },
                status: { type: "string", description: "Status", enum: ["TODO", "IN_PROGRESS", "DONE"] },
                assigneeId: { type: "string", description: "Assignee ID" }
              },
              required: ["id"]
            }
          },
          {
            name: "delete_task",
            description: "Delete task by ID",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Task ID" }
              },
              required: ["id"]
            }
          },

          // Opportunities Management
          {
            name: "create_opportunity",
            description: "Create opportunity. Supports custom fields.",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Name" },
                amount: { type: "number", description: "Amount (number or CURRENCY)" },
                closeDate: { type: "string", description: "Close date (ISO 8601)" },
                stage: { type: "string", description: "Pipeline stage" },
                probability: { type: "number", description: "Win probability (0-100)" },
                companyId: { type: "string", description: "Company ID" },
                pointOfContactId: { type: "string", description: "Contact person ID" }
              },
              additionalProperties: true,
              required: ["name"]
            }
          },
          {
            name: "get_opportunity",
            description: "Get opportunity by ID",
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
            description: "Update opportunity. Supports custom fields.",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Opportunity ID" },
                name: { type: "string", description: "Name" },
                amount: { type: "number", description: "Amount (number or CURRENCY)" },
                closeDate: { type: "string", description: "Close date (ISO 8601)" },
                stage: { type: "string", description: "Pipeline stage" },
                probability: { type: "number", description: "Win probability (0-100)" },
                companyId: { type: "string", description: "Company ID" },
                pointOfContactId: { type: "string", description: "Contact person ID" }
              },
              additionalProperties: true,
              required: ["id"]
            }
          },
          {
            name: "list_opportunities",
            description: "List/filter opportunities with pagination.",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Limit (default: 20, max: 100)" },
                cursor: { type: "string", description: "Cursor from pageInfo.endCursor" },
                search: { type: "string", description: "Search name" },
                stage: { type: "string", description: "Filter stage" },
                companyId: { type: "string", description: "Filter company" }
              }
            }
          },
          {
            name: "delete_opportunity",
            description: "Delete opportunity by ID",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Opportunity ID" }
              },
              required: ["id"]
            }
          },

          // Metadata Operations
          {
            name: "get_metadata_objects",
            description: "List all object types",
            inputSchema: {
              type: "object",
              properties: {}
            }
          },
          {
            name: "get_object_metadata",
            description: "Get fields for object type",
            inputSchema: {
              type: "object",
              properties: {
                objectName: { type: "string", description: "Object name (people, companies, etc.)" }
              },
              required: ["objectName"]
            }
          },

          // Generic CRUD (any object type)
          {
            name: "create_record",
            description: "Create any record type",
            inputSchema: {
              type: "object",
              properties: {
                objectType: { type: "string", description: "Object type (people, companies, noteTargets, etc.)" },
                data: { type: "object", description: "Field values", additionalProperties: true }
              },
              required: ["objectType", "data"]
            }
          },
          {
            name: "get_record",
            description: "Get any record by ID",
            inputSchema: {
              type: "object",
              properties: {
                objectType: { type: "string", description: "Object type" },
                id: { type: "string", description: "Record ID" }
              },
              required: ["objectType", "id"]
            }
          },
          {
            name: "update_record",
            description: "Update any record",
            inputSchema: {
              type: "object",
              properties: {
                objectType: { type: "string", description: "Object type" },
                id: { type: "string", description: "Record ID" },
                data: { type: "object", description: "Fields to update", additionalProperties: true }
              },
              required: ["objectType", "id", "data"]
            }
          },
          {
            name: "list_records",
            description: "List/filter any record type",
            inputSchema: {
              type: "object",
              properties: {
                objectType: { type: "string", description: "Object type" },
                limit: { type: "number", description: "Limit (default: 20, max: 100)" },
                cursor: { type: "string", description: "Pagination cursor" },
                filter: { type: "object", description: "Filter {field: value}", additionalProperties: true }
              },
              required: ["objectType"]
            }
          },
          {
            name: "delete_record",
            description: "Delete any record",
            inputSchema: {
              type: "object",
              properties: {
                objectType: { type: "string", description: "Object type" },
                id: { type: "string", description: "Record ID" }
              },
              required: ["objectType", "id"]
            }
          },

          // Search
          {
            name: "search_records",
            description: "Search across object types by name/title",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search query" },
                objectTypes: {
                  type: "array",
                  items: { type: "string" },
                  description: "Types to search (default: people, companies)"
                },
                limit: { type: "number", description: "Results per type (default: 10)" }
              },
              required: ["query"]
            }
          },

          // Find or Create
          {
            name: "find_or_create_company",
            description: "Find by domain/name or create company",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Company name" },
                domainName: { type: "string", description: "Domain for matching" },
                address: { type: "string", description: "Address" },
                employees: { type: "number", description: "Employee count" },
                linkedinUrl: { type: "string", description: "LinkedIn URL" },
                xUrl: { type: "string", description: "X/Twitter URL" },
                annualRecurringRevenue: { type: "number", description: "ARR" },
                idealCustomerProfile: { type: "boolean", description: "ICP flag" }
              },
              additionalProperties: true,
              required: ["name"]
            }
          },
          {
            name: "find_or_create_person",
            description: "Find by email or create person",
            inputSchema: {
              type: "object",
              properties: {
                firstName: { type: "string", description: "First name" },
                lastName: { type: "string", description: "Last name" },
                email: { type: "string", description: "Email for matching" },
                phone: { type: "string", description: "Phone" },
                jobTitle: { type: "string", description: "Job title" },
                companyId: { type: "string", description: "Company ID" },
                linkedinUrl: { type: "string", description: "LinkedIn URL" },
                city: { type: "string", description: "City" },
                avatarUrl: { type: "string", description: "Avatar URL" }
              },
              additionalProperties: true,
              required: ["email"]
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

          // Generic CRUD operations
          case "create_record":
            return await this.createRecord(args.objectType, args.data);
          case "get_record":
            return await this.getRecord(args.objectType, args.id);
          case "update_record":
            return await this.updateRecord(args.objectType, args.id, args.data);
          case "list_records":
            return await this.listRecords(args.objectType, args);
          case "delete_record":
            return await this.deleteRecord(args.objectType, args.id);

          // Search operations
          case "search_records":
            return await this.searchRecords(args);

          // Find or Create operations
          case "find_or_create_company":
            return await this.findOrCreateCompany(args);
          case "find_or_create_person":
            return await this.findOrCreatePerson(args);

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
    const { limit = 20, cursor, search, companyId, email, firstName, lastName } = params;
    // Validate and sanitize limit
    const sanitizedLimit = Math.max(1, Math.min(100, parseInt(limit) || 20));
    let endpoint = `/rest/people?limit=${sanitizedLimit}`;

    // Cursor-based pagination
    if (cursor) {
      endpoint += `&starting_after=${encodeURIComponent(cursor)}`;
    }

    // Filter by name (partial match on firstName)
    if (search) {
      endpoint += `&filter=name.firstName[ilike]:${encodeURIComponent('%' + search + '%')}`;
    }

    // Filter by first name (partial match)
    if (firstName) {
      endpoint += `&filter=name.firstName[ilike]:${encodeURIComponent('%' + firstName + '%')}`;
    }

    // Filter by last name (partial match)
    if (lastName) {
      endpoint += `&filter=name.lastName[ilike]:${encodeURIComponent('%' + lastName + '%')}`;
    }

    // Filter by email (exact match)
    if (email) {
      endpoint += `&filter=emails.primaryEmail[eq]:${encodeURIComponent(email)}`;
    }

    // Filter by company ID (exact match)
    if (companyId) {
      endpoint += `&filter=companyId[eq]:${encodeURIComponent(companyId)}`;
    }

    const result = await this.makeRequest(endpoint);

    // Extract pagination info from response
    const pageInfo = result.pageInfo || {};

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            people: result.data?.people || result.data || [],
            pageInfo: {
              hasNextPage: pageInfo.hasNextPage || false,
              endCursor: pageInfo.endCursor || null
            }
          }, null, 2)
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
    const { limit = 20, cursor, search, domainName, name } = params;
    // Validate and sanitize limit
    const sanitizedLimit = Math.max(1, Math.min(100, parseInt(limit) || 20));
    let endpoint = `/rest/companies?limit=${sanitizedLimit}`;

    // Cursor-based pagination
    if (cursor) {
      endpoint += `&starting_after=${encodeURIComponent(cursor)}`;
    }

    // Filter by name (partial match)
    if (search) {
      endpoint += `&filter=name[ilike]:${encodeURIComponent('%' + search + '%')}`;
    }

    // Filter by exact name
    if (name) {
      endpoint += `&filter=name[eq]:${encodeURIComponent(name)}`;
    }

    // Filter by domain name (partial match on primaryLinkUrl)
    if (domainName) {
      endpoint += `&filter=domainName.primaryLinkUrl[ilike]:${encodeURIComponent('%' + domainName + '%')}`;
    }

    const result = await this.makeRequest(endpoint);

    // Extract pagination info from response
    const pageInfo = result.pageInfo || {};

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            companies: result.data?.companies || result.data || [],
            pageInfo: {
              hasNextPage: pageInfo.hasNextPage || false,
              endCursor: pageInfo.endCursor || null
            }
          }, null, 2)
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
    const { limit = 20, cursor, search, stage, companyId } = params;
    // Validate and sanitize limit
    const sanitizedLimit = Math.max(1, Math.min(100, parseInt(limit) || 20));
    let endpoint = `/rest/opportunities?limit=${sanitizedLimit}`;

    // Cursor-based pagination
    if (cursor) {
      endpoint += `&starting_after=${encodeURIComponent(cursor)}`;
    }

    // Filter by name (partial match)
    if (search) {
      endpoint += `&filter=name[ilike]:${encodeURIComponent('%' + search + '%')}`;
    }

    // Filter by stage (exact match)
    if (stage) {
      endpoint += `&filter=stage[eq]:${encodeURIComponent(stage)}`;
    }

    // Filter by company ID (exact match)
    if (companyId) {
      endpoint += `&filter=companyId[eq]:${encodeURIComponent(companyId)}`;
    }

    const result = await this.makeRequest(endpoint);

    // Extract pagination info from response
    const pageInfo = result.pageInfo || {};

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            opportunities: result.data?.opportunities || result.data || [],
            pageInfo: {
              hasNextPage: pageInfo.hasNextPage || false,
              endCursor: pageInfo.endCursor || null
            }
          }, null, 2)
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
    const { limit = 20, cursor, search } = params;
    // Validate and sanitize limit
    const sanitizedLimit = Math.max(1, Math.min(100, parseInt(limit) || 20));
    let endpoint = `/rest/notes?limit=${sanitizedLimit}`;

    // Cursor-based pagination
    if (cursor) {
      endpoint += `&starting_after=${encodeURIComponent(cursor)}`;
    }

    // Filter by title (partial match)
    if (search) {
      endpoint += `&filter=title[ilike]:${encodeURIComponent('%' + search + '%')}`;
    }

    const result = await this.makeRequest(endpoint);

    // Extract pagination info from response
    const pageInfo = result.pageInfo || {};

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            notes: result.data?.notes || result.data || [],
            pageInfo: {
              hasNextPage: pageInfo.hasNextPage || false,
              endCursor: pageInfo.endCursor || null
            }
          }, null, 2)
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
    const { limit = 20, cursor, search, status, assigneeId } = params;
    // Validate and sanitize limit
    const sanitizedLimit = Math.max(1, Math.min(100, parseInt(limit) || 20));
    let endpoint = `/rest/tasks?limit=${sanitizedLimit}`;

    // Cursor-based pagination
    if (cursor) {
      endpoint += `&starting_after=${encodeURIComponent(cursor)}`;
    }

    // Filter by title (partial match)
    if (search) {
      endpoint += `&filter=title[ilike]:${encodeURIComponent('%' + search + '%')}`;
    }

    // Filter by status (exact match)
    if (status) {
      endpoint += `&filter=status[eq]:${encodeURIComponent(status)}`;
    }

    // Filter by assignee ID (exact match)
    if (assigneeId) {
      endpoint += `&filter=assigneeId[eq]:${encodeURIComponent(assigneeId)}`;
    }

    const result = await this.makeRequest(endpoint);

    // Extract pagination info from response
    const pageInfo = result.pageInfo || {};

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            tasks: result.data?.tasks || result.data || [],
            pageInfo: {
              hasNextPage: pageInfo.hasNextPage || false,
              endCursor: pageInfo.endCursor || null
            }
          }, null, 2)
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

  // Generic CRUD methods (work with any object type)
  async createRecord(objectType, data) {
    const normalizedType = normalizeObjectName(objectType);

    // Try metadata-driven transformation
    const fieldMetadata = await this.getFieldMetadata(objectType);
    let transformedData;

    if (fieldMetadata && fieldMetadata.length > 0) {
      transformedData = transformFieldsWithMetadata(data, fieldMetadata);
    } else {
      // Pass through without transformation if no metadata
      transformedData = data;
    }

    const result = await this.makeRequest(`/rest/${normalizedType}`, "POST", transformedData);
    return {
      content: [
        {
          type: "text",
          text: `Created ${objectType} record: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async getRecord(objectType, id) {
    const normalizedType = normalizeObjectName(objectType);
    const result = await this.makeRequest(`/rest/${normalizedType}/${id}`);
    return {
      content: [
        {
          type: "text",
          text: `${objectType} record: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async updateRecord(objectType, id, data) {
    const normalizedType = normalizeObjectName(objectType);

    // Try metadata-driven transformation
    const fieldMetadata = await this.getFieldMetadata(objectType);
    let transformedData;

    if (fieldMetadata && fieldMetadata.length > 0) {
      transformedData = transformFieldsWithMetadata(data, fieldMetadata);
    } else {
      // Pass through without transformation if no metadata
      transformedData = data;
    }

    const result = await this.makeRequest(`/rest/${normalizedType}/${id}`, "PUT", transformedData);
    return {
      content: [
        {
          type: "text",
          text: `Updated ${objectType} record: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async listRecords(objectType, params = {}) {
    const normalizedType = normalizeObjectName(objectType);
    const { limit = 20, cursor, filter } = params;
    const sanitizedLimit = Math.max(1, Math.min(100, parseInt(limit) || 20));

    let endpoint = `/rest/${normalizedType}?limit=${sanitizedLimit}`;

    // Cursor-based pagination
    if (cursor) {
      endpoint += `&starting_after=${encodeURIComponent(cursor)}`;
    }

    // Build filter string from filter object
    if (filter && typeof filter === 'object') {
      const filterParts = [];
      for (const [field, value] of Object.entries(filter)) {
        if (value !== undefined && value !== null) {
          filterParts.push(`${field}[eq]:${encodeURIComponent(value)}`);
        }
      }
      if (filterParts.length > 0) {
        endpoint += `&filter=${filterParts.join(',')}`;
      }
    }

    const result = await this.makeRequest(endpoint);
    const pageInfo = result.pageInfo || {};

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            records: result.data?.[normalizedType] || result.data || [],
            pageInfo: {
              hasNextPage: pageInfo.hasNextPage || false,
              endCursor: pageInfo.endCursor || null
            }
          }, null, 2)
        }
      ]
    };
  }

  async deleteRecord(objectType, id) {
    const normalizedType = normalizeObjectName(objectType);
    await this.makeRequest(`/rest/${normalizedType}/${id}`, "DELETE");
    return {
      content: [
        {
          type: "text",
          text: `Successfully deleted ${objectType} record with ID: ${id}`
        }
      ]
    };
  }

  // Search methods
  async searchRecords(params) {
    const { query, objectTypes = ['people', 'companies'], limit = 10 } = params;
    const results = {};

    // Define the searchable field(s) for each object type
    // Arrays = search multiple fields and merge results (for broader matching)
    const searchFieldMap = {
      'people': ['name.firstName', 'name.lastName'],
      'companies': 'name',
      'opportunities': 'name',
      'notes': 'title',
      'tasks': 'title'
    };

    for (const objectType of objectTypes) {
      try {
        const searchFields = searchFieldMap[objectType] || 'name';

        if (Array.isArray(searchFields)) {
          // Multi-field search: split query into words and search each word in each field
          const allResults = [];
          const seenIds = new Set();
          const queryWords = query.trim().split(/\s+/).filter(w => w.length > 0);

          for (const field of searchFields) {
            for (const word of queryWords) {
              const filter = `filter=${field}[ilike]:${encodeURIComponent('%' + word + '%')}`;
              const endpoint = `/rest/${objectType}?${filter}&limit=${limit}`;
              const result = await this.makeRequest(endpoint);
              const items = result.data?.[objectType] || result.data || [];

              for (const item of items) {
                if (!seenIds.has(item.id)) {
                  seenIds.add(item.id);
                  allResults.push(item);
                }
              }
            }
          }
          results[objectType] = allResults;
        } else {
          // Single field search
          const filter = `filter=${searchFields}[ilike]:${encodeURIComponent('%' + query + '%')}`;
          const endpoint = `/rest/${objectType}?${filter}&limit=${limit}`;
          const result = await this.makeRequest(endpoint);
          results[objectType] = result.data?.[objectType] || result.data || [];
        }
      } catch (error) {
        results[objectType] = { error: error.message };
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `Search results for "${query}":\n${JSON.stringify(results, null, 2)}`
        }
      ]
    };
  }

  // Find or Create methods
  async findOrCreateCompany(data) {
    const { domainName, name, ...otherData } = data;

    // Step 1: Try to find existing company
    let searchFilter = '';
    let searchDescription = '';

    if (domainName) {
      // Clean domain - remove protocol and www prefix
      const cleanDomain = domainName.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      searchFilter = `filter=domainName.primaryLinkUrl[ilike]:${encodeURIComponent('%' + cleanDomain + '%')}`;
      searchDescription = `domain "${cleanDomain}"`;
    } else if (name) {
      searchFilter = `filter=name[eq]:${encodeURIComponent(name)}`;
      searchDescription = `name "${name}"`;
    }

    if (searchFilter) {
      try {
        const searchResult = await this.makeRequest(`/rest/companies?${searchFilter}&limit=1`);
        const companies = searchResult.data?.companies || searchResult.data || [];

        if (companies.length > 0) {
          const existing = companies[0];
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "found_existing",
                  message: `Found existing company matching ${searchDescription}`,
                  company: existing
                }, null, 2)
              }
            ]
          };
        }
      } catch (error) {
        // Search failed, proceed to create
        console.error(`Search failed: ${error.message}, proceeding to create`);
      }
    }

    // Step 2: Create new company directly via API
    try {
      // Transform fields using metadata (same as createCompany)
      const fieldMetadata = await this.getFieldMetadata('company');
      let transformedData;

      if (fieldMetadata && fieldMetadata.length > 0) {
        transformedData = transformFieldsWithMetadata({ name, domainName, ...otherData }, fieldMetadata);
      } else {
        transformedData = transformCompositeFields({ name, domainName, ...otherData }, 'company');
      }

      const result = await this.makeRequest("/rest/companies", "POST", transformedData);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "created_new",
              message: "Created new company",
              company: result
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              message: `Failed to create company: ${error.message}`
            }, null, 2)
          }
        ]
      };
    }
  }

  async findOrCreatePerson(data) {
    const { email, firstName, lastName, ...otherData } = data;

    // Step 1: Try to find existing person by email
    if (email) {
      try {
        const searchFilter = `filter=emails.primaryEmail[eq]:${encodeURIComponent(email)}`;
        const searchResult = await this.makeRequest(`/rest/people?${searchFilter}&limit=1`);
        const people = searchResult.data?.people || searchResult.data || [];

        if (people.length > 0) {
          const existing = people[0];
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "found_existing",
                  message: `Found existing person with email "${email}"`,
                  person: existing
                }, null, 2)
              }
            ]
          };
        }
      } catch (error) {
        // Search failed, proceed to create
        console.error(`Search failed: ${error.message}, proceeding to create`);
      }
    }

    // Step 2: Create new person directly via API
    try {
      // Transform fields using metadata (same as createPerson)
      const fieldMetadata = await this.getFieldMetadata('person');
      let transformedData;

      if (fieldMetadata && fieldMetadata.length > 0) {
        transformedData = transformFieldsWithMetadata({ firstName, lastName, email, ...otherData }, fieldMetadata);
      } else {
        transformedData = transformCompositeFields({ firstName, lastName, email, ...otherData }, 'person');
      }

      const result = await this.makeRequest("/rest/people", "POST", transformedData);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "created_new",
              message: "Created new person",
              person: result
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              message: `Failed to create person: ${error.message}`
            }, null, 2)
          }
        ]
      };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Twenty CRM MCP server running on stdio");
  }
}

const server = new TwentyCRMServer();
server.run().catch(console.error);