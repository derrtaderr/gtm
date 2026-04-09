/**
 * Proxycurl MCP Server — Custom in-process MCP server for Proxycurl API
 *
 * Tools:
 * - proxycurl_person_profile: Get full LinkedIn profile data including recent posts/activity
 * - proxycurl_company_profile: Get company data by LinkedIn URL or domain
 *
 * Used as fallback when Clay quota is exceeded, and for richer LinkedIn-specific
 * data (recent posts, activity) that feeds GoExtrovert's personalization quality.
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const PROXYCURL_API_BASE = 'https://nubela.co/proxycurl/api';

function getProxycurlHeaders(): HeadersInit {
  return {
    'Authorization': `Bearer ${process.env.PROXYCURL_API_KEY}`,
  };
}

const proxycurlPersonProfile = tool(
  'proxycurl_person_profile',
  'Get full LinkedIn profile data by profile URL via Proxycurl. Returns name, title, company, location, education, experience, recent posts, and activity. This data is especially valuable for personalization — recent posts and engagement tell you what this person cares about right now.',
  {
    linkedin_url: z.string().describe('LinkedIn profile URL (e.g., https://linkedin.com/in/example)'),
    include_activity: z.boolean().optional().describe('Include recent posts and activity (costs extra credits). Default true.'),
  },
  async (args) => {
    try {
      const params = new URLSearchParams({
        url: args.linkedin_url,
        use_cache: 'if-recent',
        fallback_to_cache: 'on-error',
      });

      // Include activity data by default — it feeds GoExtrovert personalization quality
      if (args.include_activity !== false) {
        params.set('personal_email', 'exclude');
        params.set('personal_contact_number', 'exclude');
        params.set('extra', 'include');
      }

      const response = await fetch(`${PROXYCURL_API_BASE}/v2/linkedin?${params}`, {
        method: 'GET',
        headers: getProxycurlHeaders(),
      });

      if (response.status === 429) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Proxycurl rate limit reached. Credits may be exhausted for this month (500/month on $49 plan).' }) }], isError: true };
      }

      if (!response.ok) {
        const errorText = await response.text();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Proxycurl API error ${response.status}: ${errorText}` }) }], isError: true };
      }

      const profile = await response.json();

      // Extract the fields most relevant to the GTM pipeline
      const result = {
        full_name: profile.full_name,
        first_name: profile.first_name,
        last_name: profile.last_name,
        headline: profile.headline,
        summary: profile.summary,
        occupation: profile.occupation,
        city: profile.city,
        state: profile.state,
        country: profile.country_full_name,
        connections: profile.connections,
        // Current position
        current_company: profile.experiences?.[0]?.company,
        current_title: profile.experiences?.[0]?.title,
        current_company_linkedin_url: profile.experiences?.[0]?.company_linkedin_profile_url,
        // Firmographic from current company
        industry: profile.industry,
        // Activity data (feeds GoExtrovert personalization quality)
        recent_posts: profile.activities?.map((a: any) => ({
          title: a.title,
          link: a.link,
          activity_status: a.activity_status,
        }))?.slice(0, 5) ?? [],
        // Education
        education: profile.education?.map((e: any) => ({
          school: e.school,
          degree: e.degree_name,
          field: e.field_of_study,
        }))?.slice(0, 3) ?? [],
        // Skills
        skills: profile.accomplishment_courses?.slice(0, 10) ?? [],
        // Profile URL
        linkedin_url: profile.public_identifier ? `https://linkedin.com/in/${profile.public_identifier}` : args.linkedin_url,
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Proxycurl person_profile failed: ${error instanceof Error ? error.message : String(error)}` }) }], isError: true };
    }
  }
);

const proxycurlCompanyProfile = tool(
  'proxycurl_company_profile',
  'Get company data by LinkedIn company URL or domain via Proxycurl. Returns industry, employee count, revenue range, description, specialties, and website.',
  {
    linkedin_url: z.string().optional().describe('LinkedIn company page URL'),
    domain: z.string().optional().describe('Company website domain (e.g., acme.com)'),
  },
  async (args) => {
    try {
      if (!args.linkedin_url && !args.domain) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Either linkedin_url or domain is required' }) }], isError: true };
      }

      let url: string;
      if (args.linkedin_url) {
        const params = new URLSearchParams({
          url: args.linkedin_url,
          use_cache: 'if-recent',
        });
        url = `${PROXYCURL_API_BASE}/linkedin/company?${params}`;
      } else {
        const params = new URLSearchParams({
          enrich_profile: 'skip',
          company_domain: args.domain!,
          use_cache: 'if-recent',
        });
        url = `${PROXYCURL_API_BASE}/linkedin/company/resolve?${params}`;
      }

      const response = await fetch(url, {
        method: 'GET',
        headers: getProxycurlHeaders(),
      });

      if (response.status === 429) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Proxycurl rate limit reached.' }) }], isError: true };
      }

      if (!response.ok) {
        const errorText = await response.text();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Proxycurl API error ${response.status}: ${errorText}` }) }], isError: true };
      }

      const company = await response.json();

      const result = {
        name: company.name,
        description: company.description,
        industry: company.industry,
        company_size: company.company_size_on_linkedin,
        company_size_range: company.company_size,
        website: company.website,
        founded_year: company.founded_year,
        specialities: company.specialities,
        hq_city: company.hq?.city,
        hq_state: company.hq?.state,
        hq_country: company.hq?.country,
        linkedin_url: company.linkedin_internal_id ? `https://linkedin.com/company/${company.linkedin_internal_id}` : args.linkedin_url,
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Proxycurl company_profile failed: ${error instanceof Error ? error.message : String(error)}` }) }], isError: true };
    }
  }
);

export const proxycurlServer = createSdkMcpServer({
  name: 'proxycurl',
  version: '1.0.0',
  tools: [proxycurlPersonProfile, proxycurlCompanyProfile],
});
