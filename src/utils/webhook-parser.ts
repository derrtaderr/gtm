/**
 * RB2B Webhook Payload Parser
 *
 * Parses and normalizes RB2B webhook payloads into a typed interface.
 * RB2B sends fields with spaces (e.g., "LinkedIn URL", "First Name").
 *
 * Real RB2B payload field names (confirmed from test webhook):
 *   "LinkedIn URL", "First Name", "Last Name", "Title", "Company Name",
 *   "Business Email", "Website", "Industry", "Employee Count",
 *   "Estimate Revenue", "City", "State", "Zipcode", "Seen At",
 *   "Referrer", "Captured URL", "Tags"
 */

export interface RB2BSignal {
  linkedin_url: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  company_name: string | null;
  work_email: string | null;
  website: string | null;
  industry: string | null;
  employee_count: string | null;
  revenue_range: string | null;
  city: string | null;
  state: string | null;
  zipcode: string | null;
  pages_visited: string[];
  page_view_count: number;
  referrer: string | null;
  tags: string[];
  timestamp: string;
}

/**
 * Get a field from the payload trying multiple key variants.
 * Handles RB2B's "Field Name" format alongside camelCase/snake_case.
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
    // RB2B sends a single "Captured URL" — wrap in array
    return value ? [value] : [];
  }
  return [];
}

function toTagsArray(value: unknown): string[] {
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
    getField(data, 'LinkedIn URL', 'LinkedInUrl', 'linkedInUrl', 'linkedin_url', 'linkedinUrl', 'profileUrl')
  );
  if (!linkedinUrl) return null;

  return {
    linkedin_url: linkedinUrl,
    first_name: toStringOrNull(getField(data, 'First Name', 'FirstName', 'firstName', 'first_name')),
    last_name: toStringOrNull(getField(data, 'Last Name', 'LastName', 'lastName', 'last_name')),
    title: toStringOrNull(getField(data, 'Title', 'title', 'jobTitle')),
    company_name: toStringOrNull(getField(data, 'Company Name', 'CompanyName', 'companyName', 'company_name', 'company')),
    work_email: toStringOrNull(getField(data, 'Business Email', 'BusinessEmail', 'businessEmail', 'work_email', 'email')),
    website: toStringOrNull(getField(data, 'Website', 'website')),
    industry: toStringOrNull(getField(data, 'Industry', 'industry')),
    employee_count: toStringOrNull(getField(data, 'Employee Count', 'EstimatedEmployeeCount', 'estimatedEmployeeCount', 'employee_count', 'employeeCount')),
    revenue_range: toStringOrNull(getField(data, 'Estimate Revenue', 'EstimateRevenue', 'estimateRevenue', 'revenue_range', 'revenueRange')),
    city: toStringOrNull(getField(data, 'City', 'city')),
    state: toStringOrNull(getField(data, 'State', 'state', 'Region', 'region')),
    zipcode: toStringOrNull(getField(data, 'Zipcode', 'zipcode', 'zip', 'postal_code')),
    pages_visited: toPagesArray(getField(data, 'Captured URL', 'PagesVisited', 'pagesVisited', 'pages_visited', 'pages')),
    page_view_count: Number(getField(data, 'PageViewCount', 'pageViewCount', 'page_view_count') ?? 1),
    referrer: toStringOrNull(getField(data, 'Referrer', 'referrer', 'referer')),
    tags: toTagsArray(getField(data, 'Tags', 'tags')),
    timestamp: toStringOrNull(getField(data, 'Seen At', 'SeenAt', 'seenAt', 'Timestamp', 'timestamp', 'created_at', 'createdAt')) ?? new Date().toISOString(),
  };
}

/**
 * Validate the webhook secret matches the expected value.
 */
export function validateWebhookSecret(headerValue: string | undefined, expected: string): boolean {
  if (!expected) return true; // No secret configured, allow all
  return headerValue === expected;
}
