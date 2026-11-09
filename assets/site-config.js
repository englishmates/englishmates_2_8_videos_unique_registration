/* Public deployment configuration shared by every static page. */
(function () {
  'use strict';

  // GitHub Pages serves this project below /englishmates_2_8_videos_unique_registration/.
  // Resolve every local link from the current directory instead of the domain root.
  const pageBase = new URL('../', document.currentScript.src);

  // When the site itself is served by Netlify, call this deployment's own functions
  // (same origin). GitHub Pages is static, so it uses the active Netlify deployment
  // as the protected API service for registrations, approvals, availability and Meet.
  const NETLIFY_API_ORIGIN = 'https://englishmatesratangarh.netlify.app';
  const isGitHubPages = window.location.hostname === 'englishmates.github.io';
  const apiBase = (isGitHubPages ? NETLIFY_API_ORIGIN : window.location.origin) + '/.netlify/functions';

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
