export function buildProductsEditorModule({ commerce_provider } = {}) {
  return { id: 'products-editor', title: 'Products', editableFields: ['featured_products','collections','product_visibility'], storageTarget: 'commerce.products', enabled: Boolean(commerce_provider), provider: commerce_provider || null };
}
