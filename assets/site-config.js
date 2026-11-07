/* Public deployment configuration shared by every static page. */
(function () {
  'use strict';

  // GitHub Pages serves this project below /englishmates_2_8_videos_unique_registration/.
  // Resolve every local link from the current directory instead of the domain root.
  const pageBase = new URL('../', document.currentScript.src);

  // GitHub Pages is static. The existing Netlify deployment remains the protected
  // API service for registrations, tutor approvals, availability and Google Meet.
  const apiBase = 'https://englishmates-ratangarh.netlify.app/.netlify/functions';

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
