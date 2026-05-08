/**
 * Formaut Scope Guard / Conversation Steering Layer
 *
 * Purpose:
 * - Keep Formaut focused on business intake, website planning, brand/content direction,
 *   integrations, deployment, and platform support.
 * - Avoid spending Anthropic tokens on conversations that can be deterministically redirected.
 * - Prevent out-of-scope personal details from polluting business memory.
 * - Provide safe handling for crisis/self-harm language without acting as a therapist.
 *
 * Placement:
 *   inbound message -> cost gate -> scope guard -> safety gate -> normal chat/model route
 *
 * This module has no external dependencies and is Cloudflare Worker compatible.
 */

const DEFAULT_SCOPE_CONFIG = {
  productName: 'Formaut',
  allowedDomains: [
    'business intake',
    'business profile',
    'website planning',
    'website copy',
    'brand voice',
    'visual direction',
    'services',
    'contact information',
    'integrations',
    'deployment',
    'dashboard support',
    'client onboarding',
    'website revisions',
    'SEO basics',
    'local business presence'
  ],
  shouldLogOutOfScope: true,
  shouldStoreOutOfScopeAsBusinessMemory: false,
  requireModelForAmbiguousAdjacent: false
};

const CATEGORY = Object.freeze({
  IN_SCOPE: 'in_scope',
  ADJACENT: 'adjacent',
  OUT_OF_SCOPE: 'out_of_scope',
  HIGH_RISK: 'high_risk',
  CRISIS: 'crisis',
  UNKNOWN: 'unknown'
});

const ACTION = Object.freeze({
  CONTINUE: 'continue',
  REDIRECT: 'redirect',
  BRIDGE_BACK: 'bridge_back',
  SAFETY_RESPONSE: 'safety_response',
  ASK_CLARIFYING_SCOPE: 'ask_clarifying_scope'
});

const IN_SCOPE_PATTERNS = [
  /\b(website|site|homepage|landing page|web page|page section|hero section)\b/i,
  /\b(business|company|brand|service|services|offer|offers|customer|client|audience)\b/i,
  /\b(copy|headline|tagline|tone|voice|style|colors?|logo|visual|design)\b/i,
  /\b(contact|phone|email|address|hours|location|booking|appointment)\b/i,
  /\b(integrat(e|ion|ions)|stripe|square|calendar|google|facebook|instagram|crm)\b/i,
  /\b(deploy|deployment|domain|dns|hosting|cloudflare|supabase|worker|wrangler)\b/i,
  /\b(edit|change|update|revise|undo|approve|reject|publish)\b/i,
  /\b(seo|search engine|google business|local search|metadata)\b/i
];

const ADJACENT_PATTERNS = [
  /\b(i feel|i'm feeling|im feeling|overwhelmed|stressed|anxious|burned out|burnt out)\b/i,
  /\b(my story|about me|personal story|why i started|origin story)\b/i,
  /\b(values|mission|vision|purpose|message|positioning)\b/i,
  /\b(customers? feel|clients? feel|communicate|trust|confidence)\b/i
];

const THERAPY_PATTERNS = [
  /\b(therapist|therapy|counseling|counsellor|mental health|depression|trauma|panic attack)\b/i,
  /\b(my relationship|my marriage|my boyfriend|my girlfriend|my spouse|family problems)\b/i,
  /\b(i need advice about my life|life advice|personal advice)\b/i,
  /\b(why do i feel|what's wrong with me|what is wrong with me)\b/i
];

const MEDICAL_PATTERNS = [
  /\b(diagnose|diagnosis|symptoms?|medication|prescription|doctor|medical|illness|disease|treatment)\b/i
];

const LEGAL_PATTERNS = [
  /\b(lawsuit|sue|lawyer|attorney|legal advice|contract dispute|criminal|custody|divorce)\b/i
];

const FINANCIAL_PATTERNS = [
  /\b(stock|crypto|investment advice|should i invest|tax advice|retirement|loan|mortgage|debt strategy)\b/i
];

const GENERAL_RANDOM_PATTERNS = [
  /\b(homework|essay for school|solve my math|history assignment|dating advice|politics|news debate)\b/i,
  /\b(write me a poem|tell me a joke|roleplay|game with me)\b/i
];

const CRISIS_PATTERNS = [
  /\b(kill myself|suicide|suicidal|end my life|hurt myself|self harm|self-harm)\b/i,
  /\b(i don't want to live|i dont want to live|can't go on|cant go on)\b/i,
  /\b(hurt someone|kill someone|harm someone)\b/i
];

function normalizeMessage(message) {
  return String(message || '').trim().replace(/\s+/g, ' ');
}

function countMatches(text, patterns) {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function detectScope(message, context = {}, config = DEFAULT_SCOPE_CONFIG) {
  const text = normalizeMessage(message);
  const lower = text.toLowerCase();

  if (!text) {
    return {
      category: CATEGORY.IN_SCOPE,
      action: ACTION.CONTINUE,
      reason: 'empty_message_handled_by_cost_gate',
      confidence: 0.95,
      allowModelCall: false,
      storeAsBusinessMemory: false
    };
  }

  const crisisScore = countMatches(lower, CRISIS_PATTERNS);
  if (crisisScore > 0) {
    return {
      category: CATEGORY.CRISIS,
      action: ACTION.SAFETY_RESPONSE,
      reason: 'crisis_or_self_harm_language_detected',
      confidence: 0.95,
      allowModelCall: false,
      storeAsBusinessMemory: false
    };
  }

  const inScopeScore = countMatches(lower, IN_SCOPE_PATTERNS);
  const adjacentScore = countMatches(lower, ADJACENT_PATTERNS);
  const therapyScore = countMatches(lower, THERAPY_PATTERNS);
  const medicalScore = countMatches(lower, MEDICAL_PATTERNS);
  const legalScore = countMatches(lower, LEGAL_PATTERNS);
  const financialScore = countMatches(lower, FINANCIAL_PATTERNS);
  const randomScore = countMatches(lower, GENERAL_RANDOM_PATTERNS);

  const highRiskScore = medicalScore + legalScore + financialScore;
  const outOfScopeScore = therapyScore + randomScore;

  if (inScopeScore > 0 && highRiskScore === 0 && therapyScore === 0) {
    return {
      category: CATEGORY.IN_SCOPE,
      action: ACTION.CONTINUE,
      reason: 'business_or_website_scope_detected',
      confidence: Math.min(0.9, 0.55 + inScopeScore * 0.15),
      allowModelCall: true,
      storeAsBusinessMemory: true
    };
  }

  if (adjacentScore > 0 && outOfScopeScore === 0 && highRiskScore === 0) {
    return {
      category: CATEGORY.ADJACENT,
      action: ACTION.BRIDGE_BACK,
      reason: 'personal_or_story_context_that_can_be_reframed_for_brand',
      confidence: 0.75,
      allowModelCall: config.requireModelForAmbiguousAdjacent,
      storeAsBusinessMemory: false,
      mayStoreIfUserConfirmsBusinessRelevance: true
    };
  }

  if (highRiskScore > 0) {
    return {
      category: CATEGORY.HIGH_RISK,
      action: ACTION.REDIRECT,
      reason: medicalScore ? 'medical_advice_detected' : legalScore ? 'legal_advice_detected' : 'financial_advice_detected',
      confidence: 0.85,
      allowModelCall: false,
      storeAsBusinessMemory: false
    };
  }

  if (outOfScopeScore > 0) {
    return {
      category: CATEGORY.OUT_OF_SCOPE,
      action: ACTION.REDIRECT,
      reason: therapyScore ? 'therapy_or_personal_counseling_detected' : 'general_out_of_scope_detected',
      confidence: 0.82,
      allowModelCall: false,
      storeAsBusinessMemory: false
    };
  }

  return {
    category: CATEGORY.UNKNOWN,
    action: ACTION.ASK_CLARIFYING_SCOPE,
    reason: 'scope_unclear',
    confidence: 0.45,
    allowModelCall: false,
    storeAsBusinessMemory: false
  };
}

function buildScopeResponse(scopeDecision, message, context = {}, config = DEFAULT_SCOPE_CONFIG) {
  const productName = config.productName || 'Formaut';

  if (scopeDecision.category === CATEGORY.CRISIS) {
    return [
      "I'm really sorry you're dealing with that. I'm not equipped to provide crisis counseling, but your safety matters.",
      "If you might hurt yourself or someone else, call emergency services now. In the U.S. or Canada, call or text 988 for immediate crisis support.",
      `I can stay focused on ${productName} tasks like business profile setup, website planning, brand messaging, or dashboard support when you're ready.`
    ].join('\n\n');
  }

  if (scopeDecision.category === CATEGORY.HIGH_RISK) {
    return [
      `I'm built for ${productName} work: business profiles, websites, brand direction, integrations, deployment, and dashboard support.`,
      "I can't give medical, legal, or financial advice. For that, it's best to talk to a qualified professional.",
      "If this connects to your business website, I can help turn it into safe, general site copy or a clear customer-facing explanation."
    ].join('\n\n');
  }

  if (scopeDecision.category === CATEGORY.OUT_OF_SCOPE) {
    return [
      `I'm here to help with ${productName}: business intake, website structure, brand voice, services, content, integrations, deployment, and revisions.`,
      "I'm not designed to be a therapist or general personal-advice chatbot.",
      "If what you're sharing affects how your business should sound to customers, I can help translate that into brand voice, About-page copy, or customer messaging."
    ].join('\n\n');
  }

  if (scopeDecision.category === CATEGORY.ADJACENT) {
    return [
      "That may matter for how your business communicates, but I don't want to treat personal context like a therapy conversation.",
      "Do you want to use this as brand/customer-facing material, such as tone, About-page messaging, mission, values, or positioning?"
    ].join('\n\n');
  }

  if (scopeDecision.category === CATEGORY.UNKNOWN) {
    return [
      `I can help with ${productName} tasks like building a business profile, planning a website, shaping brand voice, extracting details from an existing URL, or making revisions.`,
      "Tell me what business or website task you want to work on."
    ].join('\n\n');
  }

  return null;
}

async function maybeLogScopeDecision({ supabase, sessionId, userId, message, scopeDecision, responseText }) {
  if (!supabase || typeof supabase.from !== 'function') return;

  try {
    await supabase.from('chat_scope_events').insert({
      session_id: sessionId || null,
      user_id: userId || null,
      message_excerpt: normalizeMessage(message).slice(0, 500),
      category: scopeDecision.category,
      action: scopeDecision.action,
      reason: scopeDecision.reason,
      confidence: scopeDecision.confidence,
      allow_model_call: scopeDecision.allowModelCall,
      store_as_business_memory: scopeDecision.storeAsBusinessMemory,
      response_excerpt: responseText ? String(responseText).slice(0, 500) : null
    });
  } catch (error) {
    console.warn('scope_guard_log_failed', error);
  }
}

async function guardScope({ message, context = {}, config = DEFAULT_SCOPE_CONFIG, supabase = null }) {
  const scopeDecision = detectScope(message, context, config);
  const responseText = buildScopeResponse(scopeDecision, message, context, config);

  await maybeLogScopeDecision({
    supabase,
    sessionId: context.sessionId,
    userId: context.userId,
    message,
    scopeDecision,
    responseText
  });

  return {
    shouldContinue: scopeDecision.action === ACTION.CONTINUE,
    shouldCallModel: scopeDecision.allowModelCall,
    responseText,
    scopeDecision,
    memoryPolicy: {
      storeAsBusinessMemory: scopeDecision.storeAsBusinessMemory,
      storeAsConversationOnly: !scopeDecision.storeAsBusinessMemory,
      mayStoreIfUserConfirmsBusinessRelevance: !!scopeDecision.mayStoreIfUserConfirmsBusinessRelevance
    }
  };
}

export {
  DEFAULT_SCOPE_CONFIG,
  CATEGORY,
  ACTION,
  detectScope,
  buildScopeResponse,
  guardScope
};
