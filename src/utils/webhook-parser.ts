/**
 * RB2B Webhook Payload Parser
 *
 * Parses and normalizes RB2B webhook payloads into a typed interface.
 * Built against the PRD-assumed format — adjust field mappings once
 * a real webhook payload is captured.
 */

export interface RB2BSignal {
  linkedin_url: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  company_name: string | null;
  industry: string | null;
  employee_count: string | null;
  revenue_range: string | null;
  city: string | null;
  state: string | null;
  pages_visited: string[];
  page_view_count: number;
  timestamp: string;
}

/**
 * Map of RB2B field names to internal field names.
 * RB2B may use PascalCase (LinkedInUrl) or camelCase (linkedInUrl).
 * This normalizes both.
 */
function getField(body: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
      return body[key];
    }
  }
  return null;
}

function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function toPagesArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

export function parseRB2BWebhook(body: unknown): RB2BSignal | null {
  if (!body || typeof body !== 'object') return null;

  const data = body as Record<string, unknown>;

  // linkedin_url is required — reject without it
  const linkedinUrl = toStringOrNull(
    getField(data, 'LinkedInUrl', 'linkedInUrl', 'linkedin_url', 'linkedinUrl', 'profileUrl')
  );
  if (!linkedinUrl) return null;

  return {
    linkedin_url: linkedinUrl,
    first_name: toStringOrNull(getField(data, 'FirstName', 'firstName', 'first_name')),
    last_name: toStringOrNull(getField(data, 'LastName', 'lastName', 'last_name')),
    title: toStringOrNull(getField(data, 'Title', 'title', 'jobTitle')),
    company_name: toStringOrNull(getField(data, 'CompanyName', 'companyName', 'company_name', 'company')),
    industry: toStringOrNull(getField(data, 'Industry', 'industry')),
    employee_count: toStringOrNull(getField(data, 'EstimatedEmployeeCount', 'estimatedEmployeeCount', 'employee_count', 'employeeCount')),
    revenue_range: toStringOrNull(getField(data, 'EstimateRevenue', 'estimateRevenue', 'revenue_range', 'revenueRange')),
    city: toStringOrNull(getField(data, 'City', 'city')),
    state: toStringOrNull(getField(data, 'State', 'state', 'Region', 'region')),
    pages_visited: toPagesArray(getField(data, 'PagesVisited', 'pagesVisited', 'pages_visited', 'pages')),
    page_view_count: Number(getField(data, 'PageViewCount', 'pageViewCount', 'page_view_count') ?? 1),
    timestamp: toStringOrNull(getField(data, 'Timestamp', 'timestamp', 'created_at', 'createdAt')) ?? new Date().toISOString(),
  };
}

/**
 * Validate the webhook secret matches the expected value.
 */
export function validateWebhookSecret(headerValue: string | undefined, expected: string): boolean {
  if (!expected) return true; // No secret configured, allow all
  return headerValue === expected;
}
