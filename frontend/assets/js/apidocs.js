/* Tool Table — API documentation (Swagger UI, bundled under /assets/vendor/swagger-ui).
   "Try it out" calls this server as the signed-in user (session cookie); writes need the
   X-Tool-Table header, which is added here so they work from this page. */
window.addEventListener('DOMContentLoaded', () => {
  if (typeof SwaggerUIBundle === 'undefined') {
    document.getElementById('swagger-ui').textContent = _t('Swagger UI 載入失敗，請重新整理。');
    return;
  }
  window.ui = SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    docExpansion: 'none',
    filter: true,                       // search box for operations
    displayRequestDuration: true,
    tryItOutEnabled: false,
    persistAuthorization: false,
    defaultModelsExpandDepth: 0,
    syntaxHighlight: { activate: true, theme: 'agate' },
    requestInterceptor: req => {
      req.headers = req.headers || {};
      req.headers['X-Tool-Table'] = '1';
      req.headers['X-Lang'] = window.TT_LANG || 'zh-TW';
      req.credentials = 'same-origin';
      return req;
    },
    onComplete: () => {
      const f = document.querySelector('.operation-filter-input');
      if (f) f.placeholder = _t('搜尋 API（路徑、群組）');
    },
  });
});
