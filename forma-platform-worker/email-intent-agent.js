// =============================================================================
// FORMAUT EMAIL INTENT AGENT
// =============================================================================
// Business-rule layer for email: classifies intent, selects provider + template
// family, decides compliance requirements, and plans deployment.
//
// Design principles:
//   - Cheap deterministic routing first (no LLM for classification)
//   - LLM only for copy/HTML generation or ambiguous intent resolution
//   - Resend for outbound transactional (client owns account + reputation)
//   - Cloudflare Email Routing for inbound aliases and forwarding
//   - No bulk marketing platform unless client explicitly requests it
//   - Client owns: sending domain, Resend account, Cloudflare zone
// =============================================================================

// ---------------------------------------------------------------------------
// SCENARIO REGISTRY
// ---------------------------------------------------------------------------
// Each scenario is a self-contained business rule describing:
//   trigger, recipient, channel, provider, compliance, review requirement.
// ---------------------------------------------------------------------------

export const EMAIL_SCENARIOS = {
  contact_form_confirmation: {
    id: 'contact_form_confirmation',
    label: 'Contact Form Confirmation',
    trigger: 'visitor submits contact form',
    recipient: 'customer',
    sender: 'business',
    channel: 'outbound',
    provider: 'resend',
    template_family: 'transactional_confirmation',
    requires_unsubscribe: false,
    requires_approval: false,
    risk: 'low',
    goal: 'confirm receipt and set expectations',
    suggested_subject: 'We received your message',
    business_types: ['all'],
  },

  lead_notification: {
    id: 'lead_notification',
    label: 'New Lead Notification',
    trigger: 'visitor submits contact form',
    recipient: 'business_owner',
    sender: 'system',
    channel: 'outbound',
    provider: 'resend',
    template_family: 'internal_alert',
    requires_unsubscribe: false,
    requires_approval: false,
    risk: 'low',
    goal: 'help owner respond quickly to new leads',
    suggested_subject: 'New lead from your website',
    business_types: ['all'],
  },

  booking_confirmation: {
    id: 'booking_confirmation',
    label: 'Booking Confirmation',
    trigger: 'customer completes booking',
    recipient: 'customer',
    sender: 'business',
    channel: 'outbound',
    provider: 'resend',
    template_family: 'transactional_confirmation',
    requires_unsubscribe: false,
    requires_approval: false,
    risk: 'low',
    goal: 'confirm booking details and next steps',
    suggested_subject: 'Your booking is confirmed',
    business_types: ['service', 'hospitality', 'health', 'beauty'],
  },

  booking_reminder: {
    id: 'booking_reminder',
    label: 'Booking Reminder',
    trigger: 'N hours before scheduled appointment',
    recipient: 'customer',
    sender: 'business',
    channel: 'outbound',
    provider: 'resend',
    template_family: 'reminder',
    requires_unsubscribe: false,
    requires_approval: false,
    risk: 'low',
    goal: 'reduce no-shows',
    suggested_subject: 'Reminder: your appointment tomorrow',
    business_types: ['service', 'hospitality', 'health', 'beauty'],
  },

  missed_contact_followup: {
    id: 'missed_contact_followup',
    label: 'Missed Contact Follow-Up',
    trigger: 'call or chat message goes unanswered for N minutes',
    recipient: 'customer',
    sender: 'business',
    channel: 'outbound',
    provider: 'resend',
    template_family: 'followup',
    requires_unsubscribe: false,
    requires_approval: false,
    risk: 'low',
    goal: 'recover a missed opportunity promptly',
    suggested_subject: 'Sorry we missed you',
    business_types: ['service', 'trades', 'retail'],
  },

  quote_received: {
    id: 'quote_received',
    label: 'Quote / Request Received',
    trigger: 'customer submits quote request form',
    recipient: 'customer',
    sender: 'business',
    channel: 'outbound',
    provider: 'resend',
    template_family: 'transactional_confirmation',
    requires_unsubscribe: false,
    requires_approval: false,
    risk: 'low',
    goal: 'confirm request received and set turnaround expectation',
    suggested_subject: 'Quote request received',
    business_types: ['trades', 'service', 'construction'],
  },

  invoice_payment_reminder: {
    id: 'invoice_payment_reminder',
    label: 'Invoice / Payment Reminder',
    trigger: 'invoice due date approaching or past due',
    recipient: 'customer',
    sender: 'business',
    channel: 'outbound',
    provider: 'resend',
    template_family: 'reminder',
    requires_unsubscribe: false,
    requires_approval: true,
    risk: 'medium',
    goal: 'collect payment without damaging the relationship',
    suggested_subject: 'Invoice reminder',
    business_types: ['service', 'trades', 'freelance', 'professional'],
  },

  order_confirmation: {
    id: 'order_confirmation',
    label: 'Order Confirmation',
    trigger: 'customer completes purchase',
    recipient: 'customer',
    sender: 'business',
    channel: 'outbound',
    provider: 'resend',
    template_family: 'transactional_confirmation',
    requires_unsubscribe: false,
    requires_approval: false,
    risk: 'low',
    goal: 'confirm order and set delivery expectations',
    suggested_subject: 'Order confirmed — thank you!',
    business_types: ['ecommerce', 'printify', 'retail'],
  },

  shipping_update: {
    id: 'shipping_update',
    label: 'Shipping / Order Update',
    trigger: 'order status changes (shipped, delivered, delayed)',
    recipient: 'customer',
    sender: 'business',
    channel: 'outbound',
    provider: 'resend',
    template_family: 'transactional_update',
    requires_unsubscribe: false,
    requires_approval: false,
    risk: 'low',
    goal: 'keep customer informed and reduce support load',
    suggested_subject: 'Your order has shipped',
    business_types: ['ecommerce', 'printify', 'retail'],
  },

  abandoned_cart: {
    id: 'abandoned_cart',
    label: 'Abandoned Cart Recovery',
    trigger: 'cart inactive for N hours without purchase',
    recipient: 'customer',
    sender: 'business',
    channel: 'outbound',
    provider: 'resend',
    template_family: 'marketing_recovery',
    requires_unsubscribe: true,
    requires_approval: true,
    risk: 'medium',
    goal: 'recover abandoned purchase without being pushy',
    suggested_subject: 'You left something behind',
    business_types: ['ecommerce', 'printify', 'retail'],
  },

  review_request: {
    id: 'review_request',
    label: 'Review Request',
    trigger: 'job marked complete or order fulfilled',
    recipient: 'customer',
    sender: 'business',
    channel: 'outbound',
    provider: 'resend',
    template_family: 'review_request',
    requires_unsubscribe: true,
    requires_approval: true,
    risk: 'medium',
    goal: 'ask for a public review without being pushy',
    suggested_subject: 'How did we do?',
    business_types: ['all'],
  },

  reengagement: {
    id: 'reengagement',
    label: 'Re-engagement / Win-Back',
    trigger: 'customer inactive for N days with prior purchase history',
    recipient: 'customer',
    sender: 'business',
    channel: 'outbound',
    provider: 'resend',
    template_family: 'marketing_recovery',
    requires_unsubscribe: true,
    requires_approval: true,
    risk: 'medium',
    goal: 'reconnect with lapsed customers',
    suggested_subject: "We miss you — here's what's new",
    business_types: ['all'],
  },

  newsletter_announcement: {
    id: 'newsletter_announcement',
    label: 'Newsletter / Announcement',
    trigger: 'manual send or scheduled campaign',
    recipient: 'subscriber_list',
    sender: 'business',
    channel: 'outbound',
    provider: 'resend_broadcast',
    template_family: 'newsletter',
    requires_unsubscribe: true,
    requires_approval: true,
    risk: 'high',
    goal: 'keep audience informed and engaged',
    suggested_subject: null,
    business_types: ['all'],
    notes: 'Resend Broadcasts or Mailchimp for volume. Client must have a subscriber list and CAN-SPAM/GDPR compliant opt-in.',
  },

  inbound_alias_forwarding: {
    id: 'inbound_alias_forwarding',
    label: 'Inbound Email Alias / Forwarding',
    trigger: 'email received at custom address',
    recipient: 'business_inbox',
    sender: 'external_sender',
    channel: 'inbound',
    provider: 'cloudflare_email_routing',
    template_family: null,
    requires_unsubscribe: false,
    requires_approval: false,
    risk: 'low',
    goal: 'route incoming email to business inbox via custom domain',
    business_types: ['all'],
    notes: 'Zero cost. Configured in Cloudflare Email Routing — no Resend account needed for this scenario.',
  },

  inbound_filter_worker: {
    id: 'inbound_filter_worker',
    label: 'Inbound Email Filter / Worker',
    trigger: 'email received, custom rules apply',
    recipient: 'varies',
    sender: 'external_sender',
    channel: 'inbound',
    provider: 'cloudflare_email_workers',
    template_family: null,
    requires_unsubscribe: false,
    requires_approval: false,
    risk: 'low',
    goal: 'apply business-specific inbound routing rules (spam filter, auto-archive, conditional forward)',
    business_types: ['all'],
    notes: 'Cloudflare Email Workers. Use when simple Email Routing is not expressive enough.',
  },

  internal_staff_notification: {
    id: 'internal_staff_notification',
    label: 'Internal Staff Notification',
    trigger: 'system event relevant to staff (new booking, payment, form)',
    recipient: 'staff_team',
    sender: 'system',
    channel: 'outbound',
    provider: 'resend',
    template_family: 'internal_alert',
    requires_unsubscribe: false,
    requires_approval: false,
    risk: 'low',
    goal: 'keep staff informed without manual checking',
    business_types: ['all'],
  },

  auto_reply_inbound: {
    id: 'auto_reply_inbound',
    label: 'Auto-Reply for Inbound Email',
    trigger: 'email received at business address',
    recipient: 'sender',
    sender: 'business',
    channel: 'inbound_triggered_outbound',
    provider: 'cloudflare_email_workers',
    template_family: 'auto_reply',
    requires_unsubscribe: false,
    requires_approval: false,
    risk: 'low',
    goal: 'acknowledge inbound emails automatically',
    business_types: ['all'],
    notes: 'Use Cloudflare Email Worker to send auto-reply via Resend or direct SMTP forward.',
  },
};

// ---------------------------------------------------------------------------
// PROVIDER SELECTOR
// Deterministic. No LLM.
// ---------------------------------------------------------------------------

/**
 * Given a classified scenario, return the implementation plan.
 * Always returns the smallest safe implementation.
 */
export function selectEmailProvider(scenario) {
  const s = typeof scenario === 'string' ? EMAIL_SCENARIOS[scenario] : scenario;
  if (!s) throw new Error(`Unknown email scenario: ${scenario}`);

  if (s.channel === 'inbound' && s.provider === 'cloudflare_email_routing') {
    return {
      scenario_id: s.id,
      implementation: 'cloudflare_email_routing',
      requires_resend: false,
      requires_cloudflare_email_routing: true,
      requires_cloudflare_email_workers: false,
      requires_client_domain_dns: true,
      cost: 'free',
      notes: 'Configure MX records in Cloudflare DNS. No additional account needed.',
    };
  }

  if (s.channel === 'inbound' && s.provider === 'cloudflare_email_workers') {
    return {
      scenario_id: s.id,
      implementation: 'cloudflare_email_workers',
      requires_resend: false,
      requires_cloudflare_email_routing: true,
      requires_cloudflare_email_workers: true,
      requires_client_domain_dns: true,
      cost: 'free',
      notes: 'Email Worker deployed to client Cloudflare account.',
    };
  }

  if (s.channel === 'inbound_triggered_outbound') {
    return {
      scenario_id: s.id,
      implementation: 'cloudflare_email_worker_with_resend',
      requires_resend: true,
      requires_cloudflare_email_routing: true,
      requires_cloudflare_email_workers: true,
      requires_client_domain_dns: true,
      cost: 'free_within_resend_limit',
      notes: 'Email Worker receives inbound, calls Resend API to send auto-reply.',
    };
  }

  if (s.provider === 'resend_broadcast') {
    return {
      scenario_id: s.id,
      implementation: 'resend_broadcasts',
      requires_resend: true,
      requires_resend_audience: true,
      requires_cloudflare_email_routing: false,
      requires_cloudflare_email_workers: false,
      requires_client_domain_dns: true,
      cost: 'resend_paid_for_volume',
      notes: 'Resend Broadcasts requires client to have verified domain and Resend account.',
    };
  }

  // Default: outbound transactional via Resend
  return {
    scenario_id: s.id,
    implementation: 'resend_transactional',
    requires_resend: true,
    requires_cloudflare_email_routing: false,
    requires_cloudflare_email_workers: false,
    requires_client_domain_dns: true,
    cost: 'free_within_resend_limit',
    notes: 'Client creates Resend account, verifies domain, Formaut stores encrypted API key.',
  };
}

// ---------------------------------------------------------------------------
// INTENT CLASSIFIER
// Deterministic keyword + trigger matching.
// Falls back to null if ambiguous (caller should invoke LLM to resolve).
// ---------------------------------------------------------------------------

const KEYWORD_MAP = [
  { keywords: ['contact form', 'contact us', 'form submission'], scenario: 'contact_form_confirmation' },
  { keywords: ['new lead', 'lead notification', 'owner alert', 'notify me'], scenario: 'lead_notification' },
  { keywords: ['booking confirmation', 'appointment confirmed', 'confirmed booking'], scenario: 'booking_confirmation' },
  { keywords: ['booking reminder', 'appointment reminder', 'remind', 'upcoming appointment'], scenario: 'booking_reminder' },
  { keywords: ['missed call', 'missed message', 'no answer', 'sorry we missed'], scenario: 'missed_contact_followup' },
  { keywords: ['quote request', 'estimate request', 'request received'], scenario: 'quote_received' },
  { keywords: ['invoice', 'payment reminder', 'past due', 'payment due'], scenario: 'invoice_payment_reminder' },
  { keywords: ['order confirmation', 'order placed', 'purchase confirmation'], scenario: 'order_confirmation' },
  { keywords: ['shipping', 'order update', 'tracking', 'delivered', 'shipped'], scenario: 'shipping_update' },
  { keywords: ['abandoned cart', 'left something', 'cart recovery'], scenario: 'abandoned_cart' },
  { keywords: ['review request', 'leave a review', 'how did we do', 'feedback request'], scenario: 'review_request' },
  { keywords: ['re-engagement', 'win back', 'win-back', 'lapsed', 'inactive customer', 'we miss you'], scenario: 'reengagement' },
  { keywords: ['newsletter', 'announcement', 'broadcast', 'campaign'], scenario: 'newsletter_announcement' },
  { keywords: ['email alias', 'custom email', 'forward email', 'info@', 'hello@', 'inbound routing'], scenario: 'inbound_alias_forwarding' },
  { keywords: ['inbound filter', 'email worker', 'email rule', 'routing rule'], scenario: 'inbound_filter_worker' },
  { keywords: ['staff notification', 'team notification', 'internal alert', 'notify team'], scenario: 'internal_staff_notification' },
  { keywords: ['auto reply', 'auto-reply', 'out of office', 'automatic response'], scenario: 'auto_reply_inbound' },
];

/**
 * Classify a natural language intent string into a scenario ID.
 * Returns null if no confident match — caller should use LLM fallback.
 *
 * @param {string} intent
 * @returns {{ scenario_id: string, confidence: 'high'|'medium' } | null}
 */
export function classifyEmailIntent(intent) {
  const lower = (intent || '').toLowerCase();
  const scores = {};

  for (const { keywords, scenario } of KEYWORD_MAP) {
    const hits = keywords.filter(k => lower.includes(k)).length;
    if (hits > 0) scores[scenario] = (scores[scenario] || 0) + hits;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;

  const [topId, topScore] = ranked[0];
  const confidence = topScore >= 2 ? 'high' : 'medium';

  // If second place is within 1 hit, it's ambiguous — return both for LLM resolution
  if (ranked.length > 1 && ranked[0][1] - ranked[1][1] <= 1) {
    return {
      scenario_id: topId,
      confidence: 'low',
      candidates: ranked.slice(0, 3).map(([id]) => id),
      needs_llm_resolution: true,
    };
  }

  return { scenario_id: topId, confidence, needs_llm_resolution: false };
}

// ---------------------------------------------------------------------------
// COMPLIANCE CHECKER
// ---------------------------------------------------------------------------

/**
 * Given a scenario, return a compliance checklist.
 * Blocks deployment if failed_requirements is non-empty.
 */
export function checkEmailCompliance(scenarioId) {
  const s = EMAIL_SCENARIOS[scenarioId];
  if (!s) throw new Error(`Unknown scenario: ${scenarioId}`);

  const requirements = [];
  const failed = [];

  if (s.requires_unsubscribe) {
    requirements.push({
      rule: 'unsubscribe_link',
      description: 'Email must include a working unsubscribe link (CAN-SPAM / GDPR)',
      required: true,
    });
  }

  if (s.requires_approval) {
    requirements.push({
      rule: 'client_approval',
      description: 'Client must approve this email type before it goes live',
      required: true,
    });
  }

  if (s.provider === 'resend_broadcast' || s.template_family === 'newsletter') {
    requirements.push({
      rule: 'subscriber_consent',
      description: 'All recipients must have opted in. Purchased lists are not permitted.',
      required: true,
    });
    requirements.push({
      rule: 'physical_address',
      description: 'CAN-SPAM requires a physical mailing address in marketing emails',
      required: true,
    });
  }

  return {
    scenario_id: scenarioId,
    requires_unsubscribe: s.requires_unsubscribe,
    requires_approval: s.requires_approval,
    risk: s.risk,
    requirements,
    failed_requirements: failed, // populated at runtime when template content is known
    compliant: failed.length === 0,
  };
}

// ---------------------------------------------------------------------------
// FULL CLASSIFICATION PIPELINE
// Call this from the /email/classify endpoint or from the LLM tool.
// ---------------------------------------------------------------------------

/**
 * Given a free-form intent string and optional business context,
 * return a full email plan: scenario, provider, compliance, next steps.
 *
 * @param {string} intent  - natural language description of what the client wants
 * @param {object} context - { business_type?, connected_resend?, has_domain? }
 * @returns {object}
 */
export function planEmailImplementation(intent, context = {}) {
  const classified = classifyEmailIntent(intent);

  if (!classified) {
    return {
      ok: false,
      classified: false,
      needs_llm_resolution: true,
      message: 'Could not classify intent from keywords alone. Use LLM to resolve.',
      intent,
    };
  }

  if (classified.needs_llm_resolution) {
    return {
      ok: false,
      classified: true,
      needs_llm_resolution: true,
      candidates: classified.candidates,
      message: 'Ambiguous intent. Candidates returned — use LLM to select.',
      intent,
    };
  }

  const scenario = EMAIL_SCENARIOS[classified.scenario_id];
  const provider = selectEmailProvider(scenario);
  const compliance = checkEmailCompliance(classified.scenario_id);

  // Capability checks against connected context
  const warnings = [];
  if (provider.requires_resend && !context.connected_resend) {
    warnings.push('Client has not connected a Resend account. Required for this scenario.');
  }
  if (provider.requires_client_domain_dns && !context.has_domain) {
    warnings.push('Client needs a verified sending domain. Domain setup required before deployment.');
  }

  return {
    ok: true,
    classified: true,
    needs_llm_resolution: false,
    confidence: classified.confidence,
    scenario,
    provider_plan: provider,
    compliance,
    warnings,
    next_steps: buildNextSteps(scenario, provider, compliance, context),
  };
}

function buildNextSteps(scenario, provider, compliance, context) {
  const steps = [];

  if (provider.requires_resend && !context.connected_resend) {
    steps.push({ action: 'connect_resend', label: 'Connect Resend account', blocking: true });
  }
  if (provider.requires_client_domain_dns && !context.has_domain) {
    steps.push({ action: 'verify_domain', label: 'Verify sending domain in Resend', blocking: true });
  }
  if (provider.requires_cloudflare_email_routing) {
    steps.push({ action: 'configure_email_routing', label: 'Configure Cloudflare Email Routing', blocking: false });
  }

  steps.push({ action: 'generate_template', label: `Generate email template for: ${scenario.label}`, blocking: false });

  if (compliance.requires_approval) {
    steps.push({ action: 'client_approval', label: 'Client reviews and approves email before activation', blocking: true });
  }

  steps.push({ action: 'deploy_rule', label: 'Deploy email trigger rule to client worker', blocking: false });

  return steps;
}

// ---------------------------------------------------------------------------
// RESEND SENDER UTILITY
// ---------------------------------------------------------------------------
// All outbound transactional sends go through this. The client's Resend API
// key is decrypted server-side before the call — never sent to the browser.
// ---------------------------------------------------------------------------

/**
 * Send a transactional email via the client's Resend account.
 *
 * @param {object} params
 * @param {string} params.resend_api_key - plaintext (decrypted server-side)
 * @param {string} params.from           - "Business Name <name@domain.com>"
 * @param {string|string[]} params.to
 * @param {string} params.subject
 * @param {string} params.html
 * @param {string} [params.reply_to]
 * @param {object} [params.tags]         - Resend tags for analytics
 * @returns {Promise<{ ok: boolean, message_id?: string, error?: string }>}
 */
export async function sendTransactionalEmail({ resend_api_key, from, to, subject, html, reply_to, tags }) {
  if (!resend_api_key) throw new Error('resend_api_key is required');
  if (!from || !to || !subject || !html) throw new Error('from, to, subject, and html are all required');

  const body = { from, to: Array.isArray(to) ? to : [to], subject, html };
  if (reply_to) body.reply_to = reply_to;
  if (tags) body.tags = tags;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resend_api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    return { ok: false, error: data.message || data.error || `Resend error ${res.status}`, status: res.status };
  }

  return { ok: true, message_id: data.id };
}

// ---------------------------------------------------------------------------
// RESEND CONNECTION VALIDATOR
// Called during /integrations/resend/connect
// ---------------------------------------------------------------------------

/**
 * Validate a Resend API key by calling /domains.
 * Returns { ok, domains, plan } or { ok: false, error }.
 */
export async function validateResendApiKey(api_key) {
  if (!api_key) return { ok: false, error: 'No API key provided' };

  const res = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${api_key}` },
  });

  if (res.status === 401) return { ok: false, error: 'Invalid Resend API key' };
  if (!res.ok) return { ok: false, error: `Resend validation error: ${res.status}` };

  const data = await res.json().catch(() => ({}));
  const domains = Array.isArray(data.data) ? data.data : [];

  return {
    ok: true,
    domains,
    verified_domains: domains.filter(d => d.status === 'verified').map(d => d.name),
    unverified_domains: domains.filter(d => d.status !== 'verified').map(d => d.name),
  };
}
