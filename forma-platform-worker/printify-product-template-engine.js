// Formaut Printify Product Template Engine v1
// Produces loose, safe, responsive storefront blocks from normalized Printify products.
// Goal: any connected Printify catalog can become a working desktop/mobile visual implementation
// before custom brand/design generation exists.

const DEFAULT_CURRENCY = 'USD';

export function buildPrintifyProductTemplates(input = {}) {
  const products = normalizeProducts(input.products || []);
  const brand = normalizeBrand(input.brand || input.business_profile || {});
  const mode = input.mode || 'preview';
  const source = products.length ? 'catalog' : 'fallback';
  const safeProducts = products.length ? products : fallbackProducts(brand);

  const featured = chooseFeaturedProducts(safeProducts);
  const css = buildCss(brand);

  return {
    ok: true,
    provider: 'printify',
    template_version: 'printify-default-commerce-v1',
    mode,
    source,
    product_count: products.length,
    assumptions: [
      'Prices are rendered from the first enabled/default variant when available.',
      'Checkout is shown as a safe placeholder until Stripe or another payment provider is connected.',
      'Cards use Printify images when available and neutral placeholders otherwise.',
      'Templates are intentionally loose so Formaut can restyle them later from brand/design memory.'
    ],
    required_next_connections: ['stripe_for_live_checkout'],
    templates: {
      collection_grid: {
        name: 'Responsive product collection grid',
        purpose: 'Default shop/catalog section for homepage, shop page, and landing pages.',
        html: wrapSection(renderCollectionGrid(featured, brand), 'collection-grid'),
        css,
      },
      featured_product: {
        name: 'Featured product hero',
        purpose: 'Desktop/mobile hero section for one product or campaign.',
        html: wrapSection(renderFeaturedProduct(featured[0], brand), 'featured-product'),
        css,
      },
      product_detail: {
        name: 'Product detail page',
        purpose: 'Default product page with image, variants, description, and safe checkout placeholder.',
        html: wrapSection(renderProductDetail(featured[0], brand), 'product-detail'),
        css,
      },
      mini_cart_placeholder: {
        name: 'Cart/checkout placeholder',
        purpose: 'Safe visual cart shell until payments are connected.',
        html: wrapSection(renderCartPlaceholder(brand), 'cart-placeholder'),
        css,
      },
    },
    product_view_model: featured,
  };
}

export async function handlePrintifyProductTemplatePreview(body, env, deps) {
  const { json } = deps;
  const slug = body.slug || body.client_slug;
  if (!slug) return json({ error: 'slug required' }, 400);

  const client = await getClientBySlug(slug, env, deps, 'id,slug,display_name');
  if (!client) return json({ error: 'Client not found' }, 404);

  const limit = Math.min(Number(body.limit || 12), 48);
  const provider = body.provider || 'printify';
  const res = await deps.supabase(env, 'GET',
    `/rest/v1/commerce_products?client_id=eq.${client.id}&provider=eq.${encodeURIComponent(provider)}&visible=eq.true&select=id,provider,external_product_id,title,description,status,visible,tags,images,variants,synced_at&order=updated_at.desc&limit=${limit}`
  );

  const products = res.ok ? await res.json() : [];
  const brand = {
    business_name: client.display_name || client.slug || 'Your store',
    primary_cta: body.primary_cta || 'View product',
    checkout_cta: body.checkout_cta || 'Checkout setup pending',
  };

  return json(buildPrintifyProductTemplates({ products, brand, mode: body.mode || 'dashboard_preview' }));
}

async function getClientBySlug(slug, env, deps, select = 'id,slug,display_name') {
  const res = await deps.supabase(env, 'GET',
    `/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=${encodeURIComponent(select)}&limit=1`
  );
  const rows = res.ok ? await res.json() : [];
  return rows[0] || null;
}

function normalizeBrand(brand = {}) {
  return {
    business_name: brand.business_name || brand.display_name || brand.name || 'Your store',
    eyebrow: brand.eyebrow || 'Featured products',
    headline: brand.headline || 'Shop customer-ready products',
    subheadline: brand.subheadline || 'A clean, responsive product layout generated from your connected Printify catalog.',
    primary_cta: brand.primary_cta || 'View product',
    checkout_cta: brand.checkout_cta || 'Checkout setup pending',
  };
}

function normalizeProducts(products) {
  return (Array.isArray(products) ? products : [])
    .filter(Boolean)
    .map((product, index) => {
      const variants = Array.isArray(product.variants) ? product.variants : [];
      const enabled = variants.filter((v) => v && v.is_enabled !== false);
      const defaultVariant = enabled.find((v) => v.is_default) || enabled[0] || variants[0] || null;
      const images = normalizeImages(product.images);
      return {
        id: product.external_product_id || product.id || `product-${index + 1}`,
        title: product.title || 'Untitled product',
        description: cleanDescription(product.description || ''),
        tags: Array.isArray(product.tags) ? product.tags.slice(0, 6) : [],
        image: images[0] || null,
        images,
        price: normalizePrice(defaultVariant?.price),
        variant_label: defaultVariant?.title || null,
        variants: enabled.slice(0, 12).map((variant) => ({
          id: variant.id,
          title: variant.title || 'Default',
          price: normalizePrice(variant.price),
          sku: variant.sku || null,
        })),
      };
    });
}

function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .map((img) => {
      if (typeof img === 'string') return img;
      return img?.src || img?.url || img?.preview_url || img?.image_url || null;
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizePrice(price) {
  if (price === null || price === undefined || price === '') return null;
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  // Printify product prices are usually integer cents. Keep decimals if a future source sends dollars.
  const dollars = Number.isInteger(n) && Math.abs(n) >= 100 ? n / 100 : n;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: DEFAULT_CURRENCY }).format(dollars);
}

function cleanDescription(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function chooseFeaturedProducts(products) {
  return products.slice(0, Math.min(products.length, 8));
}

function fallbackProducts(brand) {
  return [
    {
      id: 'sample-tee',
      title: `${brand.business_name} Graphic Tee`,
      description: 'A sample product card used until Printify products are synced.',
      tags: ['Sample', 'Apparel'],
      image: null,
      images: [],
      price: '$24.00',
      variant_label: 'Default',
      variants: [{ id: 'sample', title: 'Default', price: '$24.00' }],
    },
    {
      id: 'sample-hoodie',
      title: `${brand.business_name} Hoodie`,
      description: 'A mobile-ready product placeholder that will be replaced by real catalog data.',
      tags: ['Sample', 'Outerwear'],
      image: null,
      images: [],
      price: '$48.00',
      variant_label: 'Default',
      variants: [{ id: 'sample', title: 'Default', price: '$48.00' }],
    },
    {
      id: 'sample-mug',
      title: `${brand.business_name} Mug`,
      description: 'A simple product example for visual layout and spacing tests.',
      tags: ['Sample', 'Home'],
      image: null,
      images: [],
      price: '$18.00',
      variant_label: 'Default',
      variants: [{ id: 'sample', title: 'Default', price: '$18.00' }],
    },
  ];
}

function wrapSection(inner, type) {
  return `<section class="fm-commerce fm-commerce--${type}" data-formaut-template="printify-default-commerce-v1">\n${inner}\n</section>`;
}

function renderCollectionGrid(products, brand) {
  return `
  <div class="fm-commerce__intro">
    <p class="fm-commerce__eyebrow">${esc(brand.eyebrow)}</p>
    <h2>${esc(brand.headline)}</h2>
    <p>${esc(brand.subheadline)}</p>
  </div>
  <div class="fm-product-grid">
    ${products.map(renderProductCard).join('\n')}
  </div>`;
}

function renderProductCard(product) {
  return `<article class="fm-product-card">
    <a class="fm-product-card__media" href="#product-${escAttr(product.id)}" aria-label="View ${escAttr(product.title)}">
      ${renderImage(product)}
    </a>
    <div class="fm-product-card__body">
      <div class="fm-product-card__topline">
        <h3>${esc(product.title)}</h3>
        <span>${esc(product.price || 'Price pending')}</span>
      </div>
      <p>${esc(product.description || 'Product details will be added from the connected Printify catalog.')}</p>
      ${renderTags(product.tags)}
      <a class="fm-commerce__button" href="#product-${escAttr(product.id)}">View product</a>
    </div>
  </article>`;
}

function renderFeaturedProduct(product, brand) {
  return `<div class="fm-featured-product" id="product-${escAttr(product.id)}">
    <div class="fm-featured-product__media">${renderImage(product)}</div>
    <div class="fm-featured-product__content">
      <p class="fm-commerce__eyebrow">Featured product</p>
      <h2>${esc(product.title)}</h2>
      <p>${esc(product.description || 'A featured product block built from your Printify catalog.')}</p>
      <div class="fm-featured-product__price">${esc(product.price || 'Price pending')}</div>
      ${renderVariantPills(product)}
      <a class="fm-commerce__button" href="#checkout-pending">${esc(brand.primary_cta)}</a>
      <p class="fm-commerce__note">Live checkout becomes available after payment integration is connected.</p>
    </div>
  </div>`;
}

function renderProductDetail(product, brand) {
  return `<div class="fm-product-detail" id="product-${escAttr(product.id)}">
    <div class="fm-product-detail__gallery">
      ${renderImage(product)}
      <div class="fm-product-detail__thumbs">
        ${(product.images.length ? product.images.slice(0, 4) : [null, null, null]).map((src, i) => `<span>${src ? `<img src="${escAttr(src)}" alt="${escAttr(product.title)} view ${i + 1}">` : ''}</span>`).join('')}
      </div>
    </div>
    <div class="fm-product-detail__info">
      <p class="fm-commerce__eyebrow">${esc(brand.business_name)}</p>
      <h1>${esc(product.title)}</h1>
      <div class="fm-featured-product__price">${esc(product.price || 'Price pending')}</div>
      <p>${esc(product.description || 'Product details will be filled from Printify.')}</p>
      ${renderVariantPills(product)}
      <button class="fm-commerce__button" type="button" data-checkout-state="pending">${esc(brand.checkout_cta)}</button>
      <p class="fm-commerce__note">This is a working visual placeholder. Connect Stripe to enable real payment collection.</p>
    </div>
  </div>`;
}

function renderCartPlaceholder(brand) {
  return `<div class="fm-cart-placeholder" id="checkout-pending">
    <div>
      <p class="fm-commerce__eyebrow">Checkout</p>
      <h2>Payment setup is the next step</h2>
      <p>${esc(brand.business_name)} products can be displayed now. Formaut still needs a payment provider before customers can complete purchases.</p>
    </div>
    <button class="fm-commerce__button" type="button" disabled>Connect payments to activate checkout</button>
  </div>`;
}

function renderImage(product) {
  if (product.image) return `<img src="${escAttr(product.image)}" alt="${escAttr(product.title)}" loading="lazy">`;
  return `<div class="fm-product-placeholder" aria-hidden="true"><span>${esc(product.title.slice(0, 1).toUpperCase())}</span></div>`;
}

function renderTags(tags = []) {
  if (!tags.length) return '';
  return `<div class="fm-product-tags">${tags.slice(0, 4).map((tag) => `<span>${esc(tag)}</span>`).join('')}</div>`;
}

function renderVariantPills(product) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  if (!variants.length) return '';
  return `<div class="fm-variant-pills" aria-label="Available variants">${variants.slice(0, 6).map((variant) => `<span>${esc(variant.title)}${variant.price ? ` · ${esc(variant.price)}` : ''}</span>`).join('')}</div>`;
}

function buildCss() {
  return `.fm-commerce{width:100%;padding:clamp(2rem,5vw,5rem) 1rem;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827;background:#fff}.fm-commerce *{box-sizing:border-box}.fm-commerce__intro{max-width:760px;margin:0 auto 2rem;text-align:center}.fm-commerce__eyebrow{margin:0 0 .5rem;text-transform:uppercase;letter-spacing:.12em;font-size:.75rem;font-weight:800;color:#6b7280}.fm-commerce h1,.fm-commerce h2,.fm-commerce h3{margin:0;color:#111827;line-height:1.05}.fm-commerce h1{font-size:clamp(2rem,5vw,4rem)}.fm-commerce h2{font-size:clamp(1.8rem,4vw,3rem)}.fm-commerce h3{font-size:1rem}.fm-commerce p{color:#4b5563;line-height:1.6}.fm-product-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1.25rem;max-width:1180px;margin:0 auto}.fm-product-card{border:1px solid #e5e7eb;border-radius:24px;overflow:hidden;background:#fff;box-shadow:0 18px 45px rgba(15,23,42,.08)}.fm-product-card__media{display:block;aspect-ratio:1/1;background:#f3f4f6;overflow:hidden}.fm-product-card img,.fm-featured-product img,.fm-product-detail img{width:100%;height:100%;object-fit:cover;display:block}.fm-product-card__body{padding:1rem}.fm-product-card__topline{display:flex;gap:1rem;align-items:flex-start;justify-content:space-between}.fm-product-card__topline span,.fm-featured-product__price{font-weight:800;color:#111827}.fm-product-tags,.fm-variant-pills{display:flex;flex-wrap:wrap;gap:.5rem;margin:.9rem 0}.fm-product-tags span,.fm-variant-pills span{border:1px solid #e5e7eb;border-radius:999px;padding:.35rem .65rem;font-size:.8rem;color:#374151;background:#f9fafb}.fm-commerce__button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;border:0;border-radius:999px;background:#111827;color:#fff;text-decoration:none;font-weight:800;padding:.75rem 1.05rem;cursor:pointer}.fm-commerce__button:disabled{opacity:.6;cursor:not-allowed}.fm-commerce__note{font-size:.9rem;color:#6b7280}.fm-product-placeholder{width:100%;height:100%;min-height:220px;display:grid;place-items:center;background:linear-gradient(135deg,#f3f4f6,#e5e7eb)}.fm-product-placeholder span{width:72px;height:72px;border-radius:24px;display:grid;place-items:center;background:#fff;font-size:2rem;font-weight:900;color:#111827;box-shadow:0 12px 30px rgba(15,23,42,.1)}.fm-featured-product,.fm-product-detail{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:1fr 1fr;gap:clamp(1.5rem,4vw,4rem);align-items:center}.fm-featured-product__media,.fm-product-detail__gallery>img,.fm-product-detail__gallery>.fm-product-placeholder{border-radius:28px;overflow:hidden;aspect-ratio:1/1;background:#f3f4f6}.fm-product-detail__thumbs{display:grid;grid-template-columns:repeat(4,1fr);gap:.75rem;margin-top:.75rem}.fm-product-detail__thumbs span{display:block;aspect-ratio:1/1;border-radius:16px;background:#f3f4f6;overflow:hidden;border:1px solid #e5e7eb}.fm-cart-placeholder{max-width:980px;margin:0 auto;border:1px solid #e5e7eb;border-radius:28px;padding:clamp(1.25rem,4vw,2.5rem);display:flex;align-items:center;justify-content:space-between;gap:1.5rem;background:#f9fafb}@media (max-width:900px){.fm-product-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.fm-featured-product,.fm-product-detail{grid-template-columns:1fr}.fm-cart-placeholder{align-items:flex-start;flex-direction:column}}@media (max-width:640px){.fm-commerce{padding:2rem .85rem}.fm-product-grid{grid-template-columns:1fr;gap:1rem}.fm-product-card{border-radius:20px}.fm-product-card__body{padding:.95rem}.fm-product-card__topline{align-items:flex-start}.fm-commerce__button{width:100%}.fm-product-detail__thumbs{grid-template-columns:repeat(3,1fr)}.fm-featured-product__media,.fm-product-detail__gallery>img,.fm-product-detail__gallery>.fm-product-placeholder{border-radius:22px}}`;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(value) { return esc(value); }
