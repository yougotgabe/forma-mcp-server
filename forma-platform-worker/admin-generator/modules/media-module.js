export function buildMediaEditorModule() {
  return { id: 'media-editor', title: 'Media Library', editableFields: ['gallery','logo','social_images'], storageTarget: 'site_media', enabled: true };
}
