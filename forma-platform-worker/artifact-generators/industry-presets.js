// =============================================================================
// FORMAUT — INDUSTRY PRESETS
// =============================================================================
// Each preset defines:
//   archetype        — the design/conversion personality
//   sections         — ordered section list (what to include)
//   conversionPriority — what action we're optimizing for, in order
//   visualBias       — what the design should feel like
//   avoid            — common mistakes for this industry
// =============================================================================

export const INDUSTRY_PRESETS = Object.freeze({
  restaurant: {
    archetype: 'sensory_local_conversion',
    sections: ['hero', 'menu_preview', 'hours_location', 'social_proof', 'contact_cta'],
    conversionPriority: ['call', 'directions', 'menu', 'reservation'],
    visualBias: ['warmth', 'appetite', 'hospitality', 'local texture'],
    avoid: ['generic stock imagery', 'hidden hours', 'buried menu link'],
  },
  cafe: {
    archetype: 'daily_habit_destination',
    sections: ['hero', 'signature_items', 'hours_location', 'about', 'contact_cta'],
    conversionPriority: ['directions', 'hours', 'menu'],
    visualBias: ['cozy', 'crafted', 'morning light', 'community'],
    avoid: ['corporate tone', 'buried location info'],
  },
  bakery: {
    archetype: 'sensory_local_conversion',
    sections: ['hero', 'featured_items', 'hours_location', 'about', 'contact_cta'],
    conversionPriority: ['directions', 'hours', 'products', 'order'],
    visualBias: ['warm', 'artisan', 'handcrafted', 'delicious'],
    avoid: ['unclear hours', 'no product photos'],
  },
  contractor: {
    archetype: 'trust_first_service',
    sections: ['hero', 'services', 'trust_bar', 'process', 'social_proof', 'contact_cta'],
    conversionPriority: ['quote', 'call', 'service_area', 'proof'],
    visualBias: ['clean', 'durable', 'competent', 'before-after evidence'],
    avoid: ['vague services', 'no licensing signal', 'weak CTA'],
  },
  hvac: {
    archetype: 'urgent_trust_service',
    sections: ['hero', 'emergency_bar', 'services', 'trust_bar', 'contact_cta'],
    conversionPriority: ['call', 'emergency service', 'quote'],
    visualBias: ['clear', 'fast', 'dependable', 'local'],
    avoid: ['slow decorative hero', 'hidden phone number'],
  },
  plumbing: {
    archetype: 'urgent_trust_service',
    sections: ['hero', 'emergency_bar', 'services', 'trust_bar', 'contact_cta'],
    conversionPriority: ['call', 'emergency', 'quote', 'service_area'],
    visualBias: ['clear', 'local', 'dependable', 'available'],
    avoid: ['decorative hero', 'vague coverage area'],
  },
  electrician: {
    archetype: 'urgent_trust_service',
    sections: ['hero', 'services', 'trust_bar', 'service_area', 'contact_cta'],
    conversionPriority: ['call', 'quote', 'service_area', 'licensing'],
    visualBias: ['safe', 'professional', 'local', 'licensed'],
    avoid: ['unlicensed-looking design', 'weak trust signals'],
  },
  roofing: {
    archetype: 'proof_heavy_local_service',
    sections: ['hero', 'services', 'trust_bar', 'social_proof', 'contact_cta'],
    conversionPriority: ['inspection', 'call', 'storm repair', 'proof'],
    visualBias: ['local credibility', 'strong contrast', 'project proof'],
    avoid: ['generic house photo', 'unclear inspection offer'],
  },
  landscaping: {
    archetype: 'visual_proof_local_service',
    sections: ['hero', 'services', 'gallery', 'trust_bar', 'contact_cta'],
    conversionPriority: ['quote', 'portfolio', 'call', 'service_area'],
    visualBias: ['lush', 'transformation', 'before-after', 'seasonal'],
    avoid: ['stock lawn photos', 'vague service descriptions'],
  },
  cleaning: {
    archetype: 'trust_first_service',
    sections: ['hero', 'services', 'trust_bar', 'social_proof', 'contact_cta'],
    conversionPriority: ['quote', 'book', 'call', 'trust'],
    visualBias: ['clean', 'fresh', 'reliable', 'local'],
    avoid: ['generic cleaning imagery', 'no pricing signal'],
  },
  photographer: {
    archetype: 'portfolio_trust_booking',
    sections: ['hero', 'services', 'gallery', 'social_proof', 'contact_cta'],
    conversionPriority: ['portfolio', 'booking', 'pricing signal', 'contact'],
    visualBias: ['image-led', 'quiet UI', 'elegant spacing'],
    avoid: ['heavy visual chrome', 'tiny thumbnails', 'unclear booking path'],
  },
  videographer: {
    archetype: 'portfolio_trust_booking',
    sections: ['hero', 'services', 'gallery', 'about', 'contact_cta'],
    conversionPriority: ['reel', 'booking', 'contact'],
    visualBias: ['cinematic', 'dark', 'motion-forward'],
    avoid: ['autoplay video without controls', 'unclear pricing'],
  },
  musician: {
    archetype: 'media_first_fan_conversion',
    sections: ['hero', 'music_embeds', 'shows', 'about', 'contact_cta'],
    conversionPriority: ['listen', 'follow', 'tickets', 'contact'],
    visualBias: ['immersive', 'editorial', 'album-art led'],
    avoid: ['business-card-only site', 'music hidden below fold'],
  },
  salon: {
    archetype: 'booking_first_beauty',
    sections: ['hero', 'services', 'gallery', 'team', 'contact_cta'],
    conversionPriority: ['book', 'services', 'gallery', 'call'],
    visualBias: ['warm', 'stylish', 'inviting', 'personal'],
    avoid: ['cold corporate feel', 'no booking path'],
  },
  spa: {
    archetype: 'luxury_wellness_booking',
    sections: ['hero', 'services', 'about', 'social_proof', 'contact_cta'],
    conversionPriority: ['book', 'services', 'packages', 'gift cards'],
    visualBias: ['serene', 'premium', 'calm', 'wellness'],
    avoid: ['busy layouts', 'no pricing signal'],
  },
  barbershop: {
    archetype: 'local_style_booking',
    sections: ['hero', 'services', 'gallery', 'team', 'hours_location', 'contact_cta'],
    conversionPriority: ['book', 'call', 'hours', 'directions'],
    visualBias: ['masculine', 'neighborhood', 'craft', 'honest'],
    avoid: ['overly polished feel', 'missing barber profiles'],
  },
  tattoo: {
    archetype: 'artist_portfolio_booking',
    sections: ['hero', 'gallery', 'services', 'team', 'contact_cta'],
    conversionPriority: ['portfolio', 'book', 'artists', 'contact'],
    visualBias: ['dark', 'expressive', 'artist-forward', 'raw'],
    avoid: ['stock images', 'corporate UI', 'hidden artist work'],
  },
  law: {
    archetype: 'authority_trust_consultation',
    sections: ['hero', 'services', 'trust_bar', 'about', 'contact_cta'],
    conversionPriority: ['consultation', 'call', 'practice areas', 'credentials'],
    visualBias: ['authoritative', 'clean', 'serious', 'trustworthy'],
    avoid: ['stock gavel images', 'jargon-heavy copy', 'no consultation CTA'],
  },
  dental: {
    archetype: 'trust_comfort_appointment',
    sections: ['hero', 'services', 'trust_bar', 'team', 'contact_cta'],
    conversionPriority: ['appointment', 'call', 'services', 'new patient'],
    visualBias: ['clean', 'calming', 'professional', 'welcoming'],
    avoid: ['intimidating imagery', 'unclear new patient process'],
  },
  medical: {
    archetype: 'trust_comfort_appointment',
    sections: ['hero', 'services', 'trust_bar', 'team', 'contact_cta'],
    conversionPriority: ['appointment', 'call', 'services', 'location'],
    visualBias: ['clean', 'reassuring', 'professional', 'accessible'],
    avoid: ['cold clinical feel', 'hidden contact info'],
  },
  ecommerce: {
    archetype: 'product_discovery_conversion',
    sections: ['hero', 'featured_products', 'about', 'trust_bar', 'contact_cta'],
    conversionPriority: ['shop', 'featured products', 'trust', 'shipping'],
    visualBias: ['clear product hierarchy', 'mobile cards', 'fast scanning'],
    avoid: ['unclear product cards', 'hidden CTA', 'too much copy'],
  },
  default: {
    archetype: 'clear_local_business',
    sections: ['hero', 'services', 'about', 'trust_bar', 'contact_cta'],
    conversionPriority: ['primary CTA', 'contact', 'services', 'trust'],
    visualBias: ['clear', 'credible', 'responsive'],
    avoid: ['template sameness', 'weak section hierarchy', 'generic claims'],
  },
});
