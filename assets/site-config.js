/* Public deployment configuration shared by every static page. */
(function () {
  'use strict';

  // GitHub Pages serves this project below /englishmates_2_8_videos_unique_registration/.
  // Resolve every local link from the current directory instead of the domain root.
  const pageBase = new URL('../', document.currentScript.src);

  // GitHub Pages is static. The existing Netlify deployment remains the protected
  // API service for registrations, tutor approvals, availability and Google Meet.
  // Netlify deploy previews (for example deploy-preview-21--englishmates-ratangarh.netlify.app)
  // call their OWN functions, so new backend code can be tested before it reaches production.
  // Every other host keeps using the production API exactly as before.
  const isDeployPreview = /^deploy-preview-\d+--englishmates-ratangarh\.netlify\.app$/.test(window.location.hostname);
  const apiBase = isDeployPreview
    ? `${window.location.origin}/.netlify/functions`
    : 'https://englishmates-ratangarh.netlify.app/.netlify/functions';

  window.Englishmates = Object.freeze({
    pageBase: pageBase.href,
    apiBase,
    api(name) {
      return `${apiBase}/${String(name).replace(/^\/+/, '')}`;
    },
    page(path) {
      return new URL(String(path).replace(/^\/+/, ''), pageBase).href;
    }
  });
}());
