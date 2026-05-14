// =============================================================================
// FORMAUT EMAIL TEMPLATE ENGINE
// =============================================================================
// Generates branded, email-safe HTML for all Formaut email scenarios.
//
// Design philosophy:
//   - No runtime email library dependencies (Cloudflare Workers edge compatible)
//   - React Email patterns adapted to plain string templating
//   - MJML-compatible output structure (tables, inline styles, max-width 600px)
//   - Brand variables injected per client
//   - Each template family is a pure function: (data) => html string
//   - Unsubscribe block conditionally appended based on scenario compliance rules
//   - LLM generates copy; this engine renders it into email-safe HTML
// =============================================================================

// ---------------------------------------------------------------------------
// BRAND DEFAULTS
// Applied when client brand values are partially or fully absent.
// ---------------------------------------------------------------------------

const BRAND_DEFAULTS = {
  primary_color: '#1a1a1a',
  accent_color: '#4f46e5',
  background_color: '#f9fafb',
  surface_color: '#ffffff',
  text_color: '#1f2937',
  muted_color: '#6b7280',
  font_family: "'-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', sans-serif",
  logo_url: null,
  business_name: 'Your Business',
  tagline: '',
  address: '',
  website_url: '',
};

// ---------------------------------------------------------------------------
// SHARED STRUCTURAL PRIMITIVES
// Inline-styled, table-based for maximum email client compatibility.
// ---------------------------------------------------------------------------

function emailWrapper(content, brand = {}) {
  const b = { ...BRAND_DEFAULTS, ...brand };
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${escHtml(b.business_name)}</title>
  <!--[if mso]>
  <noscript>
    <xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
  </noscript>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background-color:${b.background_color};font-family:${b.font_family};">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:${b.background_color};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;background-color:${b.surface_color};border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          ${content}
        </table>
        ${emailFooterBlock(b)}
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function emailHeader(brand = {}) {
  const b = { ...BRAND_DEFAULTS, ...brand };
  const logoHtml = b.logo_url
    ? `<img src="${escHtml(b.logo_url)}" alt="${escHtml(b.business_name)}" height="40" style="display:block;height:40px;width:auto;max-width:200px;" />`
    : `<span style="font-size:20px;font-weight:700;color:${b.primary_color};">${escHtml(b.business_name)}</span>`;

  return `
  <tr>
    <td style="background-color:${b.primary_color};padding:24px 32px;text-align:center;">
      ${logoHtml}
    </td>
  </tr>`;
}

function emailBody(children) {
  return `
  <tr>
    <td style="padding:40px 32px;">
      ${children}
    </td>
  </tr>`;
}

function emailDivider(brand = {}) {
  const b = { ...BRAND_DEFAULTS, ...brand };
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:24px 0;">
    <tr><td style="border-top:1px solid #e5e7eb;"></td></tr>
  </table>`;
}

function emailButton(label, url, brand = {}) {
  const b = { ...BRAND_DEFAULTS, ...brand };
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr>
      <td style="background-color:${b.accent_color};border-radius:6px;text-align:center;">
        <a href="${escHtml(url)}" target="_blank" style="display:inline-block;padding:14px 28px;color:#ffffff;font-weight:600;font-size:15px;text-decoration:none;letter-spacing:0.01em;">${escHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

function emailDataRow(label, value, brand = {}) {
  const b = { ...BRAND_DEFAULTS, ...brand };
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:8px 0;">
    <tr>
      <td style="font-size:13px;color:${b.muted_color};padding-right:16px;white-space:nowrap;vertical-align:top;">${escHtml(label)}</td>
      <td style="font-size:14px;color:${b.text_color};font-weight:500;">${escHtml(String(value))}</td>
    </tr>
  </table>`;
}

function emailFooterBlock(brand = {}) {
  const b = { ...BRAND_DEFAULTS, ...brand };
  const parts = [];
  if (b.business_name) parts.push(escHtml(b.business_name));
  if (b.address) parts.push(escHtml(b.address));
  if (b.website_url) parts.push(`<a href="${escHtml(b.website_url)}" style="color:${b.muted_color};">${escHtml(b.website_url.replace(/^https?:\/\//, ''))}</a>`);

  return `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px;max-width:600px;width:100%;">
    <tr>
      <td style="text-align:center;font-size:12px;color:${b.muted_color};padding:16px 0 8px;">
        ${parts.join(' · ')}
      </td>
    </tr>
  </table>`;
}

function unsubscribeBlock(unsubscribe_url, brand = {}) {
  const b = { ...BRAND_DEFAULTS, ...brand };
  if (!unsubscribe_url) return '';
  return `
  <tr>
    <td style="background-color:#f3f4f6;padding:16px 32px;text-align:center;">
      <p style="margin:0;font-size:12px;color:${b.muted_color};">
        You received this email because you opted in at ${escHtml(b.business_name)}.
        <a href="${escHtml(unsubscribe_url)}" style="color:${b.muted_color};text-decoration:underline;">Unsubscribe</a>
        ${b.address ? `<br />${escHtml(b.address)}` : ''}
      </p>
    </td>
  </tr>`;
}

function heading(text, brand = {}) {
  const b = { ...BRAND_DEFAULTS, ...brand };
  return `<h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:${b.text_color};line-height:1.3;">${escHtml(text)}</h1>`;
}

function subheading(text, brand = {}) {
  const b = { ...BRAND_DEFAULTS, ...brand };
  return `<h2 style="margin:0 0 12px;font-size:18px;font-weight:600;color:${b.text_color};">${escHtml(text)}</h2>`;
}

function paragraph(text, brand = {}) {
  const b = { ...BRAND_DEFAULTS, ...brand };
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${b.text_color};">${escHtml(text)}</p>`;
}

function muted(text, brand = {}) {
  const b = { ...BRAND_DEFAULTS, ...brand };
  return `<p style="margin:0 0 8px;font-size:13px;color:${b.muted_color};">${escHtml(text)}</p>`;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// TEMPLATE FAMILIES
// Each returns a full HTML email string. All data values are escaped.
// ---------------------------------------------------------------------------

// --- Transactional Confirmation ---
// contact_form_confirmation, booking_confirmation, order_confirmation, quote_received

export function renderTransactionalConfirmation({ brand = {}, headline, subline, detail_rows = [], body_lines = [], cta_label, cta_url, closing_line }) {
  const b = { ...BRAND_DEFAULTS, ...brand };

  const bodyContent = [
    heading(headline, b),
    subline ? paragraph(subline, b) : '',
    ...body_lines.map(l => paragraph(l, b)),
    detail_rows.length ? emailDivider(b) : '',
    ...detail_rows.map(([label, value]) => emailDataRow(label, value, b)),
    detail_rows.length ? emailDivider(b) : '',
    cta_label && cta_url ? emailButton(cta_label, cta_url, b) : '',
    closing_line ? muted(closing_line, b) : '',
  ].join('');

  return emailWrapper([
    emailHeader(b),
    emailBody(bodyContent),
  ].join(''), b);
}

// --- Internal Alert ---
// lead_notification, internal_staff_notification

export function renderInternalAlert({ brand = {}, alert_type, headline, summary, detail_rows = [], cta_label, cta_url }) {
  const b = { ...BRAND_DEFAULTS, ...brand };

  const bodyContent = [
    muted(alert_type || 'Alert from your website', b),
    heading(headline, b),
    paragraph(summary, b),
    detail_rows.length ? emailDivider(b) : '',
    ...detail_rows.map(([label, value]) => emailDataRow(label, value, b)),
    detail_rows.length ? emailDivider(b) : '',
    cta_label && cta_url ? emailButton(cta_label, cta_url, b) : '',
  ].join('');

  return emailWrapper([
    emailHeader(b),
    emailBody(bodyContent),
  ].join(''), b);
}

// --- Reminder ---
// booking_reminder, invoice_payment_reminder

export function renderReminder({ brand = {}, headline, reminder_detail, detail_rows = [], body_lines = [], cta_label, cta_url, unsubscribe_url }) {
  const b = { ...BRAND_DEFAULTS, ...brand };

  const bodyContent = [
    heading(headline, b),
    paragraph(reminder_detail, b),
    ...body_lines.map(l => paragraph(l, b)),
    detail_rows.length ? emailDivider(b) : '',
    ...detail_rows.map(([label, value]) => emailDataRow(label, value, b)),
    detail_rows.length ? emailDivider(b) : '',
    cta_label && cta_url ? emailButton(cta_label, cta_url, b) : '',
  ].join('');

  return emailWrapper([
    emailHeader(b),
    emailBody(bodyContent),
    unsubscribeBlock(unsubscribe_url, b),
  ].join(''), b);
}

// --- Follow-Up ---
// missed_contact_followup

export function renderFollowup({ brand = {}, headline, body_lines = [], cta_label, cta_url }) {
  const b = { ...BRAND_DEFAULTS, ...brand };

  const bodyContent = [
    heading(headline, b),
    ...body_lines.map(l => paragraph(l, b)),
    cta_label && cta_url ? emailButton(cta_label, cta_url, b) : '',
  ].join('');

  return emailWrapper([
    emailHeader(b),
    emailBody(bodyContent),
  ].join(''), b);
}

// --- Review Request ---

export function renderReviewRequest({ brand = {}, headline, body_lines = [], review_url, unsubscribe_url, closing_line }) {
  const b = { ...BRAND_DEFAULTS, ...brand };

  const bodyContent = [
    heading(headline, b),
    ...body_lines.map(l => paragraph(l, b)),
    review_url ? emailButton('Leave a Review', review_url, b) : '',
    closing_line ? muted(closing_line, b) : '',
  ].join('');

  return emailWrapper([
    emailHeader(b),
    emailBody(bodyContent),
    unsubscribeBlock(unsubscribe_url, b),
  ].join(''), b);
}

// --- Marketing Recovery ---
// abandoned_cart, reengagement

export function renderMarketingRecovery({ brand = {}, headline, subline, body_lines = [], cta_label, cta_url, unsubscribe_url, closing_line }) {
  const b = { ...BRAND_DEFAULTS, ...brand };

  const bodyContent = [
    heading(headline, b),
    subline ? paragraph(subline, b) : '',
    ...body_lines.map(l => paragraph(l, b)),
    emailDivider(b),
    cta_label && cta_url ? emailButton(cta_label, cta_url, b) : '',
    closing_line ? muted(closing_line, b) : '',
  ].join('');

  return emailWrapper([
    emailHeader(b),
    emailBody(bodyContent),
    unsubscribeBlock(unsubscribe_url, b),
  ].join(''), b);
}

// --- Newsletter / Announcement ---

export function renderNewsletter({ brand = {}, headline, intro, sections = [], cta_label, cta_url, unsubscribe_url }) {
  const b = { ...BRAND_DEFAULTS, ...brand };

  const sectionsHtml = sections.map(({ title, body }) => `
    ${title ? subheading(title, b) : ''}
    ${paragraph(body, b)}
    ${emailDivider(b)}
  `).join('');

  const bodyContent = [
    heading(headline, b),
    intro ? paragraph(intro, b) : '',
    emailDivider(b),
    sectionsHtml,
    cta_label && cta_url ? emailButton(cta_label, cta_url, b) : '',
  ].join('');

  return emailWrapper([
    emailHeader(b),
    emailBody(bodyContent),
    unsubscribeBlock(unsubscribe_url, b),
  ].join(''), b);
}

// --- Auto Reply ---

export function renderAutoReply({ brand = {}, headline, body_lines = [], cta_label, cta_url, closing_line }) {
  const b = { ...BRAND_DEFAULTS, ...brand };

  const bodyContent = [
    heading(headline, b),
    ...body_lines.map(l => paragraph(l, b)),
    cta_label && cta_url ? emailButton(cta_label, cta_url, b) : '',
    closing_line ? muted(closing_line, b) : '',
  ].join('');

  return emailWrapper([
    emailHeader(b),
    emailBody(bodyContent),
  ].join(''), b);
}

// ---------------------------------------------------------------------------
// TEMPLATE DISPATCHER
// Routes a scenario_id and data object to the correct renderer.
// ---------------------------------------------------------------------------

const TEMPLATE_FAMILY_MAP = {
  transactional_confirmation: renderTransactionalConfirmation,
  internal_alert:             renderInternalAlert,
  reminder:                   renderReminder,
  followup:                   renderFollowup,
  review_request:             renderReviewRequest,
  marketing_recovery:         renderMarketingRecovery,
  newsletter:                 renderNewsletter,
  transactional_update:       renderTransactionalConfirmation, // same structure
  auto_reply:                 renderAutoReply,
};

/**
 * Render a template by family name.
 *
 * @param {string} template_family  - key from TEMPLATE_FAMILY_MAP
 * @param {object} data             - template-specific data (from LLM output or user input)
 * @returns {string} - full HTML email
 */
export function renderEmailTemplate(template_family, data) {
  const renderer = TEMPLATE_FAMILY_MAP[template_family];
  if (!renderer) throw new Error(`Unknown template family: ${template_family}. Valid: ${Object.keys(TEMPLATE_FAMILY_MAP).join(', ')}`);
  return renderer(data);
}

// ---------------------------------------------------------------------------
// LLM PROMPT BUILDER
// Generates the prompt Formaut sends to Claude to produce copy for a template.
// The LLM response should be a JSON object matching the data shape for the
// target template family.
// ---------------------------------------------------------------------------

/**
 * Build a structured prompt for copy generation.
 * Returns a string the caller passes to the Anthropic API.
 */
export function buildEmailCopyPrompt({ scenario, business_profile, template_family, custom_instructions }) {
  const dataShapes = {
    transactional_confirmation: '{ headline, subline, body_lines[], detail_rows[][], cta_label, cta_url, closing_line }',
    internal_alert:             '{ alert_type, headline, summary, detail_rows[][], cta_label, cta_url }',
    reminder:                   '{ headline, reminder_detail, body_lines[], detail_rows[][], cta_label, cta_url }',
    followup:                   '{ headline, body_lines[], cta_label, cta_url }',
    review_request:             '{ headline, body_lines[], review_url, closing_line }',
    marketing_recovery:         '{ headline, subline, body_lines[], cta_label, cta_url, closing_line }',
    newsletter:                 '{ headline, intro, sections[{ title, body }], cta_label, cta_url }',
    auto_reply:                 '{ headline, body_lines[], cta_label, cta_url, closing_line }',
    transactional_update:       '{ headline, subline, body_lines[], detail_rows[][], cta_label, cta_url, closing_line }',
  };

  const dataShape = dataShapes[template_family] || '{ headline, body_lines[] }';
  const bp = business_profile || {};

  return `You are writing email copy for a small business website managed by Formaut.

Business: ${bp.business_name || 'the business'}
Industry: ${bp.industry || 'not specified'}
Tone: ${bp.brand_voice || 'professional, friendly, and clear'}
Location: ${bp.location || 'not specified'}
Services: ${(bp.services || []).join(', ') || 'not specified'}

Email scenario: ${scenario.label}
Goal: ${scenario.goal}
Recipient: ${scenario.recipient}
${scenario.requires_unsubscribe ? 'COMPLIANCE: This email requires an unsubscribe link. Note "unsubscribe_url" as a placeholder — the system will inject the real URL.' : ''}

${custom_instructions ? `Additional instructions: ${custom_instructions}` : ''}

Generate email copy that matches the brand voice. Be specific, direct, and warm.
Do not use generic filler. Do not mention Formaut.
Return ONLY a JSON object with this shape (no markdown, no preamble):
${dataShape}

Where detail_rows is an array of [label, value] pairs.
Where body_lines is an array of paragraph strings.`.trim();
}

// ---------------------------------------------------------------------------
// CLOUDFLARE EMAIL ROUTING HELPER
// Generates the configuration instructions Formaut produces when setting up
// inbound email routing for a client. These are applied via Cloudflare API,
// not rendered as HTML email.
// ---------------------------------------------------------------------------

/**
 * Generate Cloudflare Email Routing configuration for a client.
 *
 * @param {object} params
 * @param {string} params.from_address   - e.g. "info@clientdomain.com"
 * @param {string} params.to_address     - business owner personal inbox
 * @param {string} params.zone_id        - Cloudflare zone ID for the domain
 * @returns {object} configuration plan
 */
export function planEmailRoutingConfig({ from_address, to_address, zone_id }) {
  const domain = from_address?.split('@')[1] || '';

  return {
    type: 'cloudflare_email_routing',
    zone_id,
    domain,
    rules: [
      {
        name: `Forward ${from_address} to owner inbox`,
        matchers: [{ type: 'literal', field: 'to', value: from_address }],
        actions: [{ type: 'forward', value: [to_address] }],
        enabled: true,
      },
    ],
    catch_all: {
      enabled: true,
      actions: [{ type: 'forward', value: [to_address] }],
    },
    mx_records: [
      { type: 'MX', name: domain, content: 'route1.mx.cloudflare.net', priority: 88 },
      { type: 'MX', name: domain, content: 'route2.mx.cloudflare.net', priority: 73 },
      { type: 'MX', name: domain, content: 'route3.mx.cloudflare.net', priority: 9 },
    ],
    notes: 'Apply MX records to the Cloudflare DNS zone, then enable Email Routing. The destination address must be verified by Cloudflare before routing activates.',
  };
}
