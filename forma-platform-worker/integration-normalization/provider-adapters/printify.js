import { createCanonicalEntity } from '../../../shared/canonical-entities/schema.js';

export function normalizePrintifyProduct(product = {}) {
  const variants = product.variants || [];
  const visibleVariants = variants.filter((v) => v.is_enabled !== false);
  const minPrice = visibleVariants.reduce((min, v) => {
    const price = Number(v.price || v.price_cents || 0);
    return price && (!min || price < min) ? price : min;
  }, 0);
  return createCanonicalEntity({
    entity_type: 'product',
    source: 'printify',
    source_id: product.id,
    title: product.title,
    status: product.visible === false ? 'hidden' : (product.status || 'active'),
    confidence: 0.96,
    canonical: {
      description: product.description || '',
      price_cents: minPrice || null,
      images: product.images || [],
      variants: visibleVariants,
      tags: product.tags || [],
    },
    raw: product,
  });
}
