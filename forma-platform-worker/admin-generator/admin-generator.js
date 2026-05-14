import { buildHeroEditorModule } from './modules/hero-module.js';
import { buildServicesEditorModule } from './modules/services-module.js';
import { buildSeoEditorModule } from './modules/seo-module.js';
import { buildMediaEditorModule } from './modules/media-module.js';
import { buildProductsEditorModule } from './modules/products-module.js';

export function buildAdminPanelManifest(input = {}) {
  const modules = [
    buildHeroEditorModule({ config: input }),
    buildServicesEditorModule(input),
    buildSeoEditorModule(input),
    buildMediaEditorModule(input),
    buildProductsEditorModule(input)
  ].filter(m => m.enabled);
  return { outputPath: '/admin', site_type: input.site_type || 'business', modules };
}
